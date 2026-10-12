import { SHORTCUT_AREAS, shortcutRows } from "@branchboard/core";
import { displayShortcuts } from "../platform";
import { useSettings } from "../settings";
import { useBoard } from "../store";
import { startTour } from "../tour";
import { useContextMenu } from "./ContextMenu";
import { IconRow } from "./Icons";

export const HelpButton = () => {
  const { open, element } = useContextMenu();
  const items = [
    { label: "Shortcuts", run: () => useBoard.getState().setShortcutsOpen(true) },
    { label: "Take the tour", run: startTour },
  ];
  return (
    <>
      <button data-tour="help" onClick={(event) => open(items)(event)} title="Help, shortcuts and the tour" aria-label="Help"><IconRow names={["help"]} /></button>
      {element}
    </>
  );
};

export const ShortcutsDialog = () => {
  const keybinds = useSettings((state) => state.settings.keybinds);
  const close = () => useBoard.getState().setShortcutsOpen(false);
  const rows = shortcutRows(keybinds);
  return (
    <div className="dialog-backdrop" onMouseDown={close}>
      <div className="dialog shortcuts-dialog" role="dialog" aria-label="Shortcuts" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.key === "Escape" && close()}>
        <h3>Shortcuts</h3>
        <div className="shortcuts-body">
          {SHORTCUT_AREAS.map((area) => (
            <section key={area}>
              <h5>{area}</h5>
              {rows.filter((row) => row.area === area).map((row) => <div key={`${row.keys}-${row.text}`}>{row.text}<kbd>{displayShortcuts(row.keys)}</kbd></div>)}
            </section>
          ))}
        </div>
        <div className="dialog-actions"><button autoFocus onClick={close}>Close</button></div>
      </div>
    </div>
  );
};
