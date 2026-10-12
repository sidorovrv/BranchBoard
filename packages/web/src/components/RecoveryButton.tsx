import { isApiRuntime, isRecoveryId, type GraphNode, type Part, type RecoveryId } from "@branchboard/core";
import { downloadFromApi } from "../api";
import { sendBoardCommand, useBoard } from "../store";

interface RecoveryAction {
  label: string;
  run: (node: GraphNode) => unknown;
}

const openKeys = () => {
  const mode = useBoard.getState().board?.mode;
  useBoard.getState().setSettingsOpen(true, mode && isApiRuntime(mode) ? "keys" : undefined);
};

const saveBugReport = () =>
  downloadFromApi("/api/report", `branchboard-report-${new Date().toISOString().slice(0, 10)}.json`).catch((error) => useBoard.getState().notify(error.message));

const regenerate = (node: GraphNode) => sendBoardCommand({ type: "regenerate", nodeId: node.id });

export const RECOVERY_ACTIONS: Record<RecoveryId, RecoveryAction> = {
  assemble: { label: "Resend context as text", run: (node) => sendBoardCommand({ type: "regenerate", nodeId: node.id, assemble: true }) },
  setup: { label: "Open settings", run: openKeys },
  signIn: { label: "Try again", run: regenerate },
  usageLimit: { label: "Try again", run: regenerate },
  report: { label: "Save bug report", run: saveBugReport },
  retry: { label: "Try again", run: regenerate },
};

export const recoveryOfPart = (part: Part): RecoveryId | undefined => (isRecoveryId(part.meta?.recovery) ? part.meta.recovery : undefined);

export const RecoveryButton = ({ node, part }: { node: GraphNode; part: Part }) => {
  const recovery = recoveryOfPart(part);
  if (!recovery || node.status !== "error") return null;
  const action = RECOVERY_ACTIONS[recovery];
  return <button className="recovery-button" onClick={() => void action.run(node)}>{action.label}</button>;
};
