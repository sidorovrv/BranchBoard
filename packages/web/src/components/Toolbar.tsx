import { actionById, titleWithShortcut } from "../actions";
import { useSettings } from "../settings";
import { IconRow } from "../kit/Icons";

export const Toolbar = () => {
  const keybinds = useSettings((state) => state.settings.keybinds);
  return (
    <div className="toolbar">
      {["newChat", "newNote", "newCode", "newFile", "search"].map((id) => {
        const action = actionById(id);
        return <button key={id} onClick={() => void action.run({})} title={titleWithShortcut(id, keybinds)} aria-label={action.label({})}><IconRow names={action.icons({})} /></button>;
      })}
    </div>
  );
};
