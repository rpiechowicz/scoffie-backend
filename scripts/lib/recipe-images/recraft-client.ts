/**
 * Minimalny klient Recraft API (https://external.api.recraft.ai/v1).
 * Klucz: `RECRAFT_AI_KEY`. Ceny (23.09.2026): generowanie `recraftv4_1`
 * 0,035 $, crispUpscale 0,004 $.
 */

const BASE_URL = 'https://external.api.recraft.ai/v1/images';

export const RECRAFT_MODEL = 'recraftv4_1';
/** 16:9 w `recraftv4_1` = 1344x768 — ten sam format co reszta katalogu. */
export const RECRAFT_SIZE = '16:9';

function apiKey(): string {
  const key = process.env.RECRAFT_AI_KEY?.trim();
  if (!key) throw new Error('Missing RECRAFT_AI_KEY');
  return key;
}

type RecraftResponse = {
  data?: Array<{ url?: string }>;
  image?: { url?: string };
};

async function readImageUrl(response: Response, what: string): Promise<string> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${what}: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as RecraftResponse;
  const url = body.data?.[0]?.url ?? body.image?.url;
  if (!url) throw new Error(`${what}: brak adresu obrazka w odpowiedzi`);
  return url;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`pobieranie obrazka: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function recraftGenerate(
  prompt: string,
  seed: number,
): Promise<Buffer> {
  const response = await fetch(`${BASE_URL}/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      model: RECRAFT_MODEL,
      size: RECRAFT_SIZE,
      n: 1,
      random_seed: seed,
      response_format: 'url',
    }),
  });
  return download(await readImageUrl(response, 'generations'));
}

async function postImage(endpoint: string, image: Buffer): Promise<Buffer> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(image)]), 'source.webp');
  form.append('image_format', 'png');
  const response = await fetch(`${BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
  });
  return download(await readImageUrl(response, endpoint));
}

/** Wyostrzające powiększenie (u nas x3); wynik jako PNG, żeby nie tracić dwa razy. */
export function recraftCrispUpscale(image: Buffer): Promise<Buffer> {
  return postImage('crispUpscale', image);
}

/** PNG z przezroczystym tłem (0,01 $) — zapasowy sposób na znalezienie naczynia. */
export function recraftRemoveBackground(image: Buffer): Promise<Buffer> {
  return postImage('removeBackground', image);
}
