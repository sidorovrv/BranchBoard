import { useEffect, useState } from "react";
import { TOUR_STEPS, type TourStep } from "@branchboard/core";
import { useSettings } from "../settings";
import { useBoard } from "../store";
import { endTour } from "../tour";

const TARGET_POLL_MS = 120;
const CARD_WIDTH = 340;
const CARD_HEIGHT_ESTIMATE = 190;
const GAP = 14;
const SPOTLIGHT_PADDING = 6;

const nodeElementOf = (title: string): Element | undefined => [...document.querySelectorAll<HTMLElement>('[data-tour="node"]')].find((element) => element.dataset.nodeTitle === title);

export const tourTargetOf = (step: TourStep): Element | null => {
  const selector = `[data-tour="${step.anchor}"]`;
  const scope = step.focusTitle ? nodeElementOf(step.focusTitle) : undefined;
  return (scope?.matches(selector) ? scope : scope?.querySelector(selector)) ?? document.querySelector(selector);
};

const prepareStep = (step: TourStep) => {
  if (step.anchor === "context-panel") useSettings.getState().update("isContextPanelOpen", true);
  if (!step.focusTitle) return;
  const { nodes } = useBoard.getState().view.graph;
  const node = Object.values(nodes).find((candidate) => candidate.title === step.focusTitle);
  if (!node) return;
  useBoard.getState().focusNode(node.id);
  if (step.selectsNode) useBoard.getState().requestSelection([node.id]);
};

const cardPositionOf = (rect: DOMRect | undefined): { left: number; top: number } => {
  if (!rect) return { left: (window.innerWidth - CARD_WIDTH) / 2, top: window.innerHeight / 3 };
  const left = Math.max(GAP, Math.min(rect.left, window.innerWidth - CARD_WIDTH - GAP));
  const fitsBelow = rect.bottom + GAP + CARD_HEIGHT_ESTIMATE < window.innerHeight;
  const top = fitsBelow ? rect.bottom + GAP : Math.max(GAP, rect.top - GAP - CARD_HEIGHT_ESTIMATE);
  return { left, top };
};

export const TourOverlay = () => {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect>();
  const step = TOUR_STEPS[index];
  const close = () => void endTour();
  useEffect(() => {
    const wasContextPanelOpen = useSettings.getState().settings.isContextPanelOpen;
    return () => useSettings.getState().update("isContextPanelOpen", wasContextPanelOpen);
  }, []);
  useEffect(() => {
    prepareStep(step);
    const measure = () => setRect(tourTargetOf(step)?.getBoundingClientRect());
    measure();
    const timer = setInterval(measure, TARGET_POLL_MS);
    return () => clearInterval(timer);
  }, [step]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const isLast = index === TOUR_STEPS.length - 1;
  return (
    <div className="tour-layer" role="dialog" aria-label="Tour">
      {rect && <div className="tour-spotlight" style={{ left: rect.left - SPOTLIGHT_PADDING, top: rect.top - SPOTLIGHT_PADDING, width: rect.width + 2 * SPOTLIGHT_PADDING, height: rect.height + 2 * SPOTLIGHT_PADDING }} />}
      <div className="tour-card" style={{ width: CARD_WIDTH, ...cardPositionOf(rect) }}>
        <strong>{step.title}</strong>
        <p>{step.body}</p>
        <div className="dialog-actions">
          <span className="muted tour-progress">{index + 1} / {TOUR_STEPS.length}</span>
          {!isLast && <button onClick={close}>Skip</button>}
          <button disabled={index === 0} onClick={() => setIndex(index - 1)}>Back</button>
          <button className="primary" onClick={isLast ? close : () => setIndex(index + 1)}>{isLast ? "Finish" : "Next"}</button>
        </div>
      </div>
    </div>
  );
};
