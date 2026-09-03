/**
 * `Promise.all` z górną granicą równoległości.
 *
 * Kolejność wyników jak w wejściu. Błąd jednego elementu przerywa całość
 * dokładnie jak w `Promise.all` — wołający, który chce „każdy osobno",
 * łapie błędy w `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
