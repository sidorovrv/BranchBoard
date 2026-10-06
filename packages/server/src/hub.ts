import type { BoardEvent, Id } from "@branchboard/core";

export interface Subscriber {
  send(message: string): void;
}

export interface Hub {
  subscribe(boardId: Id, subscriber: Subscriber): () => void;
  broadcast(boardId: Id, event: BoardEvent): void;
  takeStats(): { clients: number; messages: number };
}

export const createHub = (): Hub => {
  const subscribers = new Map<Id, Set<Subscriber>>();
  let messagesSinceLastStats = 0;
  return {
    takeStats: () => {
      const messages = messagesSinceLastStats;
      messagesSinceLastStats = 0;
      return { clients: [...subscribers.values()].reduce((total, group) => total + group.size, 0), messages };
    },
    subscribe: (boardId, subscriber) => {
      const group = subscribers.get(boardId) ?? new Set<Subscriber>();
      group.add(subscriber);
      subscribers.set(boardId, group);
      return () => group.delete(subscriber);
    },
    broadcast: (boardId, event) => {
      const message = JSON.stringify(event);
      subscribers.get(boardId)?.forEach((subscriber) => {
        messagesSinceLastStats++;
        subscriber.send(message);
      });
    },
  };
};
