import { useEffect, useMemo, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, useStore, useStoreApi, type ConnectionLineComponentProps, type EdgeProps } from "@xyflow/react";
import { commitGraphEdit } from "../actions";
import { coverKeyOf, distanceBetween, nearestPoint, REMOVE_BUTTON_RADIUS, visiblePointsOfWire, wirePathOf, type Point } from "../wirePoints";
import { useContextMenu } from "./ContextMenu";

const REMOVE_BUTTON_SIZE = REMOVE_BUTTON_RADIUS * 2;
const MIN_LENGTH_FOR_MIDPOINT_DOT = REMOVE_BUTTON_SIZE * 1.2;
const HOVER_DWELL_MS = 450;
const DWELL_TOLERANCE_PX = 5;
const HOVER_GRACE_MS = 120;
const POINTER_REACH_PX = 14;

type PointerPosition = Pick<MouseEvent, "clientX" | "clientY">;

interface WireData {
  isDimmed?: boolean;
  isHighlighted?: boolean;
  isSatelliteLink?: boolean;
  isFlowing?: boolean;
  sourceKind?: string;
}

interface RemoveButtonProps {
  at: Point;
  onEnter: () => void;
  onLeave: () => void;
  onRemove: () => void;
}

const RemoveButton = ({ at, onEnter, onLeave, onRemove }: RemoveButtonProps) => (
  <button
    className="edge-remove nodrag nopan"
    style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
    onMouseEnter={onEnter}
    onMouseLeave={onLeave}
    onClick={onRemove}
    title="Delete connection"
    aria-label="Delete connection"
  >
    ×
  </button>
);

export const WireConnectionLine = ({ fromX, fromY, toX, toY, fromPosition, toPosition }: ConnectionLineComponentProps) => (
  <path className="react-flow__connection-path" fill="none" d={wirePathOf({ x: fromX, y: fromY }, fromPosition, { x: toX, y: toY }, toPosition).path} />
);

export const WireEdge = ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd, data }: EdgeProps) => {
  const { isDimmed, isHighlighted, isSatelliteLink, isFlowing, sourceKind } = (data ?? {}) as WireData;
  const [isHovered, setIsHovered] = useState(false);
  const [pointerButton, setPointerButton] = useState<Point>();
  const wire = useRef<SVGGElement>(null);
  const leaveTimer = useRef<number>(undefined);
  const dwellTimer = useRef<number>(undefined);
  const dwellAnchor = useRef<Point>(undefined);
  const store = useStoreApi();
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const contextMenu = useContextMenu();
  const source = { x: sourceX, y: sourceY };
  const target = { x: targetX, y: targetY };
  const { path, middle, curve } = wirePathOf(source, sourcePosition, target, targetPosition);
  const latestCurve = useRef(curve);
  latestCurve.current = curve;
  const isActive = !isSatelliteLink && (isHovered || selected);
  const coverKey = useStore((state) => (isActive ? coverKeyOf(state.nodeLookup.values()) : ""));
  const visiblePoints = useMemo(() => (isActive ? visiblePointsOfWire(latestCurve.current, store.getState().nodeLookup.values()) : []), [isActive, path, coverKey, store]);
  const visibleButton = isActive ? nearestPoint(visiblePoints, middle) : undefined;
  const shownPointerButton = pointerButton && (visibleButton === undefined || distanceBetween(pointerButton, visibleButton) >= REMOVE_BUTTON_SIZE + 4) ? pointerButton : undefined;
  const wireClasses = ["wire", `kind-${sourceKind ?? "turn"}`, isDimmed && "dimmed", (isHighlighted || selected) && "highlighted", isFlowing && "flowing"].filter(Boolean).join(" ");
  const remove = () => void commitGraphEdit({ type: "disconnect", edgeId: id });

  useEffect(
    () => () => {
      window.clearTimeout(leaveTimer.current);
      window.clearTimeout(dwellTimer.current);
    },
    [],
  );

  const enter = () => {
    window.clearTimeout(leaveTimer.current);
    setIsHovered(true);
  };

  const leave = () => {
    window.clearTimeout(dwellTimer.current);
    dwellAnchor.current = undefined;
    leaveTimer.current = window.setTimeout(() => {
      setIsHovered(false);
      setPointerButton(undefined);
    }, HOVER_GRACE_MS);
  };

  const trackPointer = (event: PointerPosition) => {
    if (isSatelliteLink) return;
    const pointer = { x: event.clientX, y: event.clientY };
    if (dwellAnchor.current && distanceBetween(pointer, dwellAnchor.current) < DWELL_TOLERANCE_PX) return;
    dwellAnchor.current = pointer;
    setPointerButton(undefined);
    window.clearTimeout(dwellTimer.current);
    dwellTimer.current = window.setTimeout(() => {
      const pointerOnBoard = screenToFlowPosition(pointer);
      const nearest = nearestPoint(visiblePointsOfWire(latestCurve.current, store.getState().nodeLookup.values()), pointerOnBoard);
      if (nearest && distanceBetween(nearest, pointerOnBoard) <= POINTER_REACH_PX / getZoom()) setPointerButton(nearest);
    }, HOVER_DWELL_MS);
  };

  const hoverHandlers = useRef({ enter, leave, trackPointer });
  hoverHandlers.current = { enter, leave, trackPointer };

  useEffect(() => {
    const hoverArea = wire.current?.parentElement;
    if (!hoverArea) return;
    const onEnter = () => hoverHandlers.current.enter();
    const onLeave = () => hoverHandlers.current.leave();
    const onMove = (event: MouseEvent) => hoverHandlers.current.trackPointer(event);
    hoverArea.addEventListener("mouseenter", onEnter);
    hoverArea.addEventListener("mouseleave", onLeave);
    hoverArea.addEventListener("mousemove", onMove);
    return () => {
      hoverArea.removeEventListener("mouseenter", onEnter);
      hoverArea.removeEventListener("mouseleave", onLeave);
      hoverArea.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <g
      ref={wire}
      data-tour="wire"
      className={wireClasses}
      onContextMenu={isSatelliteLink ? undefined : contextMenu.open([{ label: "Delete Connection", isDanger: true, run: remove }])}
    >
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={24} className={wireClasses} />
      {!isSatelliteLink && !isActive && distanceBetween(source, target) >= MIN_LENGTH_FOR_MIDPOINT_DOT && <circle className="wire-midpoint" cx={middle.x} cy={middle.y} r={4} />}
      {(visibleButton || shownPointerButton) && (
        <EdgeLabelRenderer>
          {visibleButton && <RemoveButton at={visibleButton} onEnter={enter} onLeave={leave} onRemove={remove} />}
          {shownPointerButton && <RemoveButton at={shownPointerButton} onEnter={enter} onLeave={leave} onRemove={remove} />}
        </EdgeLabelRenderer>
      )}
      {contextMenu.element}
    </g>
  );
};
