import { Injectable } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { isUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';

export type AccessTokenFailureReason =
  | 'missing'
  | 'invalid'
  | 'expired'
  | 'user_gone';

export type VerifiedAccessToken = {
  ok: true;
  userId: string;
  /** `exp` z tokenu (sekundy od epoki) — do timera wygaśnięcia na sockecie. */
  exp: number | null;
};

export type AccessTokenFailure = {
  ok: false;
  reason: AccessTokenFailureReason;
};

export type AccessTokenVerdict = VerifiedAccessToken | AccessTokenFailure;

/** `Authorization: Bearer <token>` → token, inaczej `null`. */
export function parseBearer(
  header: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const [type, token] = raw.trim().split(/\s+/);
  return type === 'Bearer' && token ? token : null;
}

/**
 * Jedna weryfikacja tokenu dostępowego dla REST (`JwtAuthGuard`) i dla
 * handshake'u WebSocketu (`AuthIoAdapter`).
 *
 * Poza podpisem i `exp` sprawdza, czy user nadal istnieje: `users:delete`
 * kasuje konto, ale JWT jest ważny do `exp` (30 dni) i nic go nie
 * unieważnia. Metered endpoint asystenta nie może przyjąć tokenu konta,
 * którego nie ma do kogo obciążyć. Powód odmowy jest rozróżniony
 * (`missing` / `invalid` / `expired` / `user_gone`), ale na drucie kod jest
 * jeden — `UNAUTHORIZED` — żeby iOS nie potrzebował nowej kopii;
 * powód jedzie w `details` (HTTP) albo `data.reason` (WS).
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async verify(token: string | null | undefined): Promise<AccessTokenVerdict> {
    const trimmed = (token ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'missing' };

    let payload: { sub?: unknown; exp?: unknown };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub?: unknown;
        exp?: unknown;
      }>(trimmed);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof TokenExpiredError ? 'expired' : 'invalid',
      };
    }

    const userId = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    // `User.id` to @db.Uuid — nie-UUID w `sub` (token podpisany naszym
    // sekretem, ale spreparowany) dałby P2023 z Prismy, czyli 500 zamiast 401.
    if (!userId || !isUuid(userId)) return { ok: false, reason: 'invalid' };

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) return { ok: false, reason: 'user_gone' };

    return {
      ok: true,
      userId,
      exp: typeof payload.exp === 'number' ? payload.exp : null,
    };
  }

  /**
   * Gospodarstwa usera — pokoje WS. Osobno od `verify`, bo adapter najpierw
   * dołącza socket do `user:<id>` (żeby `joinHousehold` z równoległego
   * `households:create`/`acceptInvitation` go widział), a dopiero potem czyta
   * członkostwa.
   */
  async householdIds(userId: string): Promise<string[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });
    return memberships.map((m) => m.householdId);
  }
}
