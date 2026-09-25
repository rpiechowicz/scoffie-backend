import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminAccessContext } from '../admin-request';
import { AdminAuthException } from './admin-auth.errors';
import type { AdminAuthMethod } from './admin-sessions.service';

/** 5 nieudanych prób w 15 minut — per adres z bramki i per IP (ROADMAPA §4). */
export const ADMIN_LOCK_MAX_FAILURES = 5;
export const ADMIN_LOCK_WINDOW_MS = 15 * 60_000;

export type AttemptKind = 'LOGIN' | 'STEP_UP';

/** Klient bazy albo transakcja — licznik czyta się też pod zamkiem. */
type Db = Pick<PrismaService, 'adminLoginAttempt'> | Prisma.TransactionClient;

/** Przestrzenie kluczy zamka doradczego (`pg_advisory_xact_lock(int, int)`). */
const LOCK_NS_EMAIL = 0x61646d31; // 'adm1'
const LOCK_NS_IP = 0x61646d32; // 'adm2'

/**
 * Blokada logowania i step-upu.
 *
 * Liczy się z `AdminLoginAttempt`, nie z pamięci procesu: deploy w trakcie
 * zgadywania nie może zerować licznika. Udane wejście z danego adresu
 * zeruje JEGO licznik (liczą się porażki po ostatnim sukcesie), więc admin,
 * który raz się pomylił, nie wlecze tego przez kwadrans.
 *
 * Step-up liczy się razem z logowaniem: ukradzione ciasteczko sesji nie może
 * służyć do zgadywania kodu TOTP przez `POST /admin/auth/step-up`.
 *
 * SPRAWDŹ-I-ZAREZERWUJ ATOMOWO (audyt logowania 25.09.2026). Dawniej licznik
 * czytał porażki, a porażka zapisywała się dopiero po weryfikacji — 200
 * równoległych step-upów dawało 28 prób zamiast 5. Teraz każda próba, ZANIM
 * cokolwiek zweryfikuje, rezerwuje miejsce (`reserve`): w krótkiej transakcji
 * pod zamkiem doradczym adresu i IP liczy porażki RAZEM z próbami w toku
 * (`PENDING`) i dopiero wtedy wstawia swój wiersz `PENDING`. Szósta równoległa
 * próba widzi pięć rezerwacji i dostaje `LOCKED`. Weryfikacja (TOTP, WebAuthn)
 * biegnie już POZA zamkiem, a wynik domyka rezerwację (`settle`). Proces,
 * który padnie w połowie, zostawia `PENDING` — liczone jak porażka, dopóki
 * nie wypadnie z okna.
 *
 * Żądanie odrzucone blokadą zostaje zapisane (`LOCKED`), ale nie przedłuża
 * blokady — ta kończy się kwadrans po piątej porażce, jak obiecuje
 * `lockedUntil`.
 */
@Injectable()
export class AdminLockoutService {
  constructor(private readonly prisma: PrismaService) {}

