import { Position, type InternalNode } from "@xyflow/react";

export interface Point {
  x: number;
  y: number;
}

const FORWARD_OFFSET_SHARE = 0.4;
const BACKWARD_CURVATURE = 0.15;

const SIDE_DIRECTIONS: Record<Position, Point> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

const controlPointOf = (from: Point, side: Position, to: Point): Point => {
  const direction = SIDE_DIRECTIONS[side];
  const distance = (to.x - from.x) * direction.x + (to.y - from.y) * direction.y;
  const offset = distance >= 0 ? FORWARD_OFFSET_SHARE * distance : BACKWARD_CURVATURE * 25 * Math.sqrt(-distance);
  return { x: from.x + direction.x * offset, y: from.y + direction.y * offset };
};

export type Curve = [Point, Point, Point, Point];

const curvePointAt = ([start, first, second, end]: Curve, t: number): Point => {
  const rest = 1 - t;
  const weights = [rest ** 3, 3 * rest * rest * t, 3 * rest * t * t, t ** 3];
  return { x: weights[0] * start.x + weights[1] * first.x + weights[2] * second.x + weights[3] * end.x, y: weights[0] * start.y + weights[1] * first.y + weights[2] * second.y + weights[3] * end.y };
};

export const wirePathOf = (source: Point, sourceSide: Position, target: Point, targetSide: Position): { path: string; middle: Point; curve: Curve } => {
  const first = controlPointOf(source, sourceSide, target);
  const second = controlPointOf(target, targetSide, source);
  const curve: Curve = [source, first, second, target];
  return {
    path: `M${source.x},${source.y} C${first.x},${first.y} ${second.x},${second.y} ${target.x},${target.y}`,
    middle: curvePointAt(curve, 0.5),
    curve,
  };
};

export const REMOVE_BUTTON_RADIUS = 11;

const SAMPLE_STEP = 4;
const NODE_CLEARANCE = REMOVE_BUTTON_RADIUS + 4;
const ENDPOINT_CLEARANCE = REMOVE_BUTTON_RADIUS + 9;

export const distanceBetween = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const samplesOfCurve = (curve: Curve): Point[] => {
  const controlLength = curve.slice(1).reduce((total, point, index) => total + distanceBetween(curve[index], point), 0);
  const steps = Math.max(1, Math.ceil(controlLength / SAMPLE_STEP));
  return Array.from({ length: steps + 1 }, (_, index) => curvePointAt(curve, index / steps));
};

const boxOf = (node: InternalNode) => {
  const { x, y } = node.internals.positionAbsolute;
  return { x, y, width: node.measured.width ?? node.width ?? node.initialWidth ?? 0, height: node.measured.height ?? node.height ?? node.initialHeight ?? 0 };
};

export const coverKeyOf = (nodes: Iterable<InternalNode>): string =>
  [...nodes]
    .filter((node) => !node.hidden)
    .map((node) => Object.values(boxOf(node)).join(","))
    .join(";");

const isNearNode = (point: Point, node: InternalNode): boolean => {
  const { x, y, width, height } = boxOf(node);
  return !node.hidden && point.x > x - NODE_CLEARANCE && point.x < x + width + NODE_CLEARANCE && point.y > y - NODE_CLEARANCE && point.y < y + height + NODE_CLEARANCE;
};

export const visiblePointsOfWire = (curve: Curve, nodes: Iterable<InternalNode>): Point[] => {
  const samples = samplesOfCurve(curve);
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (distanceBetween(first, last) < 2 * ENDPOINT_CLEARANCE) return [samples[Math.floor(samples.length / 2)]];
  const covering = [...nodes];
  return samples.filter((point) => distanceBetween(point, first) >= ENDPOINT_CLEARANCE && distanceBetween(point, last) >= ENDPOINT_CLEARANCE && !covering.some((node) => isNearNode(point, node)));
};

export const nearestPoint = (points: Point[], target: Point): Point | undefined =>
  points.reduce<Point | undefined>((best, point) => (best === undefined || distanceBetween(point, target) < distanceBetween(best, target) ? point : best), undefined);
