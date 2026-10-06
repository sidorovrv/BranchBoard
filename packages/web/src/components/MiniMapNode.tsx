import type { MiniMapNodeProps } from "@xyflow/react";
import { useIsUnseenResult } from "../seenResults";
import { useSettings } from "../settings";
import { useBoard } from "../store";
import { TINT_FILL, TINT_STROKE, tintStyleOf } from "../tint";

const FILL = 0.5;
const CHAR_ASPECT = 0.6;

export const MiniMapNode = ({ id, x, y, width, height, borderRadius, color, strokeColor, strokeWidth, shapeRendering, className, style }: MiniMapNodeProps) => {
  const title = useBoard((state) => state.view.graph.nodes[id]?.title ?? "");
  const needsAnswer = useBoard((state) => state.view.graph.nodes[id]?.status === "awaiting_approval");
  const blinksForAttention = useSettings((state) => state.settings.blinkForAttention);
  const isUnseen = useIsUnseenResult(id);
  const fontSize = Math.sqrt((width * height * FILL) / (Math.max(title.length, 1) * CHAR_ASPECT));
  return (
    <g>
      <rect className={`${className ?? ""} ${needsAnswer && blinksForAttention ? "minimap-attention" : ""} ${isUnseen ? "minimap-unseen" : ""}`} x={x} y={y} rx={borderRadius} ry={borderRadius} width={width} height={height} strokeWidth={strokeWidth} shapeRendering={shapeRendering} style={{ ...style, ...tintStyleOf(title), fill: TINT_FILL, stroke: TINT_STROKE }} />
      {title && (
        <foreignObject x={x} y={y} width={width} height={height} pointerEvents="none">
          <div className="minimap-title" style={{ fontSize }}>{title}</div>
        </foreignObject>
      )}
    </g>
  );
};
