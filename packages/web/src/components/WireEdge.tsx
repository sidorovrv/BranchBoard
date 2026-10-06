import { useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { commitGraphEdit } from "../actions";

const REMOVE_BUTTON_SIZE = 22;
const MIN_LENGTH_FOR_REMOVE_BUTTON = REMOVE_BUTTON_SIZE * 1.2;

interface WireData {
  isDimmed?: boolean;
  isHighlighted?: boolean;
  isSatelliteLink?: boolean;
  isFlowing?: boolean;
  sourceKind?: string;
}

export const WireEdge = ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd, data }: EdgeProps) => {
  const [isHovered, setIsHovered] = useState(false);
  const { isDimmed, isHighlighted, isSatelliteLink, isFlowing, sourceKind } = (data ?? {}) as WireData;
  const canFitRemoveButton = !isSatelliteLink && Math.hypot(targetX - sourceX, targetY - sourceY) >= MIN_LENGTH_FOR_REMOVE_BUTTON;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const wireClasses = ["wire", `kind-${sourceKind ?? "turn"}`, isDimmed && "dimmed", (isHighlighted || selected) && "highlighted", isFlowing && "flowing"].filter(Boolean).join(" ");
  return (
    <g className={wireClasses} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={24} className={wireClasses} />
      {canFitRemoveButton && !isHovered && !selected && <circle className="wire-midpoint" cx={labelX} cy={labelY} r={4} />}
      {(isHovered || selected) && canFitRemoveButton && (
        <EdgeLabelRenderer>
          <button
            className="edge-remove nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => setIsHovered(true)}
            onClick={() => void commitGraphEdit({ type: "disconnect", edgeId: id })}
            title="Disconnect"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </g>
  );
};
