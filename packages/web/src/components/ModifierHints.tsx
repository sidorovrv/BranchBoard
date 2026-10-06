import { useEffect, useState } from "react";
import { BINDABLE_ACTIONS, keyOfBinding, modifiersOfBinding, type Keybinds } from "@branchboard/core";
import { displayModifier, isMacPlatform } from "../platform";
import { useSettings } from "../settings";

interface Hint {
  keys: string;
  text: string;
}

type GroupName = "Shift" | "Ctrl" | "Alt";

const GROUP_ORDER: GroupName[] = ["Ctrl", "Alt", "Shift"];

const SHIFT_HINTS: Hint[] = [
  { keys: "Click", text: "add to selection" },
  { keys: "Drag", text: "box-select nodes" },
  { keys: "Enter", text: "new line in a prompt" },
];

const CONTROL_HINTS: Hint[] = [
  { keys: "Click", text: "add to selection" },
  { keys: "A", text: "select all nodes" },
  { keys: "C / V", text: "copy / paste nodes" },
];

const ALT_HINTS: Hint[] = [{ keys: "Drag", text: "align and snap to other nodes" }];

const STATIC_HINTS: Record<GroupName, Hint[]> = { Shift: SHIFT_HINTS, Ctrl: CONTROL_HINTS, Alt: ALT_HINTS };

const boundHints = (keybinds: Keybinds, group: GroupName, held: GroupName[]): Hint[] =>
  BINDABLE_ACTIONS.flatMap((action) =>
    (keybinds[action.id] ?? [])
      .map((binding) => ({ modifiers: modifiersOfBinding(binding), keys: [...modifiersOfBinding(binding).slice(1), keyOfBinding(binding)].join("+"), text: action.label }))
      .filter(({ modifiers }) => modifiers[0] === group && modifiers.every((modifier) => held.includes(modifier as GroupName)))
      .map(({ keys, text }) => ({ keys: keys.split("+").map(displayModifier).join("+"), text })),
  );

const HintGroup = ({ title, hints }: { title: string; hints: Hint[] }) => (
  <section>
    <h5>{displayModifier(title)}</h5>
    {hints.map((hint) => <div key={`${hint.keys}-${hint.text}`}>{hint.text}<kbd>{hint.keys}</kbd></div>)}
  </section>
);

export const ModifierHints = () => {
  const [held, setHeld] = useState({ shift: false, control: false, alt: false });
  const keybinds = useSettings((state) => state.settings.keybinds);
  useEffect(() => {
    const track = (event: KeyboardEvent) => setHeld({ shift: event.shiftKey, control: isMacPlatform ? event.metaKey : event.ctrlKey, alt: event.altKey });
    const release = () => setHeld({ shift: false, control: false, alt: false });
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", release);
    };
  }, []);
  const heldGroups = GROUP_ORDER.filter((group) => ({ Shift: held.shift, Ctrl: held.control, Alt: held.alt })[group]);
  if (heldGroups.length === 0) return null;
  return (
    <div className="modifier-hints" role="note">
      {heldGroups.map((group) => <HintGroup key={group} title={group} hints={[...STATIC_HINTS[group], ...boundHints(keybinds, group, heldGroups)]} />)}
    </div>
  );
};
