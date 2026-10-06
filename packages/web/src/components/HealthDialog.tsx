import { useCallback, useEffect, useState } from "react";
import { fetchHealth, fetchLogs, type RuntimeHealth } from "../api";
import { useBoard } from "../store";
import { IconRow } from "./Icons";

type Tab = "runtimes" | "logs";

const yesNo = (value: boolean | undefined): string => (value === undefined ? "unknown" : value ? "yes" : "no");

const RuntimeCard = ({ entry }: { entry: RuntimeHealth }) => (
  <section className="health-card">
    <header>
      <strong>{entry.id}</strong>
      <span className={`health ${entry.isOk ? "ok" : "bad"}`}>{entry.isOk ? "ready" : "not ready"}</span>
    </header>
    <div>{entry.detail}</div>
    <dl>
      <dt>Project folder</dt>
      <dd>{entry.workspacePath}</dd>
      {entry.executable && (<><dt>Command</dt><dd>{entry.executable}</dd></>)}
      {entry.id === "claude" && (<><dt>Signed in</dt><dd>{yesNo(entry.isSignedIn)}{entry.authMethod ? ` (${entry.authMethod})` : ""}</dd></>)}
      {entry.processSlots && (<><dt>Processes</dt><dd>{entry.processSlots.active} of {entry.processSlots.limit} in use{entry.processSlots.waiting > 0 ? `, ${entry.processSlots.waiting} waiting for a slot` : ""}</dd></>)}
      {entry.supportsSubagentText !== undefined && (<><dt>Subagent text</dt><dd>{entry.supportsSubagentText ? "supported by this version" : "not supported by this version, subagent nodes stay empty"}</dd></>)}
      {entry.servers && (<><dt>Servers</dt><dd>{entry.servers.length === 0 ? "none started yet" : entry.servers.join(", ")}</dd></>)}
    </dl>
  </section>
);

const RuntimesTab = () => {
  const [state, setState] = useState<{ runtimes: RuntimeHealth[]; logFile: string | null }>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setState(await fetchHealth());
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <div className="health-body">
      {error && <div className="part-error">{error}</div>}
      {!state && !error && <div className="muted">Checking…</div>}
      {state?.runtimes.length === 0 && <div className="muted">No project uses OpenCode or the installed claude command yet.</div>}
      {state?.runtimes.map((entry) => <RuntimeCard key={`${entry.id}/${entry.workspacePath}`} entry={entry} />)}
      <button onClick={() => void load()}>Check again</button>
    </div>
  );
};

const LogsTab = () => {
  const boardId = useBoard((state) => state.board?.id);
  const [onlyThisBoard, setOnlyThisBoard] = useState(false);
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setLines((await fetchLogs(onlyThisBoard && boardId ? boardId : filter.trim() || undefined)).lines);
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [boardId, filter, onlyThisBoard]);
  useEffect(() => void load(), [load]);
  return (
    <div className="health-body">
      <div className="log-controls">
        <input value={filter} disabled={onlyThisBoard} placeholder="Filter lines, for example a node id or [claude]" onChange={(event) => setFilter(event.target.value)} />
        <label className="inline-check"><input type="checkbox" checked={onlyThisBoard} onChange={(event) => setOnlyThisBoard(event.target.checked)} /> This board only</label>
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div className="part-error">{error}</div>}
      {lines.length === 0 ? <div className="muted">No log lines yet. Logs are written to a file in the data folder and rotate at 1 MB.</div> : <pre className="log-view copyable">{lines.join("\n")}</pre>}
    </div>
  );
};

export const HealthDialog = ({ onClose }: { onClose: () => void }) => {
  const [tab, setTab] = useState<Tab>("runtimes");
  return (
    <div className="dialog-backdrop">
      <div className="dialog health-dialog">
        <h3><IconRow names={["health"]} /> Runtime health</h3>
        <nav className="tab-row">
          <button className={tab === "runtimes" ? "active" : ""} onClick={() => setTab("runtimes")}>Runtimes</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Logs</button>
        </nav>
        {tab === "runtimes" ? <RuntimesTab /> : <LogsTab />}
        <div className="dialog-actions"><button className="primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
};
