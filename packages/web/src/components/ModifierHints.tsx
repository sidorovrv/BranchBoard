import { useEffect, useState } from "react";
import { BINDABLE_ACTIONS, FIXED_SHORTCUTS, keyOfBinding, modifiersOfBinding, type Keybinds } from "@branchboard/core";
import { displayModifier, isMacPlatform } from "../platform";
import { useSettings } from "../settings";

interface Hint {
  keys: string;
  text: string;
}

type GroupName = "Shift" | "Ctrl" | "Alt";

const GROUP_ORDER: GroupName[] = ["Ctrl", "Alt", "Shift"];

const fixedHints = (group: GroupName): Hint[] => FIXED_SHORTCUTS.filter((row) => row.modifier === group).map(({ keys, text }) => ({ keys, text }));


const boundHints = (keybinds: Keybinds, group: GroupName, held: GroupName[]): Hint[] =>
  BINDABLE_ACTIONS.flatMap((action) =>
    (keybinds[action.id] ?? [])
      .map((binding) => (action.kind === "hold" ? { modifiers: binding.split("+"), keys: [...binding.split("+").slice(1), "Drag"].join("+"), text: action.label } : { modifiers: modifiersOfBinding(binding), keys: [...modifiersOfBinding(binding).slice(1), keyOfBinding(binding)].join("+"), text: action.label }))
      .filter(({ modifiers }) => modifiers[0] === group && modifiers.every((modifier) => held.includes(modifier as GroupName)))
      .map(({ keys, text }) => ({ keys: keys.split("+").map(displayModifier).join("+"), text })),
  );

const HintGroup = ({ title, hints }: { title: string; hints: Hint[] }) => (
  <section>
    <h5>{displayModifier(title)}</h5>
    {hints.map((hint) => <div key={`${hint.keys}-${hint.text}`}>{hint.text}<kbd>{hint.keys}</kbd></div>)}
  </section>
);

const NONE_HELD = { shift: false, control: false, alt: false };

const withHeld = (previous: typeof NONE_HELD, next: typeof NONE_HELD) => (previous.shift === next.shift && previous.control === next.control && previous.alt === next.alt ? previous : next);

export const ModifierHints = () => {
  const [held, setHeld] = useState(NONE_HELD);
  const keybinds = useSettings((state) => state.settings.keybinds);
  useEffect(() => {
    const track = (event: KeyboardEvent) => setHeld((previous) => withHeld(previous, { shift: event.shiftKey, control: isMacPlatform ? event.metaKey : event.ctrlKey, alt: event.altKey }));
    const release = () => setHeld((previous) => withHeld(previous, NONE_HELD));
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
      {heldGroups.map((group) => <HintGroup key={group} title={group} hints={[...fixedHints(group), ...boundHints(keybinds, group, heldGroups)]} />)}
    </div>
  );
};
