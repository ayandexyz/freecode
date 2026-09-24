// Background memory jobs — observable fire-and-forget work for evaluations.
const jobs = new Map<string, Set<Promise<unknown>>>();

export function trackMemoryJob<T>(
  sessionId: string,
  job: Promise<T>,
): Promise<T> {
  const set = jobs.get(sessionId) ?? new Set<Promise<unknown>>();
  jobs.set(sessionId, set);
  set.add(job);
  void job
    .finally(() => {
      set.delete(job);
      if (set.size === 0) jobs.delete(sessionId);
    })
    .catch(() => {});
  return job;
}

export async function drainMemoryJobs(
  sessionId: string,
  timeoutMs: number,
): Promise<{ pending: number; timedOut: boolean }> {
  const pending = () => [...(jobs.get(sessionId) ?? [])];
  const current = pending();
  if (current.length === 0) return { pending: 0, timedOut: false };
  let timedOut = false;
  await Promise.race([
    Promise.allSettled(current),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
      timer.unref?.();
    }),
  ]);
  return { pending: pending().length, timedOut };
}
