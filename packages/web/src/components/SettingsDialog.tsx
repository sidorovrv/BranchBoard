import { useEffect, useState, type ReactElement } from "react";
import {
  BINDABLE_ACTIONS,
  NODE_MAX_HEIGHT,
  NODE_MAX_WIDTH,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
  RUNTIME_DEFAULT_PERMISSION_MODE,
  bindingProblem,
  clickBindingOf,
  hasMultipleBindings,
  isDefaultBinding,
  isSidePointerButton,
  keyBindingOf,
  modifiersOfBinding,
  type BindableAction,
  type BindingKind,
  type Keybinds,
} from "@branchboard/core";
import { shortcutCapture } from "../actions";
import { displayBinding, displayModifier, displayShortcuts } from "../platform";
import { ACTIVE_JOBS_SHOWN_MAX, ALT_CLICK_ZOOM_MAX, ALT_CLICK_ZOOM_MIN, KEYBOARD_PAN_SPEED_MAX, KEYBOARD_PAN_SPEED_MIN, useSettings, type Settings } from "../settings";
import { sendBoardCommand, useBoard } from "../store";
import { ChipSelect } from "./ChipSelect";
import { Icon, type IconName } from "./Icons";

interface FieldBase {
  label: string;
  description: string;
}

interface ToggleField extends FieldBase {
  kind: "toggle";
  key: keyof Settings;
}

interface NumberField extends FieldBase {
  kind: "number";
  key: keyof Settings;
  min: number;
  max: number;
  unit: string;
}

interface SliderField extends FieldBase {
  kind: "slider";
  key: keyof Settings;
  min: number;
  max: number;
  step: number;
  unit: string;
}

interface ChoiceField extends FieldBase {
  kind: "choice";
  key: keyof Settings;
  options: { value: string; label: string }[];
}

interface ModelField extends FieldBase {
  kind: "model";
  key: keyof Settings;
}

interface PermissionModeField extends FieldBase {
  kind: "permissionMode";
  key: keyof Settings;
}

interface BoardToggleField extends FieldBase {
  kind: "boardToggle";
}

interface BoardShareField extends FieldBase {
  kind: "boardShare";
}

type SettingField = ToggleField | NumberField | SliderField | ChoiceField | ModelField | PermissionModeField | BoardToggleField | BoardShareField;

interface SettingsSection {
  id: string;
  label: string;
  icon: IconName;
  summary: string;
  fields: SettingField[];
  Editor?: () => ReactElement;
}

const DEFAULT_SHARE_PERCENT = 60;

const CAPTURE_PROMPTS: Record<BindingKind, string> = {
  key: "Press a key or key combination, or a mouse button (middle, 4 or 5). Esc cancels.",
  click: `Press a mouse button (middle, 4 or 5), or hold ${displayModifier("Alt")}, ${displayModifier("Ctrl")} or Shift and click. Esc cancels.`,
};

