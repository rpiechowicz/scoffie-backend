import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import {
  CONSENT_KINDS,
  ConsentAction,
  ConsentKind,
  LEGAL_DOCUMENT_VERSIONS,
  MINIMUM_CONSENT_VERSIONS,
  isVersionCurrent,
  isVersionKnown,
} from '../common/legal-documents';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { RecordConsentDto } from './dto/record-consent.dto';

export type ConsentStatus = {
  kind: ConsentKind;
  /** Ostatnie zdarzenie to GRANTED i wersja nie starsza niż minimalna. */
  granted: boolean;
  /** Wersja z ostatniego zdarzenia (null = nigdy nie klikał). */
  documentVersion: string | null;
  at: string | null;
  /** Co klient ma dziś pokazać i wysłać. */
  currentVersion: string;
  /** Poniżej tej wersji zgoda jest nieważna i trzeba kliknąć od nowa. */
  minimumVersion: string;
};

/**
 * Zgody jako dziennik zdarzeń. Stan liczy się PRZY ODCZYCIE z ostatniego
 * wpisu per rodzaj — nic nie jest nadpisywane, żeby dało się odtworzyć,
 * kto, kiedy i na jaką wersję dokumentu się zgodził (art. 7 ust. 1 RODO).
 */
@Injectable()
export class ConsentsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    userId: string,
    input: RecordConsentDto,
  ): Promise<ConsentStatus[]> {
    const dto = await validateDto(RecordConsentDto, input);
    if (!isVersionKnown(dto.kind as ConsentKind, dto.documentVersion)) {
      throw new AppException(
        'VALIDATION_ERROR',
        `Nie ma jeszcze wersji dokumentu ${dto.documentVersion} — bieżąca to ${LEGAL_DOCUMENT_VERSIONS[dto.kind as ConsentKind]}.`,
        HttpStatus.BAD_REQUEST,
        ['documentVersion'],
      );
    }
    await this.prisma.consentEvent.create({
      data: {
        userId,
        kind: dto.kind,
        action: dto.action,
        documentVersion: dto.documentVersion,
        source: dto.source ?? null,
        appVersion: dto.appVersion ?? null,
        householdId: dto.householdId ?? null,
      },
    });
    return this.status(userId);
  }

  /**
   * Zdarzenie zapisywane przez SERWER, nie przez kliknięcie: podanie hasła
   * Cookidoo, pierwsze alergeny, pierwsza synchronizacja kroków. Dowód
   * zgody wynika z czynności, a nie z osobnego ekranu — ale dziennik ma go
   * mieć (art. 7 ust. 1). Nigdy nie rzuca: brak wpisu w dzienniku nie może
   * zatrzymać zapisu, na który użytkownik właśnie się zdecydował.
   */
  async recordSystem(
    userId: string,
    kind: ConsentKind,
    action: ConsentAction,
    source: string,
    householdId?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.consentEvent.create({
        data: {
          userId,
          kind,
          action,
          documentVersion: LEGAL_DOCUMENT_VERSIONS[kind],
          source,
          householdId: householdId ?? null,
        },
      });
    } catch {
      // Świadomie cicho — patrz opis wyżej.
    }
  }

  /** Czy dziennik ma już ważną zgodę; do „zapisz tylko raz". */
  async status(userId: string): Promise<ConsentStatus[]> {
    const latest = await this.latestByKind([userId]);
    return CONSENT_KINDS.map((kind) => {
      const event = latest.get(userId)?.get(kind);
      return {
        kind,
        granted: event ? this.isGranted(kind, event) : false,
        documentVersion: event?.documentVersion ?? null,
        at: event?.createdAt.toISOString() ?? null,
        currentVersion: LEGAL_DOCUMENT_VERSIONS[kind],
        minimumVersion: MINIMUM_CONSENT_VERSIONS[kind],
      };
    });
  }

  async hasValid(userId: string, kind: ConsentKind): Promise<boolean> {
    const valid = await this.usersWithValid([userId], kind);
    return valid.has(userId);
  }

  /**
   * Którzy z podanych użytkowników mają ważną zgodę danego rodzaju — jednym
   * zapytaniem, bo prompt asystenta pyta o cały dom naraz.
   */
  async usersWithValid(
    userIds: readonly string[],
    kind: ConsentKind,
  ): Promise<Set<string>> {
    const unique = Array.from(new Set(userIds)).filter(Boolean);
    if (unique.length === 0) return new Set();
    const latest = await this.latestByKind(unique, kind);
    const valid = new Set<string>();
    for (const userId of unique) {
      const event = latest.get(userId)?.get(kind);
      if (event && this.isGranted(kind, event)) valid.add(userId);
    }
    return valid;
  }

  private isGranted(
    kind: ConsentKind,
    event: { action: string; documentVersion: string },
  ): boolean {
    return (
      (event.action as ConsentAction) === 'GRANTED' &&
      isVersionCurrent(kind, event.documentVersion)
    );
  }

  /**
   * Ostatnie zdarzenie per (użytkownik, rodzaj). Wiersze idą posortowane
   * malejąco, więc pierwszy napotkany dla pary jest tym właściwym; przy tej
   * skali (kilka zdarzeń na konto) to tańsze i czytelniejsze niż DISTINCT ON.
   */
  private async latestByKind(
    userIds: readonly string[],
    kind?: ConsentKind,
  ): Promise<
    Map<
      string,
      Map<
        ConsentKind,
        { action: string; documentVersion: string; createdAt: Date }
      >
    >
  > {
    const rows = await this.prisma.consentEvent.findMany({
      where: { userId: { in: [...userIds] }, ...(kind ? { kind } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        userId: true,
        kind: true,
        action: true,
        documentVersion: true,
        createdAt: true,
      },
    });
    const result = new Map<
      string,
      Map<
        ConsentKind,
        { action: string; documentVersion: string; createdAt: Date }
      >
    >();
    for (const row of rows) {
      let perUser = result.get(row.userId);
      if (!perUser) {
        perUser = new Map<
          ConsentKind,
          { action: string; documentVersion: string; createdAt: Date }
        >();
        result.set(row.userId, perUser);
      }
      if (!perUser.has(row.kind as ConsentKind)) {
        perUser.set(row.kind as ConsentKind, row);
      }
    }
    return result;
  }
}
