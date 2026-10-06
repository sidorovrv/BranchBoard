export const createChannel = <T>() => {
  const queued: T[] = [];
  let waiting: ((result: IteratorResult<T>) => void) | undefined;
  let isClosed = false;
  const finished = { value: undefined, done: true } as IteratorResult<T>;

  const push = (item: T) => {
    if (isClosed) return;
    if (!waiting) return void queued.push(item);
    const resume = waiting;
    waiting = undefined;
    resume({ value: item, done: false });
  };

  const close = () => {
    isClosed = true;
    waiting?.(finished);
    waiting = undefined;
  };

  const iterator: AsyncIterableIterator<T> = {
    next: () => {
      if (queued.length > 0) return Promise.resolve({ value: queued.shift() as T, done: false });
      if (isClosed) return Promise.resolve(finished);
      return new Promise<IteratorResult<T>>((resolve) => (waiting = resolve));
    },
    return: () => {
      close();
      return Promise.resolve(finished);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return { push, close, iterator };
};