  async lockedUntil(
    access: Pick<AdminAccessContext, 'email' | 'ip'>,
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<Date | null> {
    const keys: Prisma.AdminLoginAttemptWhereInput[] = [
      { email: access.email },
    ];
    if (access.ip) keys.push({ ip: access.ip });
    let until: Date | null = null;
    for (const key of keys) {
      const candidate = await this.lockedUntilFor(db, key, now);
      if (candidate && (!until || candidate > until)) until = candidate;
    }
    return until;
  }

  private async lockedUntilFor(
    db: Db,
    key: Prisma.AdminLoginAttemptWhereInput,
    now: Date,
  ): Promise<Date | null> {
    const windowStart = new Date(now.getTime() - ADMIN_LOCK_WINDOW_MS);
    const lastSuccess = await db.adminLoginAttempt.findFirst({
      where: { ...key, result: 'SUCCESS', createdAt: { gt: windowStart } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const since = lastSuccess?.createdAt ?? windowStart;
    // Próba w toku (`PENDING`) liczy się jak porażka — inaczej seria
    // równoległych żądań przechodzi, zanim pierwsze zdąży się zapisać.
    const failures = await db.adminLoginAttempt.findMany({
      where: {
        ...key,
        result: { in: ['FAILED', 'PENDING'] },
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'desc' },
      take: ADMIN_LOCK_MAX_FAILURES,
      select: { createdAt: true },
    });
    if (failures.length < ADMIN_LOCK_MAX_FAILURES) return null;
    // Blokada trwa, dopóki piąta od końca porażka nie wypadnie z okna.
    const fifth = failures[ADMIN_LOCK_MAX_FAILURES - 1];
    const until = new Date(fifth.createdAt.getTime() + ADMIN_LOCK_WINDOW_MS);
    return until > now ? until : null;
  }

  /**
   * Samo sprawdzenie (`…/options`, które niczego nie weryfikuje): rzuca
   * 429 `LOCKED` (z `lockedUntil`) i odnotowuje odrzuconą próbę.
   */
  async assertNotLocked(
    access: AdminAccessContext,
    method: AdminAuthMethod,
    kind: AttemptKind,
    adminUserId: string | null,
    now: Date = new Date(),
  ): Promise<void> {
    const until = await this.lockedUntil(access, now);
    if (!until) return;
    await this.record(access, method, kind, 'LOCKED', adminUserId, 'LOCKED');
    throw new AdminAuthException('LOCKED', undefined, { lockedUntil: until });
  }

  /**
   * Rezerwacja próby PRZED weryfikacją: pod zamkiem doradczym adresu (i IP)
   * sprawdza blokadę i wstawia wiersz `PENDING`. Zwraca id rezerwacji do
   * `settle`; przy blokadzie zapisuje `LOCKED` i rzuca 429.
   *
   * Transakcja trzyma tylko własne, krótkie zapytania — weryfikacja idzie po
   * niej, więc zamek nie czeka na WebAuthn, a żądanie w kolejce do zamka nie
   * potrzebuje drugiego połączenia z puli.
   */
  async reserve(
    access: AdminAccessContext,
    method: AdminAuthMethod,
    kind: AttemptKind,
    adminUserId: string | null,
  ): Promise<string> {
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        // Kolejność zamków jest stała (adres, potem IP) — bez zakleszczeń.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_EMAIL}::int, hashtext(${access.email}))`;
        if (access.ip) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_NS_IP}::int, hashtext(${access.ip}))`;
        }
        // Czas i licznik POD zamkiem: poprzednik już zatwierdził swój wiersz,
        // a w READ COMMITTED każde zapytanie widzi świeżą migawkę.
        const until = await this.lockedUntil(access, new Date(), tx);
        const row = await tx.adminLoginAttempt.create({
          data: this.data(
            access,
            method,
            kind,
            until ? 'LOCKED' : 'PENDING',
            adminUserId,
            until ? 'LOCKED' : null,
          ),
          select: { id: true },
        });
        return { id: row.id, until };
      },
      // Seria równoległych prób kolejkuje się na zamku — każda trzyma go
      // milisekundy, ale czekać może dłużej niż domyślne 2 s / 5 s.
      { maxWait: 15_000, timeout: 15_000 },
    );
    if (outcome.until) {
      throw new AdminAuthException('LOCKED', undefined, {
        lockedUntil: outcome.until,
      });
    }
    return outcome.id;
  }

  /** Domknięcie rezerwacji wynikiem weryfikacji. */
  async settle(
    attemptId: string,
    result: 'SUCCESS' | 'FAILED',
    reason: string | null = null,
  ): Promise<void> {
    await this.prisma.adminLoginAttempt.updateMany({
      where: { id: attemptId, result: 'PENDING' },
      data: { result, reason },
    });
  }

  async record(
    access: AdminAccessContext,
    method: AdminAuthMethod,
    kind: AttemptKind,
    result: 'SUCCESS' | 'FAILED' | 'LOCKED',
    adminUserId: string | null,
    reason: string | null = null,
  ): Promise<void> {
    await this.prisma.adminLoginAttempt.create({
      data: this.data(access, method, kind, result, adminUserId, reason),
    });
  }

  private data(
    access: AdminAccessContext,
    method: AdminAuthMethod,
    kind: AttemptKind,
    result: 'SUCCESS' | 'FAILED' | 'LOCKED' | 'PENDING',
    adminUserId: string | null,
    reason: string | null,
  ): Prisma.AdminLoginAttemptUncheckedCreateInput {
    return {
      email: access.email,
      adminUserId,
      ip: access.ip,
      country: access.country,
      userAgent: access.userAgent,
      method,
      kind,
      result,
      reason,
    };
  }
}
