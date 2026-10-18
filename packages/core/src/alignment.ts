export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Guide {
  axis: "vertical" | "horizontal";
  position: number;
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

interface AxisCandidate {
  offset: number;
  target: number;
}

const xAnchorsOf = (box: Box): number[] => [box.x, box.x + box.w / 2, box.x + box.w];

const yAnchorsOf = (box: Box): number[] => [box.y, box.y + box.h / 2, box.y + box.h];

const nearestOffset = (moving: number[], fixed: number[], threshold: number): AxisCandidate | undefined => {
  let best: AxisCandidate | undefined;
  moving.forEach((from) =>
    fixed.forEach((target) => {
      const offset = target - from;
      if (Math.abs(offset) <= threshold && (!best || Math.abs(offset) < Math.abs(best.offset))) best = { offset, target };
    }),
  );
  return best;
};

const boundsOf = (boxes: Box[]): Box => {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
};

const verticalGuidesAt = (moved: Box, others: Box[], position: number): Guide[] => {
  const matching = others.filter((other) => xAnchorsOf(other).some((anchor) => anchor === position));
  const boxes = [moved, ...matching];
  return [{ axis: "vertical", position, from: Math.min(...boxes.map((box) => box.y)), to: Math.max(...boxes.map((box) => box.y + box.h)) }];
};

const horizontalGuidesAt = (moved: Box, others: Box[], position: number): Guide[] => {
  const matching = others.filter((other) => yAnchorsOf(other).some((anchor) => anchor === position));
  const boxes = [moved, ...matching];
  return [{ axis: "horizontal", position, from: Math.min(...boxes.map((box) => box.x)), to: Math.max(...boxes.map((box) => box.x + box.w)) }];
};

export interface ResizeSnapResult {
  dw: number;
  dh: number;
  guides: Guide[];
}

export type ResizeDirection = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

const draggedEdge = (start: number, size: number, direction: number): number[] => (direction === 1 ? [start + size] : direction === -1 ? [start] : []);

export const snapResizedEdges = (box: Box, direction: ResizeDirection, others: Box[], threshold: number): ResizeSnapResult => {
  if (others.length === 0) return { dw: 0, dh: 0, guides: [] };
  const horizontal = nearestOffset(draggedEdge(box.x, box.w, direction.x), others.flatMap(xAnchorsOf), threshold);
  const vertical = nearestOffset(draggedEdge(box.y, box.h, direction.y), others.flatMap(yAnchorsOf), threshold);
  const dw = (horizontal?.offset ?? 0) * direction.x;
  const dh = (vertical?.offset ?? 0) * direction.y;
  const snapped: Box = {
    x: direction.x === -1 ? box.x - dw : box.x,
    y: direction.y === -1 ? box.y - dh : box.y,
    w: box.w + dw,
    h: box.h + dh,
  };
  return {
    dw,
    dh,
    guides: [...(horizontal ? verticalGuidesAt(snapped, others, horizontal.target) : []), ...(vertical ? horizontalGuidesAt(snapped, others, vertical.target) : [])],
  };
};

export const snapMovingBoxes = (movingBoxes: Box[], others: Box[], threshold: number): SnapResult => {
  if (movingBoxes.length === 0 || others.length === 0) return { dx: 0, dy: 0, guides: [] };
  const moving = boundsOf(movingBoxes);
  const fixedX = others.flatMap(xAnchorsOf);
  const fixedY = others.flatMap(yAnchorsOf);
  const horizontal = nearestOffset(xAnchorsOf(moving), fixedX, threshold);
  const vertical = nearestOffset(yAnchorsOf(moving), fixedY, threshold);
  const dx = horizontal?.offset ?? 0;
  const dy = vertical?.offset ?? 0;
  const snapped: Box = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return {
    dx,
    dy,
    guides: [...(horizontal ? verticalGuidesAt(snapped, others, horizontal.target) : []), ...(vertical ? horizontalGuidesAt(snapped, others, vertical.target) : [])],
  };
};
