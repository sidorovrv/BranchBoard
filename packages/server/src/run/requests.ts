import type { Id } from "@branchboard/core";

export const createAnswerWaiters = () => {
  const waiters = new Map<Id, (answer: string) => void>();
  return {
    wait: (requestId: Id) => new Promise<string>((resolve) => waiters.set(requestId, resolve)),
    resolve: (requestId: Id, answer: string) => {
      waiters.get(requestId)?.(answer);
      waiters.delete(requestId);
    },
    rejectAll: (answer: string) => {
      waiters.forEach((resolve) => resolve(answer));
      waiters.clear();
    },
  };
};

export type AnswerWaiters = ReturnType<typeof createAnswerWaiters>;
