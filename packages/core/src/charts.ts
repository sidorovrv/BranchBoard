export type ChartParse = { spec: Record<string, unknown> } | { error: string };

export const MAX_CHART_SOURCE_CHARS = 400000;

const hasExternalUrl = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasExternalUrl);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, inner]) => (key === "url" && typeof inner === "string") || hasExternalUrl(inner));
};

const isSingleView = (spec: Record<string, unknown>): boolean => spec.mark !== undefined || spec.layer !== undefined;

const withTooltip = (mark: unknown): unknown => {
  if (typeof mark === "string") return { type: mark, tooltip: true };
  if (typeof mark === "object" && mark !== null && !("tooltip" in mark)) return { ...mark, tooltip: true };
  return mark;
};

const withDefaults = (spec: Record<string, unknown>): Record<string, unknown> => {
  if (!isSingleView(spec)) return spec;
  return {
    ...spec,
    ...(spec.mark !== undefined ? { mark: withTooltip(spec.mark) } : {}),
    ...(spec.width === undefined ? { width: "container" } : {}),
    ...(spec.autosize === undefined ? { autosize: { type: "fit", contains: "padding" } } : {}),
  };
};

export const parseChartSpec = (text: string): ChartParse => {
  if (text.length > MAX_CHART_SOURCE_CHARS) return { error: "The chart spec is too large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `The chart is not valid JSON: ${(error as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "A chart must be a Vega-Lite JSON object" };
  if (hasExternalUrl(raw)) return { error: "Charts must carry their data inline: loading data from a URL is not allowed" };
  return { spec: withDefaults(raw as Record<string, unknown>) };
};
