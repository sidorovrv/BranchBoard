import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icons";

export interface SettingChoice {
  value: string;
  label: string;
}

interface SettingFieldBase {
  label: string;
  description: string;
}

export type SettingField = SettingFieldBase &
  (
    | { kind: "toggle"; key: string }
    | { kind: "number"; key: string; min: number; max: number; step?: number; unit?: string }
    | { kind: "slider"; key: string; min: number; max: number; step: number; unit?: string }
    | { kind: "choice"; key: string; options: SettingChoice[] }
    | { kind: "checklist"; key: string; options: SettingChoice[] }
    | { kind: "custom"; control: ReactNode }
  );

export interface SettingsSection {
  id: string;
  label: string;
  icon?: IconName;
  summary?: string;
  navText?: string;
  isPinnedToBottom?: boolean;
}

interface SettingRowProps {
  label: string;
  description?: string;
  className?: string;
  isProblem?: boolean;
  children?: ReactNode;
}

export const SettingRow = ({ label, description, className, isProblem, children }: SettingRowProps) => (
  <div className={`setting-row${className ? ` ${className}` : ""}`}>
    <div className="setting-text">
      <div className="setting-label">{label}</div>
      {description && <div className={`setting-description${isProblem ? " is-problem" : ""}`}>{description}</div>}
    </div>
    {children && <div className="setting-control">{children}</div>}
  </div>
);

interface SwitchProps {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export const ToggleSwitch = ({ checked, label, disabled, onChange }: SwitchProps) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`setting-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
    <span className="setting-switch-thumb" />
  </button>
);

interface NumberInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label: string;
  disabled?: boolean;
  onCommit: (draft: string) => void;
}

export const NumberInput = ({ value, min, max, step, unit, label, disabled, onCommit }: NumberInputProps) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => onCommit(draft);
  return (
    <span className="setting-number">
      <input type="number" min={min} max={max} step={step} value={draft} disabled={disabled} aria-label={label} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => event.key === "Enter" && commit()} />
      {unit && <span className="muted">{unit}</span>}
    </span>
  );
};

interface SliderInputProps {
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  label: string;
  onChange: (value: string) => void;
}

export const SliderInput = ({ value, min, max, step, unit, label, onChange }: SliderInputProps) => (
  <span className="setting-slider">
    <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(event) => onChange(event.target.value)} />
    <span className="muted">
      {value}
      {unit}
    </span>
  </span>
);

interface SegmentedProps {
  value: string;
  label: string;
  options: SettingChoice[];
  onChange: (value: string) => void;
}

export const SegmentedControl = ({ value, label, options, onChange }: SegmentedProps) => (
  <div className="setting-segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => (
      <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className={option.value === value ? "active" : ""} onClick={() => onChange(option.value)}>
        {option.label}
      </button>
    ))}
  </div>
);

interface ChecklistProps {
  selected: string[];
  label: string;
  options: SettingChoice[];
  onChange: (selected: string[]) => void;
}

export const ChecklistInput = ({ selected, label, options, onChange }: ChecklistProps) => (
  <div className="setting-checklist" role="group" aria-label={label}>
    {options.map((option) => (
      <label key={option.value}>
        <input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...selected, option.value] : selected.filter((value) => value !== option.value))} />
        {option.label}
      </label>
    ))}
  </div>
);

interface FieldControlProps {
  field: SettingField;
  values: object;
  onChange: (key: string, value: unknown) => void;
}

const FieldControl = ({ field, values, onChange }: FieldControlProps) => {
  if (field.kind === "custom") return <>{field.control}</>;
  const value = (values as Record<string, unknown>)[field.key];
  const set = (next: unknown) => onChange(field.key, next);
  switch (field.kind) {
    case "toggle":
      return <ToggleSwitch checked={Boolean(value)} label={field.label} onChange={set} />;
    case "number":
      return <NumberInput value={Number(value)} min={field.min} max={field.max} step={field.step} unit={field.unit} label={field.label} onCommit={set} />;
    case "slider":
      return <SliderInput value={Number(value)} min={field.min} max={field.max} step={field.step} unit={field.unit} label={field.label} onChange={set} />;
    case "choice":
      return <SegmentedControl value={String(value)} label={field.label} options={field.options} onChange={set} />;
    case "checklist":
      return <ChecklistInput selected={value as string[]} label={field.label} options={field.options} onChange={set} />;
  }
};

interface SettingFieldsProps {
  fields: SettingField[];
  values: object;
  onChange: (key: string, value: unknown) => void;
}

export const SettingFields = ({ fields, values, onChange }: SettingFieldsProps) => (
  <>
    {fields.map((field) => (
      <SettingRow key={field.label} label={field.label} description={field.description}>
        <FieldControl field={field} values={values} onChange={onChange} />
      </SettingRow>
    ))}
  </>
);

interface SettingsResetAction {
  label: string;
  title: string;
  confirmation: string;
  onReset: () => void;
}

interface SettingsDialogProps {
  title: string;
  closeLabel: string;
  sections: SettingsSection[];
  initialSectionId: string;
  reset: SettingsResetAction;
  onClose: () => void;
  children: (section: SettingsSection) => ReactNode;
}

const NavButton = ({ section, isActive, onSelect }: { section: SettingsSection; isActive: boolean; onSelect: () => void }) =>
  section.isPinnedToBottom ? (
    <button className={`settings-pinned${isActive ? " active" : ""}`} aria-current={isActive} onClick={onSelect} title={section.label}>
      {section.navText ?? section.label}
    </button>
  ) : (
    <button className={isActive ? "active" : ""} aria-current={isActive} onClick={onSelect}>
      {section.icon && <Icon name={section.icon} />}
      {section.label}
    </button>
  );

export const SettingsDialog = ({ title, closeLabel, sections, initialSectionId, reset, onClose, children }: SettingsDialogProps) => {
  const [sectionId, setSectionId] = useState(initialSectionId);
  const section = sections.find((candidate) => candidate.id === sectionId) ?? sections[0];
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  if (!section) return null;
  const navButtons = (isPinned: boolean) =>
    sections
      .filter((candidate) => Boolean(candidate.isPinnedToBottom) === isPinned)
      .map((candidate) => <NavButton key={candidate.id} section={candidate} isActive={candidate.id === section.id} onSelect={() => setSectionId(candidate.id)} />);
  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings-dialog" role="dialog" aria-label={title}>
        <nav className="settings-nav" aria-label={title}>
          <h3>{title}</h3>
          {navButtons(false)}
          <span className="spacer" />
          {navButtons(true)}
          <button className="settings-reset" onClick={() => confirm(reset.confirmation) && reset.onReset()} title={reset.title}>
            {reset.label}
          </button>
        </nav>
        <div className="settings-content">
          <header className="settings-header">
            <div>
              <h4>{section.label}</h4>
              {section.summary && <div className="settings-summary">{section.summary}</div>}
            </div>
            <button className="icon-button" onClick={onClose} title={`${closeLabel} (Esc)`} aria-label={closeLabel}>
              <Icon name="close" />
            </button>
          </header>
          <div className="settings-fields">
            <div className="settings-group">{children(section)}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
