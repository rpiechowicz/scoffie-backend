/** Limity komunikatu w aplikacji — baner ma się zmieścić na telefonie. */
export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_BODY_MAX = 400;
/** Najwyżej tyle komunikatów może być aktywnych w jednej chwili. */
export const ANNOUNCEMENT_MAX_ACTIVE = 3;

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverityValue =
  (typeof ANNOUNCEMENT_SEVERITIES)[number];
export const ANNOUNCEMENT_AUDIENCES = [
  'all',
  'ios',
  'android',
  'households',
] as const;
export type AnnouncementAudienceValue = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export type ClientPlatform = 'ios' | 'android';

/** Liczba znaków tak, jak widzi ją człowiek (emoji = 1, nie 2 jednostki UTF-16). */
export const charCount = (value: string): number => [...value].length;

/**
 * Czysty tekst: bez znaczników HTML/XML i encji, bez znaków sterujących
 * (poza nową linią w treści). Klient i tak wyświetla tekst dosłownie —
 * to zabezpieczenie przed „<b>” widocznym na banerze i przed klientem,
 * który kiedyś zacząłby renderować HTML/Markdown.
 */
export function plainTextProblem(
  value: string,
  allowNewlines: boolean,
): string | null {
  if (/<\s*[a-zA-Z!/?]/.test(value)) return 'bez znaczników HTML';
  if (/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]{2,8});/.test(value)) {
    return 'bez encji HTML';
  }
  const hasControl = [...value].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (allowNewlines && code === 0x0a) return false;
    return code < 0x20 || code === 0x7f;
  });
  if (hasControl) {
    return allowNewlines ? 'bez znaków sterujących' : 'w jednej linii';
  }
  return null;
}

/**
 * Platforma klienta: jawny nagłówek `X-Client-Platform` (`ios`/`android`),
 * a bez niego `User-Agent`. iOS z `URLSession` wysyła domyślnie
 * `Scoffie/<build> CFNetwork/… Darwin/…`, Android z OkHttp `okhttp/…`.
 * Nierozpoznana = `null` → tylko komunikaty „wszyscy” i dla domu.
 */
export function clientPlatform(
  platformHeader: string | undefined,
  userAgent: string | undefined,
): ClientPlatform | null {
  const explicit = platformHeader?.trim().toLowerCase();
  if (explicit === 'ios' || explicit === 'android') return explicit;
  const ua = userAgent ?? '';
  if (/android|okhttp|dalvik|ktor/i.test(ua)) return 'android';
  if (/cfnetwork|darwin|iphone|ipad|\bios\b/i.test(ua)) return 'ios';
  return null;
}

export type AnnouncementTarget = {
  audience: AnnouncementAudienceValue;
  householdIds: readonly string[];
  startsAt: Date;
  endsAt: Date | null;
};

/** Czy komunikat jest teraz aktywny dla tej osoby. */
export function announcementMatches(
  row: AnnouncementTarget,
  viewer: { householdId: string | null; platform: ClientPlatform | null },
  now: Date,
): boolean {
  if (row.startsAt > now) return false;
  if (row.endsAt && row.endsAt <= now) return false;
  switch (row.audience) {
    case 'all':
      return true;
    case 'ios':
    case 'android':
      return viewer.platform === row.audience;
    case 'households':
      return (
        viewer.householdId !== null &&
        row.householdIds.includes(viewer.householdId)
      );
  }
}

const SEVERITY_RANK: Record<AnnouncementSeverityValue, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Najważniejsze najpierw, w obrębie wagi — najnowsze. */
export function compareAnnouncements(
  a: { severity: AnnouncementSeverityValue; startsAt: Date },
  b: { severity: AnnouncementSeverityValue; startsAt: Date },
): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    b.startsAt.getTime() - a.startsAt.getTime()
  );
}