const ShortcutRow = ({ action, keybinds }: { action: BindableAction; keybinds: Keybinds }) => {
  const update = useSettings((state) => state.update);
  const [isCapturing, setIsCapturing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const bindings = keybinds[action.id] ?? [];
  const hasMultiple = hasMultipleBindings(keybinds, action.id);
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
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return setIsCapturing(false);
      const binding = action.kind === "key" ? keyBindingOf(event) : undefined;
      if (binding) accept(binding);
    };
    const onClick = (event: MouseEvent) => {
      if (action.kind === "key") return setIsCapturing(false);
      event.preventDefault();
      event.stopPropagation();
      const binding = clickBindingOf(event);
      if (binding && modifiersOfBinding(binding).length === 0) return setProblem(`A plain left click needs ${displayModifier("Alt")}, ${displayModifier("Ctrl")} or Shift held`);
      if (binding) accept(binding);
    };
    const onSideButton = (event: MouseEvent) => {
      if (!isSidePointerButton(event.button)) return;
      event.preventDefault();
      event.stopPropagation();
      const binding = clickBindingOf(event);
      if (binding && event.type === "mousedown") accept(binding);
    };
    shortcutCapture.isActive = true;
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("mousedown", onSideButton, true);
    window.addEventListener("mouseup", onSideButton, true);
    window.addEventListener("auxclick", onSideButton, true);
    return () => {
      shortcutCapture.isActive = false;
      window.removeEventListener("keydown", onKeyDown, true);
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
  const description = problem ?? (isCapturing ? CAPTURE_PROMPTS[action.kind] : bindings.length === 0 ? "No shortcut set" : "");
  return (
    <div className={`setting-row shortcut-row${hasMultiple ? " has-multiple" : ""}`}>
      <div className="setting-text">
        <div className="setting-label">
          {action.label}
          {hasMultiple && <span className="shortcut-badge">{bindings.length} shortcuts</span>}
        </div>
        {description && <div className={`setting-description${problem ? " is-problem" : ""}`}>{description}</div>}
      </div>
      <div className="setting-control shortcut-control">
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
    </div>
  );
};

const ShortcutsEditor = () => {
  const keybinds = useSettings((state) => state.settings.keybinds);
  return <>{BINDABLE_ACTIONS.map((action) => <ShortcutRow key={action.id} action={action} keybinds={keybinds} />)}</>;
};

const SECTIONS: SettingsSection[] = [
  {
    id: "ai",
    label: "AI",
    icon: "psychology",
    summary: "How new chats start and how long conversations are handled.",
    fields: [
      { key: "defaultModel", kind: "model", label: "Default model", description: "Preselected for new top-level chat nodes. Replies and branches keep their parent's model. A board whose runtime has no match keeps its own default." },
      { key: "defaultPermissionMode", kind: "permissionMode", label: "Default permission mode", description: "Preselected for new top-level chat nodes in runtimes that have permission modes (Claude). Runtime default is Accept edits: file edits in the project folder run without asking. Manual asks before every tool call; Auto and Don't ask run tools with little or no confirmation. Replies and branches keep their parent's mode." },
      { kind: "boardShare", label: "Summarise long context", description: "When the context that has to be re-sent passes this share of the model window, the biggest finished stretch of the conversation is summarised first. Applies to the open board. 0 turns it off." },
      { kind: "boardToggle", label: "Tell agents about charts and tables", description: "Adds a short system note (about 350 tokens) to every run so agents know how to write chart, table and file-link blocks. Applies to the open board." },
    ],
  },
  {
    id: "nodes",
    label: "Nodes",
    icon: "tune",
    summary: "How nodes are created and how they behave while working.",
    fields: [
      {
        key: "flowDirection",
        kind: "choice",
        label: "Preferred flow direction",
        description: "Which sides of a node show connection points. Nodes can be connected on every side; the other two sides only show a point while a wire uses them.",
        options: [
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
        ],
      },
      {
        key: "keyboardPan",
        kind: "choice",
        label: "Move the board with the keyboard",
        description: "Hold the keys to pan the board while no text box is focused. A key bound to an action in Shortcuts keeps that action.",
        options: [
          { value: "none", label: "Off" },
          { value: "wasd", label: "W A S D" },
          { value: "arrows", label: "Arrow keys" },
        ],
      },
      { key: "keyboardPanSpeed", kind: "slider", label: "Keyboard movement speed", description: "How fast the board moves while a movement key is held. 100% is about 900 pixels per second; up to 500%.", min: KEYBOARD_PAN_SPEED_MIN, max: KEYBOARD_PAN_SPEED_MAX, step: 5, unit: "%" },
      {
        key: "boardNavigation",
        kind: "choice",
        label: "Switching boards",
        description: "Use the list of projects and boards on the left, tabs in the top bar, or both.",
        options: [
          { value: "sidebar", label: "Left bar" },
          { value: "tabs", label: "Tabs" },
          { value: "both", label: "Both" },
        ],
      },
      {
        key: "subagentDisplay",
        kind: "choice",
        label: "Subagents",
        description: "Show each subagent a turn starts as its own node beside the turn, or inline inside the turn's card.",
        options: [
          { value: "node", label: "Own node" },
          { value: "inline", label: "Inline" },
        ],
      },
      { key: "defaultNodeWidth", kind: "number", label: "Default width", description: "For new top-level nodes. Nodes made from another node match that node.", min: NODE_MIN_WIDTH, max: NODE_MAX_WIDTH, unit: "px" },
      { key: "defaultNodeHeight", kind: "number", label: "Default height", description: "For new top-level nodes. Nodes made from another node match that node.", min: NODE_MIN_HEIGHT, max: NODE_MAX_HEIGHT, unit: "px" },
      { key: "altClickZoom", kind: "slider", label: `${displayModifier("Alt")}-click zoom`, description: `How much of the screen a node fills after ${displayModifier("Alt")}-clicking it. 100% fits the whole node edge to edge; lower leaves space around it.`, min: ALT_CLICK_ZOOM_MIN, max: ALT_CLICK_ZOOM_MAX, step: 5, unit: "%" },
      { key: "snapNextPrompt", kind: "toggle", label: "Snap on Next Prompt", description: "A node made with “Next prompt…” is placed directly below its parent. If that spot is taken, it goes further below, past the nodes already there." },
      { key: "followScroll", kind: "toggle", label: "Follow streaming answers", description: "Keep a streaming answer scrolled to the bottom. Scrolling up yourself pauses it until the next run." },
      { key: "groupToolCalls", kind: "toggle", label: "Group tool calls", description: "Fold each run of consecutive tool calls into one line such as “Read 3 files, ran a command”. Click it to see the individual calls." },
      { key: "blinkForAttention", kind: "toggle", label: "Blink nodes that need an answer", description: "On the minimap and when zoomed out, a node waiting for a question or permission blinks." },
    ],
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: "keyboard",
    summary: "Each action can have several shortcuts. Actions with more than one are highlighted.",
    fields: [],
    Editor: ShortcutsEditor,
  },
  {
    id: "topbar",
    label: "Top bar",
    icon: "health",
    summary: "What the bar above the board shows.",
    fields: [
      { key: "showTopbarMeters", kind: "toggle", label: "Show limits and cost", description: "The usage limit meters (Claude) or the cost of the last hour (OpenCode) next to the save status." },
      { key: "activeJobsShown", kind: "number", label: "Active jobs shown", description: "How many runs the jobs list in the board's top right corner shows at once; scroll for the rest. 0 hides the list completely.", min: 0, max: ACTIVE_JOBS_SHOWN_MAX, unit: "jobs" },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: "palette",
    summary: "Colours and typefaces.",
    fields: [
      {
        key: "theme",
        kind: "choice",
        label: "Theme",
        description: "Follow the system, or always use light or dark colours.",
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
        description: "The typeface of answers inside nodes. Code always uses JetBrains Mono.",
        options: [
          { value: "sans", label: "Sans" },
          { value: "serif", label: "Serif" },
        ],
      },
    ],
  },
];

const ToggleSwitch = ({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
    <span className="switch-thumb" />
  </button>
);

const ToggleControl = ({ field }: { field: ToggleField }) => {
  const value = useSettings((state) => state.settings[field.key]);
  const update = useSettings((state) => state.update);
  return <ToggleSwitch checked={Boolean(value)} label={field.label} onChange={(checked) => update(field.key, checked)} />;
};

const NumberInput = ({ value, min, max, unit, disabled, onCommit }: { value: number; min: number; max: number; unit: string; disabled?: boolean; onCommit: (draft: string) => void }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => onCommit(draft);
  return (
    <span className="number-control">
      <input type="number" min={min} max={max} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} />
      <span className="muted">{unit}</span>
    </span>
  );
};

const NumberControl = ({ field }: { field: NumberField }) => {
  const value = useSettings((state) => state.settings[field.key]);
  const update = useSettings((state) => state.update);
  return <NumberInput value={Number(value)} min={field.min} max={field.max} unit={field.unit} onCommit={(draft) => update(field.key, draft)} />;
};

const SliderControl = ({ field }: { field: SliderField }) => {
  const value = Number(useSettings((state) => state.settings[field.key]));
  const update = useSettings((state) => state.update);
  return (
    <span className="slider-control">
      <input type="range" min={field.min} max={field.max} step={field.step} value={value} aria-label={field.label} onChange={(event) => update(field.key, event.target.value)} />
      <span className="muted">{value}{field.unit}</span>
    </span>
  );
};

const ChoiceControl =({ field }: { field: ChoiceField }) => {
  const value = useSettings((state) => state.settings[field.key]);
  const update = useSettings((state) => state.update);
  return (
    <div className="segmented" role="radiogroup" aria-label={field.label}>
      {field.options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className={option.value === value ? "active" : ""} onClick={() => update(field.key, option.value)}>{option.label}</button>
      ))}
    </div>
  );
};

