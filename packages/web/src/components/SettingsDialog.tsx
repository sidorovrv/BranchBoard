import { useEffect, useState, type ReactElement } from "react";
import {
  BINDABLE_ACTIONS,
  NODE_MAX_HEIGHT,
  NODE_MAX_WIDTH,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
  RUNTIMES,
  RUNTIME_DEFAULT_PERMISSION_MODE,
  RUNTIME_IDS,
  bindingProblem,
  clickBindingOf,
  holdBindingOf,
  environmentTextOf,
  describeUpdateStatus,
  formatAgo,
  releaseNotesUrl,
  thirdPartyNoticesUrl,
  updateCommand,
  isApiRuntime,
  telemetryTiles,
  isDefaultBinding,
  isSidePointerButton,
  keyBindingOf,
  modifiersOfBinding,
  sharedBindingOwners,
  type BindableAction,
  type BindingKind,
  type Keybinds,
  type RuntimeId,
  type RuntimePanel,
} from "@branchboard/core";
import { useAbout } from "../aboutStore";
import { fetchRuntimePanels, runPanelAction } from "../api";
import { shortcutCapture } from "../actions";
import { displayBinding, displayModifier, displayShortcuts } from "../platform";
import { ACTIVE_JOBS_SHOWN_MAX, ALT_CLICK_ZOOM_MAX, BOARD_MEMORY_MINUTES_MAX, ALT_CLICK_ZOOM_MIN, KEYBOARD_PAN_SPEED_MAX, KEYBOARD_PAN_SPEED_MIN, NODE_TAGS, useSettings } from "../settings";
import { copyText, sendBoardCommand, useBoard } from "../store";
import { ChipSelect } from "../kit/ChipSelect";
import { Icon } from "../kit/Icons";
import { NumberInput, SettingFields, SettingRow, SettingsDialog as KitSettingsDialog, ToggleSwitch, type SettingField, type SettingsSection } from "../kit/Settings";
import { CredentialForm, ServerAddressForm, useRuntimeCatalog } from "./SetupGuide";
import { useTelemetry } from "../telemetryStore";
import { TelemetryTiles } from "./TelemetryTiles";
import { copyUpdateCommand } from "./UpdateBanner";

interface BoardSettingsSection extends SettingsSection {
  fields: SettingField[];
  Editor?: () => ReactElement;
}

const DEFAULT_SHARE_PERCENT = 60;
const BUDGET_TOKENS_MAX = 1_000_000_000;

const CAPTURE_PROMPTS: Record<BindingKind, string> = {
  key: "Press a key or key combination, or a mouse button (middle, 4 or 5). Esc cancels.",
  click: `Press a mouse button (middle, 4 or 5), or hold ${displayModifier("Alt")}, ${displayModifier("Ctrl")} or Shift and click. Esc cancels.`,
  hold: `Hold ${displayModifier("Alt")}, ${displayModifier("Ctrl")}, Shift or a combination of them, then release. Esc cancels.`,
};

