import { useCallback, useEffect, useState } from "react";
import { formatAgo, type TrashListing, type TrashedNodeGroup } from "@branchboard/core";
import { fetchTrash } from "../api";
import { useBoard } from "../store";
import { IconRow } from "./Icons";

const ago = (deletedAt: number): string => formatAgo(Math.max(0, Date.now() - deletedAt));

const RETENTION_NOTE = "Items are removed for good 30 days after they were deleted.";

const isEmpty = (listing: TrashListing): boolean => listing.projects.length + listing.boards.length + listing.nodeGroups.length === 0;

const describeGroup = (group: TrashedNodeGroup): string => {
  const shown = group.titles.slice(0, 3).join(", ");
  const more = group.titles.length > 3 ? ` and ${group.titles.length - 3} more` : "";
  return shown ? `${shown}${more}` : "Subagent nodes";
};

export const TrashDialog = ({ onClose }: { onClose: () => void }) => {
  const [listing, setListing] = useState<TrashListing>();
  const refresh = useCallback(async () => setListing(await fetchTrash()), []);
  useEffect(() => void refresh(), [refresh]);

  const restoreAndRefresh = async (command: Record<string, unknown>) => {
    const result = await useBoard.getState().send(command);
    if (!result) return;
    await useBoard.getState().loadBoards();
    await refresh();
  };

  const emptyTrash = async () => {
    if (!confirm("Delete everything in the trash for good? This cannot be undone.")) return;
    await restoreAndRefresh({ type: "emptyTrash" });
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog trash-dialog">
        <h3><IconRow names={["trash"]} /> Trash</h3>
        <div className="muted">{RETENTION_NOTE}</div>
        {!listing && <div className="muted">Loading…</div>}
        {listing && isEmpty(listing) && <div className="muted">The trash is empty.</div>}
        {listing && (
          <ul className="trash-list">
            {listing.projects.map((project) => (
              <li key={project.id}>
                <div>
                  <strong>{project.name}</strong> <span className="badge">project</span>
                  <div className="muted">{project.boardCount} board{project.boardCount === 1 ? "" : "s"} · deleted {ago(project.deletedAt)}</div>
                </div>
                <button onClick={() => void restoreAndRefresh({ type: "restoreProject", projectId: project.id })}>Restore</button>
              </li>
            ))}
            {listing.boards.map((board) => (
              <li key={board.id}>
                <div>
                  <strong>{board.title}</strong> <span className="badge">board</span>
                  <div className="muted">{board.projectName ? `${board.projectName} · ` : ""}deleted {ago(board.deletedAt)}</div>
                </div>
                <button onClick={() => void restoreAndRefresh({ type: "restoreBoard", boardId: board.id })}>Restore</button>
              </li>
            ))}
            {listing.nodeGroups.map((group) => (
              <li key={`${group.boardId}/${group.deletedAt}`}>
                <div>
                  <strong>{describeGroup(group)}</strong> <span className="badge">{group.nodeIds.length} node{group.nodeIds.length === 1 ? "" : "s"}</span>
                  <div className="muted">{group.boardTitle} · deleted {ago(group.deletedAt)}</div>
                </div>
                <button onClick={() => void restoreAndRefresh({ type: "restoreNodes", boardId: group.boardId, ids: group.nodeIds })}>Restore</button>
              </li>
            ))}
          </ul>
        )}
        <div className="dialog-actions">
          <button className="danger" disabled={!listing || isEmpty(listing)} onClick={() => void emptyTrash()}><IconRow names={["purge"]} /> Empty trash</button>
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
