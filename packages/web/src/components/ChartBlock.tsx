import { useEffect, useMemo, useRef, useState } from "react";
import { parseChartSpec } from "@branchboard/core";
import { BlockError, BlockFrame } from "./BlockFrame";

const CATEGORICAL_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const CATEGORICAL_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const THEME_ATTRIBUTES = ["data-theme", "data-answer-font"];

const themeVariable = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const isDarkTheme = (): boolean => document.documentElement.dataset.theme === "dark";

const chartConfig = () => {
  const text = themeVariable("--text");
  const muted = themeVariable("--muted");
  const border = themeVariable("--border");
  const font = themeVariable("--ui-font");
  return {
    background: "transparent",
    font,
    view: { stroke: "transparent" },
    range: { category: isDarkTheme() ? CATEGORICAL_DARK : CATEGORICAL_LIGHT },
    axis: { labelColor: muted, titleColor: text, domainColor: border, tickColor: border, gridColor: border, labelFont: font, titleFont: font },
    legend: { labelColor: text, titleColor: text, labelFont: font, titleFont: font },
    title: { color: text, font, subtitleColor: muted },
    header: { labelColor: text, titleColor: text },
  };
};

const useThemeVersion = (): number => {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((current) => current + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: THEME_ATTRIBUTES });
    return () => observer.disconnect();
  }, []);
  return version;
};

const refuseLoading = () => Promise.reject(new Error("Charts must carry their data inline: loading from a URL is not allowed"));

interface ChartView {
  toImageURL: (type: string, scaleFactor?: number) => Promise<string>;
}

const PNG_SCALE = 2;

const chartFileName = (title: string | undefined): string => `${(title ?? "chart").trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "chart"}.png`;

const saveAsPng = async (view: ChartView | undefined, title: string | undefined) => {
  if (!view) return;
  const link = document.createElement("a");
  link.href = await view.toImageURL("png", PNG_SCALE);
  link.download = chartFileName(title);
  link.click();
};

const titleOf = (spec: Record<string, unknown>): string | undefined => {
  const title = spec.title;
  if (typeof title === "string") return title;
  const text = (title as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
};

const COMPOUND_KEYS = ["facet", "repeat", "concat", "hconcat", "vconcat"];

const fitToContainer = (spec: Record<string, unknown>): Record<string, unknown> =>
  COMPOUND_KEYS.some((key) => key in spec) ? spec : { ...spec, width: "container", autosize: { type: "fit", contains: "padding" } };

const ChartCanvas = ({ spec }: { spec: Record<string, unknown> }) => {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<ChartView | undefined>(undefined);
  const title = titleOf(spec);
  const [error, setError] = useState<string>();
  const themeVersion = useThemeVersion();

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    let isCancelled = false;
    let finalize: (() => void) | undefined;
    let observer: ResizeObserver | undefined;
    setError(undefined);
    void import("vega-embed")
      .then(async ({ default: embed, vega }) => {
        const loader = vega.loader();
        loader.load = refuseLoading;
        loader.sanitize = refuseLoading;
        const result = await embed(target, fitToContainer(spec) as never, {
          mode: "vega-lite",
          renderer: "svg",
          actions: false,
          config: chartConfig() as never,
          tooltip: { theme: isDarkTheme() ? "dark" : "light" },
          loader,
        });
        if (isCancelled) {
          result.finalize();
          return;
        }
        finalize = result.finalize;
        view.current = result.view;
        observer = new ResizeObserver(() => void result.view.resize().runAsync());
        observer.observe(target);
      })
      .catch((failure: Error) => {
        if (!isCancelled) setError(failure.message);
      });
    return () => {
      isCancelled = true;
      observer?.disconnect();
      view.current = undefined;
      finalize?.();
    };
  }, [spec, themeVersion]);

  return (
    <>
      {error && <BlockError message={`The chart could not be drawn: ${error}`} />}
      <div ref={container} className="chart-canvas nodrag nowheel" />
      <div className="data-table-foot">
        <span />
        <span className="rich-actions">
          <button className="nodrag" onClick={() => void saveAsPng(view.current, title)}>Save as PNG</button>
        </span>
      </div>
    </>
  );
};

export const ChartBlock = ({ source }: { source: string }) => {
  const parsed = useMemo(() => parseChartSpec(source), [source]);
  return (
    <BlockFrame label="chart" source={source} language="json">
      {"error" in parsed ? <BlockError message={parsed.error} /> : <ChartCanvas spec={parsed.spec} />}
    </BlockFrame>
  );
};
