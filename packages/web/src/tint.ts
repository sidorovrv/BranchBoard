import type { CSSProperties } from "react";
import { nodeTintOf } from "@branchboard/core";

export const TINT_FILL = "hsl(var(--hue) var(--tint-s) calc(var(--tint-l) + var(--tone) * 1%))";
export const TINT_STROKE = "hsl(var(--hue) var(--tint-s) calc(var(--tint-border-l) + var(--tone) * 1%))";

export const tintStyleOf = (title: string): CSSProperties => {
  const { hue, tone } = nodeTintOf(title);
  return { "--hue": hue, "--tone": tone } as CSSProperties;
};
