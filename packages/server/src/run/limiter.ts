export const createLimiter = (limit: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];

  const makeRelease = () => {
    let isReleased = false;
    return () => {
      if (isReleased) return;
      isReleased = true;
      active -= 1;
      waiting.shift()?.();
    };
  };

  const acquire = (signal: AbortSignal) =>
    new Promise<(() => void) | undefined>((resolve) => {
      if (signal.aborted) return resolve(undefined);
      const grant = () => {
        signal.removeEventListener("abort", giveUp);
        active += 1;
        resolve(makeRelease());
      };
      const giveUp = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        resolve(undefined);
      };
      signal.addEventListener("abort", giveUp, { once: true });
      if (active < limit) grant();
      else waiting.push(grant);
    });

  return { acquire, activeCount: () => active, waitingCount: () => waiting.length, limit, isFull: () => active >= limit };
};

export type Limiter = ReturnType<typeof createLimiter>;

export const withSlot = async <Result>(limiter: Limiter | undefined, signal: AbortSignal, setWaiting: ((isWaiting: boolean) => void) | undefined, work: () => Promise<Result>): Promise<Result | undefined> => {
  if (!limiter) return work();
  if (limiter.isFull()) setWaiting?.(true);
  const release = await limiter.acquire(signal);
  setWaiting?.(false);
  if (!release) return undefined;
  try {
    return await work();
  } finally {
    release();
  }
};