const ShortcutRow = ({ action, keybinds }: { action: BindableAction; keybinds: Keybinds }) => {
  const update = useSettings((state) => state.update);
  const [isCapturing, setIsCapturing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const bindings = keybinds[action.id] ?? [];
  const shared = sharedBindingOwners(keybinds, action.id);
  const hasConflict = Object.keys(shared).length > 0;
  const setBindings = (next: string[]) => update("keybinds", { ...keybinds, [action.id]: next });

  useEffect(() => {
    if (!isCapturing) return;
    const accept = (binding: string) => {
      const issue = bindingProblem(keybinds, action.id, binding);
      setProblem(issue && displayShortcuts(issue));
      if (issue) return;
      setBindings([...bindings, binding]);
      setIsCapturing(false);
    };
    let heldPeak = "";
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return setIsCapturing(false);
      if (action.kind === "hold") {
        const held = holdBindingOf(event);
        if (held.length > heldPeak.length) heldPeak = held;
        return;
      }
      const binding = action.kind === "key" ? keyBindingOf(event) : undefined;
      if (binding) accept(binding);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (action.kind !== "hold" || !heldPeak) return;
      event.preventDefault();
      event.stopPropagation();
      accept(heldPeak);
    };
    const onClick = (event: MouseEvent) => {
      if (action.kind !== "click") return setIsCapturing(false);
      event.preventDefault();
      event.stopPropagation();
      const binding = clickBindingOf(event);
      if (binding && modifiersOfBinding(binding).length === 0) return setProblem(`A plain left click needs ${displayModifier("Alt")}, ${displayModifier("Ctrl")} or Shift held`);
      if (binding) accept(binding);
    };
    const onSideButton = (event: MouseEvent) => {
      if (action.kind === "hold" || !isSidePointerButton(event.button)) return;
      event.preventDefault();
      event.stopPropagation();
      const binding = clickBindingOf(event);
      if (binding && event.type === "mousedown") accept(binding);
    };
    shortcutCapture.isActive = true;
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("mousedown", onSideButton, true);
    window.addEventListener("mouseup", onSideButton, true);
    window.addEventListener("auxclick", onSideButton, true);
    return () => {
      shortcutCapture.isActive = false;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("mousedown", onSideButton, true);
      window.removeEventListener("mouseup", onSideButton, true);
      window.removeEventListener("auxclick", onSideButton, true);
    };
  }, [isCapturing, keybinds, action]);

  const startCapture = () => {
    setProblem(undefined);
    setIsCapturing(!isCapturing);
  };
  const conflictText = Object.entries(shared).map(([binding, labels]) => `${displayBinding(binding)} is also used by ${labels.map((label) => `“${label}”`).join(", ")}`).join(". ");
  const description = problem ?? (isCapturing ? CAPTURE_PROMPTS[action.kind] : conflictText || (bindings.length === 0 ? "No shortcut set" : ""));
  return (
    <SettingRow label={action.label} description={description} className={`shortcut-row${hasConflict ? " has-conflict" : ""}`} isProblem={Boolean(problem) || (hasConflict && !isCapturing)}>
      <div className="shortcut-control">
        {bindings.map((binding) => (
          <span key={binding} className="shortcut-chip">
            <kbd>{displayBinding(binding)}</kbd>
            <button type="button" onClick={() => setBindings(bindings.filter((candidate) => candidate !== binding))} title={`Remove ${displayBinding(binding)}`} aria-label={`Remove ${displayBinding(binding)}`}><Icon name="close" /></button>
          </span>
        ))}
        <button type="button" className={`shortcut-add${isCapturing ? " is-capturing" : ""}`} onClick={startCapture}>
          {isCapturing ? "Listening…" : <><Icon name="plus" />Add</>}
        </button>
        {!isDefaultBinding(keybinds, action.id) && <button type="button" className="shortcut-reset" onClick={() => setBindings(action.defaults)} title="Restore the default shortcuts">Reset</button>}
      </div>
    </SettingRow>
  );
};

const ShortcutsEditor = () => {
  const keybinds = useSettings((state) => state.settings.keybinds);
  return <>{BINDABLE_ACTIONS.map((action) => <ShortcutRow key={action.id} action={action} keybinds={keybinds} />)}</>;
};

const TelemetrySettings = ({ isOffline }: { isOffline: boolean }) => {
  const overview = useTelemetry((state) => state.overview);
  const { load, setConsent } = useTelemetry.getState();
  const [isPreviewShown, setIsPreviewShown] = useState(false);
  useEffect(() => void load(), [load]);
  if (!overview) return null;
  const copyPath = () => void copyText(overview.sentLogPath);
  return (
    <>
      <SettingRow label="Send aggregated anonymous telemetry" description={`Counts of runs, nodes and boards, sent once a day.${isOffline ? " Telemetry is off because Branchboard was started with --offline." : ""}`}>
        <ToggleSwitch checked={overview.consent === "granted"} label="Send aggregated anonymous telemetry" onChange={(isGranted) => void setConsent(isGranted)} />
      </SettingRow>
      <SettingRow label="Show what is sent" description="The counts for today so far.">
        <button onClick={() => setIsPreviewShown(!isPreviewShown)}>{isPreviewShown ? "Hide" : "Show"}</button>
      </SettingRow>
      {isPreviewShown && <div className="telemetry-preview"><TelemetryTiles tiles={telemetryTiles(overview.preview)} /></div>}
      <SettingRow label="Log of sent counts" description={overview.sentLogPath}>
        <button onClick={copyPath}>Copy path</button>
      </SettingRow>
    </>
  );
};