const ModelControl = ({ field }: { field: ModelField }) => {
  const value = String(useSettings((state) => state.settings[field.key]));
  const update = useSettings((state) => state.update);
  const models = useBoard((state) => state.catalog?.models) ?? [];
  const options = models.some((model) => model.id === value) ? models : [{ id: value, name: value }, ...models];
  return <ChipSelect icon="model" title={field.label} value={value} options={options.map((model) => ({ value: model.id, label: model.name }))} onChange={(next) => update(field.key, next)} />;
};

const PermissionModeControl = ({ field }: { field: PermissionModeField }) => {
  const value = String(useSettings((state) => state.settings[field.key]));
  const update = useSettings((state) => state.update);
  const catalog = useBoard((state) => state.catalog);
  const defaultMode = catalog?.permissionModes?.find((mode) => mode.id === catalog.defaultPermissionMode);
  const runtimeDefault = { value: RUNTIME_DEFAULT_PERMISSION_MODE, label: defaultMode ? `Runtime default (${defaultMode.name})` : "Runtime default" };
  const options = [runtimeDefault, ...(catalog?.permissionModes ?? []).map((mode) => ({ value: mode.id, label: mode.name }))];
  const shown = options.some((option) => option.value === value) ? value : RUNTIME_DEFAULT_PERMISSION_MODE;
  return <ChipSelect icon="permission" title={field.label} value={shown} options={options} onChange={(next) => update(field.key, next)} />;
};

