/**
 * A tiny bounded worker pool.
 *
 * Direct-source discovery fans out one HTTP request per employer board. Those
 * requests are independent, so they run concurrently — but only a fixed number
 * at a time, so a scan is polite to each platform and cannot open an unbounded
 * number of sockets.
 *
 * Order of completion is deliberately not preserved: callers that need a stable
 * order sort the results themselves. A worker that throws rejects the whole
 * pool, so callers either keep workers total or catch inside them.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.trunc(concurrency)) : 1;
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;

      if (index >= items.length) {
        return;
      }

      await worker(items[index]);
    }
  });

  await Promise.all(runners);
}
