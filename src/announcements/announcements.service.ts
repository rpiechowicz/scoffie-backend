import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { currentHouseholdId } from '../households/current-household.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  ANNOUNCEMENT_MAX_ACTIVE,
  announcementMatches,
  compareAnnouncements,
  type AnnouncementAudienceValue,
  type AnnouncementSeverityValue,
  type ClientPlatform,
} from './announcements.rules';

/** Druga instancja dochodzi do zmian z panelu najpóźniej po tylu ms. */
export const ANNOUNCEMENTS_REFRESH_MS = 30_000;

/** Jeden baner w aplikacji (`GET /me/announcements`). */
export type MeAnnouncement = {
  id: string;
  /** ≤ 80 znaków, czysty tekst, jedna linia */
  title: string;
  /** ≤ 400 znaków, czysty tekst, może mieć `\n` */
  body: string;
  severity: AnnouncementSeverityValue;
  /** `true` — osoba może zamknąć baner (klient pamięta `id` lokalnie) */
  dismissible: boolean;
  startsAt: string;
  /** `null` = do odwołania */
  endsAt: string | null;
};

/** `GET /me/announcements` */
export type MeAnnouncementsResponse = {
  /** aktywne teraz dla tej osoby i platformy, krytyczne pierwsze, najwyżej 3 */
  announcements: MeAnnouncement[];
};

type CachedRow = {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverityValue;
  audience: AnnouncementAudienceValue;
  householdIds: string[];
  startsAt: Date;
  endsAt: Date | null;
  dismissible: boolean;
};

/**
 * Komunikaty w aplikacji. Niezakończone wiersze (aktywne i zaplanowane —
 * garstka) siedzą w pamięci jak flagi: odświeżanie co 30 s i od razu po
 * zapisie z panelu, filtr per osoba w pamięci. Awaria bazy = ostatni znany
 * stan. Odpowiedź nie zawiera `audience` ani `householdIds` — osoba nie
 * dowiaduje się niczego o innych domach.
 */
@Injectable()
export class AnnouncementsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnnouncementsService.name);
  private timer: NodeJS.Timeout | null = null;
  private rows: CachedRow[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      ANNOUNCEMENTS_REFRESH_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(now: Date = new Date()): Promise<void> {
    try {
      this.rows = await this.prisma.appAnnouncement.findMany({
        where: { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        select: {
          id: true,
          title: true,
          body: true,
          severity: true,
          audience: true,
          householdIds: true,
          startsAt: true,
          endsAt: true,
          dismissible: true,
        },
      });
    } catch (error) {
      this.logger.warn(
        `nie udało się odświeżyć komunikatów (zostają poprzednie): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  activeFor(
    viewer: { householdId: string | null; platform: ClientPlatform | null },
    now: Date = new Date(),
  ): MeAnnouncement[] {
    return this.rows
      .filter((row) => announcementMatches(row, viewer, now))
      .sort(compareAnnouncements)
      .slice(0, ANNOUNCEMENT_MAX_ACTIVE)
      .map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        severity: row.severity,
        dismissible: row.dismissible,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt?.toISOString() ?? null,
      }));
  }

  async forUser(
    userId: string,
    platform: ClientPlatform | null,
  ): Promise<MeAnnouncementsResponse> {
    const householdId = await currentHouseholdId(this.prisma, userId);
    return { announcements: this.activeFor({ householdId, platform }) };
  }
}
