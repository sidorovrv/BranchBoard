export interface BoardOpenTiming {
  fetchMs: number;
  parseMs: number;
  renderMs: number;
  totalMs: number;
  nodes: number;
}

let finished: BoardOpenTiming | undefined;

export const recordBoardOpen = (timing: BoardOpenTiming) => {
  finished = timing;
};

export const takeBoardOpen = (): BoardOpenTiming | null => {
  const timing = finished ?? null;
  finished = undefined;
  return timing;
};