const UpdatesEditor = () => {
  const { about, isChecking, load } = useAbout();
  useEffect(() => void load(), [load]);
  if (!about) return <SettingRow label="Version" description="Loading…" />;
  const checked = about.checkedAt ? `Last checked ${formatAgo(Date.now() - about.checkedAt)}.` : "Not checked yet.";
  const version = about.update?.version ?? about.installedVersion;
  return (
    <>
      <SettingRow label={`Branchboard v${about.version}`} description={describeUpdateStatus(about)}>
        {version && <a href={releaseNotesUrl(version)} target="_blank" rel="noreferrer">Release notes</a>}
      </SettingRow>
      <SettingRow label="Third-party licences" description="The Anthropic and OpenAI runtimes download and run OpenCode (MIT).">
        <a href={thirdPartyNoticesUrl(about.version)} target="_blank" rel="noreferrer">Show notices</a>
      </SettingRow>
      <SettingRow label="Check for updates" description={`${checked}${about.checkError ? ` The last check failed: ${about.checkError}.` : ""}`}>
        <button disabled={isChecking || about.isOffline} onClick={() => void load(true)}>{isChecking ? "Checking…" : "Check now"}</button>
      </SettingRow>
      <SettingRow label="How to update" description="Run the command in a terminal, then restart Branchboard.">
        <button onClick={() => copyUpdateCommand(version ?? "latest")} title={updateCommand(version ?? "latest")}>Copy update command</button>
      </SettingRow>
      <TelemetrySettings isOffline={about.isOffline} />
    </>
  );
};

const API_RUNTIME_IDS = RUNTIME_IDS.filter(isApiRuntime);

const KeyEntry = ({ runtimeId }: { runtimeId: RuntimeId }) => {
  const { catalog, refresh } = useRuntimeCatalog(runtimeId);
  const status = catalog?.credential;
  return (
    <div className="key-entry">
      <div className="key-entry-header">
        <div className="setting-label">{RUNTIMES[runtimeId].label}</div>
        {catalog && <span className={`key-status ${catalog.health.ok ? "is-ready" : ""}`}>{catalog.health.ok ? "Ready" : status?.saved ? "Not working" : "No key"}</span>}
      </div>
      <CredentialForm runtimeId={runtimeId} catalog={catalog} refresh={refresh} />
    </div>
  );
};

const KeysEditor = () => (
  <>
    {API_RUNTIME_IDS.map((runtimeId) => <KeyEntry key={runtimeId} runtimeId={runtimeId} />)}
    <div className="key-entry">
      <div className="key-entry-header">
        <div className="setting-label">{RUNTIMES.opencode.label} server</div>
      </div>
      <ServerAddressForm runtimeId="opencode" />
    </div>
  </>
);

const RuntimePanelsEditor = () => {
  const board = useBoard((state) => state.board);
  const [panels, setPanels] = useState<RuntimePanel[]>();
  const [problem, setProblem] = useState<string>();
  const load = () => {
    if (!board) return;
    fetchRuntimePanels(board.id, board.mode).then(
      (loaded) => (setPanels(loaded), setProblem(undefined)),
      (error) => (setPanels(undefined), setProblem(error instanceof Error ? error.message : String(error))),
    );
  };
  useEffect(load, [board?.id, board?.mode]);
  const act = (panelId: string, rowId: string, actionId: string) =>
    runPanelAction(board!.id, board!.mode, panelId, rowId, actionId).then(load, (error) => setProblem(error instanceof Error ? error.message : String(error)));
  if (!board) return <SettingRow label="Runtime details" description="Open a board to see the details of its runtime." />;
  if (problem) return <SettingRow label="Runtime details" description={problem} />;
  if (!panels) return <SettingRow label="Runtime details" description="Loading…" />;
  return (
    <>
      {panels.map((panel) => (
        <div key={panel.id} className="panel-group">
          <div className="setting-label">{panel.title}</div>
          {panel.hint && <div className="setting-description">{panel.hint}</div>}
          {panel.rows.length === 0 && <div className="setting-description">{panel.empty}</div>}
          {panel.rows.map((row) => (
            <SettingRow key={row.id} label={row.label} description={row.detail ?? ""}>
              {row.actions?.map((action) => <button key={action.id} onClick={() => void act(panel.id, row.id, action.id)}>{action.label}</button>)}
            </SettingRow>
          ))}
        </div>
      ))}
    </>
  );
};

