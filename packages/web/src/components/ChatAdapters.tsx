import { useMemo } from "react";
import { isInFlight, type GraphNode } from "@branchboard/core";
import { useExpandedPrompt } from "../expandedPrompts";
import { LiveControls } from "../kit/LiveControls";
import { PromptBlock } from "../kit/PromptBlock";
import { Requests, type AnswerRequest } from "../kit/Requests";
import type { PreviewFile, RevertControl } from "../kit/RevertDialog";
import { sendBoardCommand, useBoard } from "../store";
import { AttachmentList } from "./AttachmentList";

const answerRequest: AnswerRequest = (requestId, answer, message) =>
  sendBoardCommand({ type: "answerRequest", requestId, answer, ...(message ? { message } : {}) });

export const NodeRequests = ({ nodeId }: { nodeId: string }) => {
  const requests = useBoard((state) => state.view.requests);
  const open = useMemo(() => Object.values(requests).filter((request) => request.status === "open" && request.nodeId === nodeId), [requests, nodeId]);
  return <Requests requests={open} onAnswer={answerRequest} />;
};

export const NodePrompt = ({ node }: { node: GraphNode }) => {
  const [isExpanded, setIsExpanded] = useExpandedPrompt(node.id);
  const hasAttachments = (node.attachments ?? []).length > 0;
  return <PromptBlock prompt={node.prompt} isExpanded={isExpanded} onExpandedChange={setIsExpanded} attachments={hasAttachments ? <AttachmentList node={node} isEditable={false} /> : undefined} />;
};

export const NodeLiveControls = ({ node }: { node: GraphNode }) => {
  const controls = useBoard((state) => state.catalog?.controls);
  if (node.kind !== "turn" || node.status !== "running" || !controls?.length) return null;
  return (
    <LiveControls
      controls={controls}
      onFollowUp={(text) => void sendBoardCommand({ type: "controlRun", nodeId: node.id, control: "followUp", text })}
      onBackground={() => void sendBoardCommand({ type: "controlRun", nodeId: node.id, control: "background" })}
    />
  );
};

const revertControlOf = (node: GraphNode): RevertControl => ({
  id: node.id,
  hasReverted: (node.reverted?.files.length ?? 0) > 0,
  preview: async (isRedo) => (await sendBoardCommand<{ files: PreviewFile[] }>({ type: "revertEdits", nodeId: node.id, redo: isRedo, dryRun: true }))?.files,
  apply: async (isRedo, paths, isForced) => {
    const result = await sendBoardCommand<{ applied: string[] }>({ type: "revertEdits", nodeId: node.id, redo: isRedo, paths, force: isForced });
    if (!result) return false;
    useBoard.getState().notify(`${isRedo ? "Restored" : "Reverted"} ${result.applied.length} ${result.applied.length === 1 ? "file" : "files"}`);
    return true;
  },
});

export const useNodeRevert = (node: GraphNode): RevertControl | undefined => {
  const canRevert = node.kind === "turn" && !isInFlight(node) && node.fileHashes != null;
  return useMemo(() => (canRevert ? revertControlOf(node) : undefined), [canRevert, node]);
};
