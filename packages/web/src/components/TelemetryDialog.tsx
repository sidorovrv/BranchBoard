import { useEffect } from "react";
import { telemetryTiles, usageStatisticsUrl, type ConsentChoice } from "@branchboard/core";
import { useBoard } from "../store";
import { useTelemetry } from "../telemetryStore";
import { Icon } from "../kit/Icons";
import { TelemetryTiles } from "./TelemetryTiles";

const OTHER_LAYERS = ".dialog-backdrop, .settings-backdrop, .image-overlay";

const STATUS_LABELS = { granted: "Sharing is on", declined: "Sharing is off", undecided: "No choice made yet" };

const finishedKeyOf = (runs: ReturnType<typeof useBoard.getState>["finishedRuns"]): string => `${runs.length}:${runs[0]?.nodeId}:${runs[0]?.completedAt}`;

export const TelemetryDialog = () => {
  const overview = useTelemetry((state) => state.overview);
  const { load, setConsent, setDialogOpen, dismissDialog } = useTelemetry.getState();
  const isShown = useTelemetry((state) => state.isDialogOpen);
  const isAskDismissed = useTelemetry((state) => state.isAskDismissed);
  const finishedKey = useBoard((state) => finishedKeyOf(state.finishedRuns));
  const isOtherDialogOpen = useBoard((state) => state.isSettingsOpen || state.isShortcutsOpen || state.isTourOpen);
  useEffect(() => void load(), [load, finishedKey]);
  useEffect(() => {
    if (!isShown && !isAskDismissed && overview?.shouldAsk && !isOtherDialogOpen && !document.querySelector(OTHER_LAYERS)) setDialogOpen(true);
  }, [overview, isOtherDialogOpen, isShown, isAskDismissed, setDialogOpen]);
  if (!isShown || !overview) return null;
  const consent: ConsentChoice | null = overview.consent;
  const status = consent ?? "undecided";
  const choose = (isGranted: boolean) => {
    dismissDialog();
    void setConsent(isGranted);
  };
  return (
    <div className="dialog-backdrop">
      <div className="dialog telemetry-dialog" role="dialog" aria-modal="true" aria-labelledby="telemetry-title">
        <div className="telemetry-header">
          <h3 id="telemetry-title">Telemetry</h3>
          <span className={`key-status${consent === "granted" ? " is-ready" : ""}`}>{STATUS_LABELS[status]}</span>
          <button className="icon-button" onClick={dismissDialog} aria-label="Close" title="Close"><Icon name="close" /></button>
        </div>
        <div className="telemetry-body">
          <div className="telemetry-intro">Send these counts once a day to help decide what to improve in Branchboard.</div>
          <TelemetryTiles tiles={telemetryTiles(overview.preview)} />
        </div>
        <div className="telemetry-footer">
          <div className="muted">
            The server does not log your IP address. Change this any time in Settings → Version and updates.{" "}
            <a href={usageStatisticsUrl(overview.preview.app.version)} target="_blank" rel="noreferrer">Read the full description</a>
          </div>
          <div className="telemetry-question">Share these usage statistics?</div>
          <div className="dialog-actions telemetry-actions">
            <button onClick={() => choose(false)}>Do not share</button>
            <button onClick={() => choose(true)}>Share usage statistics</button>
          </div>
        </div>
      </div>
    </div>
  );
};
