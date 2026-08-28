/**
 * Jedna definicja normalizacji tekstu dla całego repo.
 *
 * Kopie tej funkcji żyły w pięciu miejscach i już się rozjechały o `\s+`:
 * loader katalogu zwijał białe znaki, czytelnicy (import przepisów,
 * przeliczanie makro) nie — więc `Ingredient.normalizedName` mógł być
 * zapisany innym kluczem niż ten, którym import go szuka. Zgadzały się tylko
 * dlatego, że żadna nazwa w katalogu nie ma podwójnej spacji. Zwijanie
 * zostaje — to wariant nadrzędny, a `normalizedName` pisze właśnie on.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ł]/g, 'l')
    .replace(/[ą]/g, 'a')
    .replace(/[ć]/g, 'c')
    .replace(/[ę]/g, 'e')
    .replace(/[ń]/g, 'n')
    .replace(/[ó]/g, 'o')
    .replace(/[ś]/g, 's')
    .replace(/[ź]/g, 'z')
    .replace(/[ż]/g, 'z')
    .trim()
    .replace(/\s+/g, ' ');
}
