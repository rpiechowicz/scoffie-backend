import { createHash, timingSafeEqual } from 'crypto';
import { effectiveProcessEnv } from '../../config/runtime-overrides';

/**
 * Worker strony (`scoffie-web`, trasa `/przepis/*`) pyta publiczne API
 * w imieniu KAŻDEGO odwiedzającego, a wszyscy przychodzą z garstki adresów
 * Cloudflare — limit per IP dławiłby stronę przy pierwszym udostępnieniu
 * w dużej grupie. Worker przedstawia się więc sekretem i wtedy limit nie
 * obowiązuje (strona i tak trzyma odpowiedzi w cache na brzegu). Bez
 * sekretu — zwykły limit `THROTTLE_PUBLIC_LIMIT` per IP.
 */
export const WEB_RENDER_SECRET_HEADER = 'x-scoffie-web-secret';

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

type HeaderBag = Record<string, string | string[] | undefined> | undefined;

export function fromWebRenderer(
  headers: HeaderBag,
  env: NodeJS.ProcessEnv = effectiveProcessEnv(),
): boolean {
  const secret = env.WEB_RENDER_SECRET?.trim();
  // Krótki sekret to prawie brak sekretu — wtedy nikt nie omija limitu.
  if (!secret || secret.length < 32) return false;
  const raw = headers?.[WEB_RENDER_SECRET_HEADER];
  const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!presented) return false;
  // Skróty o stałej długości: `timingSafeEqual` wymaga równych buforów,
  // a porównanie nie zdradza długości sekretu.
  return timingSafeEqual(sha256(presented), sha256(secret));
}