const ModelControl = ({ label }: { label: string }) => {
  const value = String(useSettings((state) => state.settings.defaultModel));
  const update = useSettings((state) => state.update);
  const models = useBoard((state) => state.catalog?.models) ?? [];
  const options = models.some((model) => model.id === value) ? models : [{ id: value, name: value }, ...models];
  return <ChipSelect icon="model" title={label} value={value} options={options.map((model) => ({ value: model.id, label: model.name }))} onChange={(next) => update("defaultModel", next)} />;
};

const PermissionModeControl = ({ label }: { label: string }) => {
  const value = String(useSettings((state) => state.settings.defaultPermissionMode));
  const update = useSettings((state) => state.update);
  const catalog = useBoard((state) => state.catalog);
  const defaultMode = catalog?.permissionModes?.find((mode) => mode.id === catalog.defaultPermissionMode);
  const runtimeDefault = { value: RUNTIME_DEFAULT_PERMISSION_MODE, label: defaultMode ? `Runtime default (${defaultMode.name})` : "Runtime default" };
  const options = [runtimeDefault, ...(catalog?.permissionModes ?? []).map((mode) => ({ value: mode.id, label: mode.name }))];
  const shown = options.some((option) => option.value === value) ? value : RUNTIME_DEFAULT_PERMISSION_MODE;
  return <ChipSelect icon="permission" title={label} value={shown} options={options} onChange={(next) => update("defaultPermissionMode", next)} />;
};

const BoardToggleControl = ({ label }: { label: string }) => {
  const board = useBoard((state) => state.board);
  return <ToggleSwitch checked={board?.answerFormatsGuide !== false} label={label} disabled={!board} onChange={(checked) => void sendBoardCommand({ type: "updateBoard", answerFormatsGuide: checked })} />;
};

const BoardShareControl = ({ label }: { label: string }) => {
  const board = useBoard((state) => state.board);
  const percent = Math.round((board?.summaryShare ?? DEFAULT_SHARE_PERCENT / 100) * 100);
  const commit = (draft: string) => void sendBoardCommand({ type: "updateBoard", summaryShare: Math.min(100, Math.max(0, Number(draft) || 0)) / 100 });
  return <NumberInput value={percent} min={0} max={100} unit="% of window" label={label} disabled={!board} onCommit={commit} />;
};

const BoardBudgetControl = ({ label }: { label: string }) => {
  const board = useBoard((state) => state.board);
  const commit = (draft: string) => void sendBoardCommand({ type: "updateBoard", budgetTokens: Math.min(BUDGET_TOKENS_MAX, Math.max(0, Number(draft) || 0)) });
  return <NumberInput value={board?.budgetTokens ?? 0} min={0} max={BUDGET_TOKENS_MAX} step={10000} unit="tokens" label={label} disabled={!board} onCommit={commit} />;
};

const BoardEnvironmentControl = ({ label }: { label: string }) => {
  const board = useBoard((state) => state.board);
  const saved = environmentTextOf(board?.environment);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved, board?.id]);
  return (
    <textarea
      className="environment-input"
      rows={4}
      value={draft}
      disabled={!board}
      placeholder="NAME=value"
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== saved && void sendBoardCommand({ type: "updateBoard", environment: draft })}
    />
  );
};