const BoardToggleControl = ({ field }: { field: BoardToggleField }) => {
  const board = useBoard((state) => state.board);
  return <ToggleSwitch checked={board?.answerFormatsGuide !== false} label={field.label} disabled={!board} onChange={(checked) => void sendBoardCommand({ type: "updateBoard", answerFormatsGuide: checked })} />;
};

const BoardShareControl = () => {
  const board = useBoard((state) => state.board);
  const percent = Math.round((board?.summaryShare ?? DEFAULT_SHARE_PERCENT / 100) * 100);
  const commit = (draft: string) => void sendBoardCommand({ type: "updateBoard", summaryShare: Math.min(100, Math.max(0, Number(draft) || 0)) / 100 });
  return <NumberInput value={percent} min={0} max={100} unit="% of window" disabled={!board} onCommit={commit} />;
};

const CONTROLS: { [K in SettingField["kind"]]: (props: { field: Extract<SettingField, { kind: K }> }) => ReactElement } = {
  toggle: ToggleControl,
  number: NumberControl,
  slider: SliderControl,
  choice: ChoiceControl,
  model: ModelControl,
  permissionMode: PermissionModeControl,
  boardToggle: BoardToggleControl,
  boardShare: BoardShareControl,
};

const FieldRow = ({ field }: { field: SettingField }) => {
  const Control = CONTROLS[field.kind] as (props: { field: SettingField }) => ReactElement;
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{field.label}</div>
        <div className="setting-description">{field.description}</div>
      </div>
      <div className="setting-control"><Control field={field} /></div>
    </div>
  );
};

export const SettingsDialog = ({ onClose }: { onClose: () => void }) => {
  const [sectionId, setSectionId] = useState(SECTIONS[0].id);
  const reset = useSettings((state) => state.reset);
  const section = SECTIONS.find((candidate) => candidate.id === sectionId) ?? SECTIONS[0];
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-label="Settings">
        <nav className="settings-nav">
          <h3>Settings</h3>
          {SECTIONS.map((candidate) => (
            <button key={candidate.id} className={candidate.id === section.id ? "active" : ""} aria-current={candidate.id === section.id} onClick={() => setSectionId(candidate.id)}>
              <Icon name={candidate.icon} />
              {candidate.label}
            </button>
          ))}
          <span className="spacer" />
          <button className="settings-reset" onClick={reset} title="Restore every setting to its default">Reset to defaults</button>
        </nav>
        <div className="settings-content">
          <header className="settings-header">
            <div>
              <h4>{section.label}</h4>
              <div className="settings-summary">{section.summary}</div>
            </div>
            <button className="icon-button" onClick={onClose} title="Close (Esc)" aria-label="Close"><Icon name="close" /></button>
          </header>
          <div className="settings-fields">
            <div className="settings-group">
              {section.Editor ? <section.Editor /> : section.fields.map((field) => <FieldRow key={field.label} field={field} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