const SECTIONS: BoardSettingsSection[] = [
  {
    id: "ai",
    label: "AI",
    icon: "psychology",
    summary: "Defaults for new chats.",
    fields: [
      { kind: "custom", label: "Default model", description: "Model preselected for new chats. Replies and branches use their parent's model.", control: <ModelControl label="Default model" /> },
      { kind: "custom", label: "Default permission mode", description: "Permission mode preselected for new chats. Replies and branches use their parent's mode.", control: <PermissionModeControl label="Default permission mode" /> },
      { key: "agentDiagnosticsAccess", kind: "toggle", label: "Agent access to Branchboard diagnostics", description: "Claude runs can read Branchboard's models, runtime health, settings, logs and runs through the branchboard_diagnostics tool, and get a one-line system note about it." },
      { key: "agentCrossNodeLogs", kind: "toggle", label: "Agent access to other nodes' results through the logs", description: "The runs section of the diagnostics tool includes the run logs of every board and node. When off, it returns only the records of the calling node." },
    ],
  },
  {
    id: "boards",
    label: "Boards",
    icon: "dashboard",
    summary: "Board switching and settings of the open board.",
    fields: [
      { key: "boardMemoryMinutes", kind: "number", label: "Keep inactive boards loaded", description: "Minutes a board you switched away from stays loaded in this browser tab, so switching back to it is instant. 0 loads every board again on each switch.", min: 0, max: BOARD_MEMORY_MINUTES_MAX, unit: "min" },
      { kind: "custom", label: "Summarise long context", description: "Summarise earlier turns before a run when the re-sent context exceeds this share of the model window. 0 turns it off.", control: <BoardShareControl label="Summarise long context" /> },
      { kind: "custom", label: "Token budget", description: "New runs on this board are refused once its runs used this many tokens. Running ones finish. 0 turns it off.", control: <BoardBudgetControl label="Token budget" /> },
      { kind: "custom", label: "Environment variables", description: "One NAME=value per line, passed to OpenCode shell commands.", control: <BoardEnvironmentControl label="Environment variables" /> },
      { kind: "custom", label: "Tell agents about charts and tables", description: "Add a system note of about 350 tokens to every run that explains chart, table and file-link blocks.", control: <BoardToggleControl label="Tell agents about charts and tables" /> },
    ],
    Editor: RuntimePanelsEditor,
  },
  {
    id: "keys",
    label: "Models",
    icon: "key",
    summary: "API keys and the OpenCode server.",
    fields: [],
    Editor: KeysEditor,
  },
  {
    id: "nodes",
    label: "Nodes",
    icon: "tune",
    summary: "Node creation, layout and behaviour.",
    fields: [
      {
        key: "flowDirection",
        kind: "choice",
        label: "Flow direction",
        description: "Sides of a node that show connection points.",
        options: [
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
        ],
      },
      {
        key: "subagentDisplay",
        kind: "choice",
        label: "Subagents",
        description: "Show each subagent as its own node or inside the turn's card.",
        options: [
          { value: "node", label: "Own node" },
          { value: "inline", label: "Inline" },
        ],
      },
      { key: "defaultNodeWidth", kind: "number", label: "Default width", description: "Width of new top-level nodes.", min: NODE_MIN_WIDTH, max: NODE_MAX_WIDTH, unit: "px" },
      { key: "defaultNodeHeight", kind: "number", label: "Default height", description: "Height of new top-level nodes.", min: NODE_MIN_HEIGHT, max: NODE_MAX_HEIGHT, unit: "px" },
      { key: "snapNextPrompt", kind: "toggle", label: "Snap on Next Prompt", description: "Place “Next prompt…” nodes directly below their parent." },
      { key: "followScroll", kind: "toggle", label: "Follow streaming answers", description: "Keep streaming answers scrolled to the bottom." },
      { key: "blinkForAttention", kind: "toggle", label: "Blink nodes that need an answer", description: "Blink nodes that wait for a question or permission on the minimap and when zoomed out." },
    ],
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: "keyboard",
    summary: "Keyboard movement, click zoom and the shortcut for each action. Each action accepts several shortcuts. Shared shortcuts are highlighted.",
    fields: [
      {
        key: "keyboardPan",
        kind: "choice",
        label: "Move the board with the keyboard",
        description: "Pan the board with held keys while no text box is focused.",
        options: [
          { value: "none", label: "Off" },
          { value: "wasd", label: "W A S D" },
          { value: "arrows", label: "Arrow keys" },
        ],
      },
      { key: "keyboardPanSpeed", kind: "slider", label: "Keyboard movement speed", description: "100% is about 900 pixels per second.", min: KEYBOARD_PAN_SPEED_MIN, max: KEYBOARD_PAN_SPEED_MAX, step: 5, unit: "%" },
      { key: "altClickZoom", kind: "slider", label: `${displayModifier("Alt")}-click zoom`, description: `Share of the screen a node fills after ${displayModifier("Alt")}-click.`, min: ALT_CLICK_ZOOM_MIN, max: ALT_CLICK_ZOOM_MAX, step: 5, unit: "%" },
    ],
    Editor: ShortcutsEditor,
  },
  {
    id: "topbar",
    label: "Top bar",
    icon: "health",
    summary: "Contents of the top bar.",
    fields: [
      { key: "showTopbarMeters", kind: "toggle", label: "Show limits and cost", description: "Show usage limits (Claude) or the cost of the last hour (OpenCode) next to the save status." },
      { key: "activeJobsShown", kind: "number", label: "Active jobs shown", description: "Runs listed at once in the active jobs list. 0 hides the list.", min: 0, max: ACTIVE_JOBS_SHOWN_MAX, unit: "jobs" },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: "palette",
    summary: "Colours, typefaces, tool calls, cost and node tags.",
    fields: [
      {
        key: "theme",
        kind: "choice",
        label: "Theme",
        description: "Colour scheme.",
        options: [
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ],
      },
      {
        key: "answerFont",
        kind: "choice",
        label: "Answer font",
        description: "Typeface of answers.",
        options: [
          { value: "sans", label: "Sans" },
          { value: "serif", label: "Serif" },
        ],
      },
      { key: "groupToolCalls", kind: "toggle", label: "Group tool calls", description: "Fold all tool calls between two text outputs into one line, for example “Read 3 files, ran a command”." },
      { key: "showClaudeCost", kind: "toggle", label: "Show Claude CLI cost", description: "Show the cost tag on Claude CLI nodes. The cost is an estimate at API prices." },
      { key: "shownTags", kind: "checklist", label: "Node tags", description: "Tags shown in the header of a node.", options: NODE_TAGS.map((tag) => ({ value: tag.id, label: tag.label })) },
    ],
  },
  {
    id: "updates",
    label: "Version and updates",
    icon: "update",
    summary: "Installed version and updates.",
    fields: [],
    Editor: UpdatesEditor,
    isPinnedToBottom: true,
  },
];

const RESET = {
  label: "Reset to defaults",
  title: "Restore every setting to its default",
  confirmation: "Restore every setting, including shortcuts, to its default?",
};

export const SettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const settings = useSettings((state) => state.settings);
  const update = useSettings((state) => state.update);
  const reset = useSettings((state) => state.reset);
  const version = useAbout((state) => state.about?.version);
  const sections = SECTIONS.map((section) => (section.isPinnedToBottom && version ? { ...section, navText: `Version ${version}` } : section));
  return (
    <KitSettingsDialog title="Settings" closeLabel="Close" sections={sections} initialSectionId={useBoard.getState().settingsSectionId ?? SECTIONS[0].id} reset={{ ...RESET, onReset: reset }} onClose={onClose}>
      {(section) => {
        const { fields, Editor } = SECTIONS.find((candidate) => candidate.id === section.id) ?? SECTIONS[0];
        return (
          <>
            <SettingFields fields={fields} values={settings} onChange={(key, value) => update(key as keyof typeof settings, value)} />
            {Editor && <Editor />}
          </>
        );
      }}
    </KitSettingsDialog>
  );
};
