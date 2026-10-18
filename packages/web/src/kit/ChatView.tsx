import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { fileEditsOf, groupToolRuns, type ChatPart } from "@branchboard/core";
import { Markdown } from "./Markdown";
import { Selectable } from "./Selectable";
import { type RevertControl } from "./RevertDialog";
import { FileEditsSummary } from "./FileEdits";
import { TodoList, ToolCard, ToolGroup } from "./ToolViews";

const FOLLOW_TOLERANCE_PX = 24;

export const useFollowScroll = (element: RefObject<HTMLDivElement | null>, isStreaming: boolean, version: unknown, isEnabled: boolean) => {
  const isFollowing = useRef(true);
  const trackUserScroll = () => {
    const target = element.current;
    if (target) isFollowing.current = target.scrollHeight - target.scrollTop - target.clientHeight <= FOLLOW_TOLERANCE_PX;
  };
  useEffect(() => {
    if (!isStreaming) isFollowing.current = true;
  }, [isStreaming]);
  useLayoutEffect(() => {
    const target = element.current;
    if (isEnabled && isStreaming && isFollowing.current && target) target.scrollTop = target.scrollHeight;
  }, [isEnabled, isStreaming, version]);
  return trackUserScroll;
};

interface PartViewProps<P extends ChatPart> {
  part: P;
  isFinished: boolean;
  isLast: boolean;
  renderRecovery?: (part: P) => ReactNode;
  renderPart?: (part: P) => ReactNode;
}

export const PartView = <P extends ChatPart>({ part, isFinished, isLast, renderRecovery, renderPart }: PartViewProps<P>) => {
  const custom = renderPart?.(part);
  if (custom !== undefined) return <>{custom}</>;
  if (part.type === "todo") return <TodoList part={part} />;
  if (part.type === "tool") return <ToolCard part={part} />;
  if (part.type === "retry") return <div className="thinking-note">Retrying (attempt {String(part.meta?.attempt)}) at {new Date(Number(part.meta?.at)).toLocaleTimeString()}: {part.text}</div>;
  if (part.type === "error") return <div className="part-error"><Selectable>{part.text}</Selectable>{renderRecovery?.(part)}</div>;
  if (part.type === "reasoning" && part.text.trim() === "") return isFinished || !isLast ? null : <div className="thinking-note">Thinking…</div>;
  if (part.type === "reasoning") return <details className="reasoning"><summary>Reasoning</summary><div><Selectable>{part.text}</Selectable></div></details>;
  return <Markdown text={part.text} isStreaming={!isFinished} />;
};

interface ChatViewProps<P extends ChatPart> {
  parts: P[];
  isFinished: boolean;
  isStreaming: boolean;
  isGrouping: boolean;
  isFollowing: boolean;
  roll?: number;
  answerRef?: RefObject<HTMLDivElement | null>;
  header?: ReactNode;
  afterParts?: ReactNode;
  footer?: ReactNode;
  revert?: RevertControl;
  isStopped?: boolean;
  renderRecovery?: (part: P) => ReactNode;
  renderPart?: (part: P) => ReactNode;
}

export const ChatView = <P extends ChatPart>({ parts, isFinished, isStreaming, isGrouping, isFollowing, roll, answerRef, header, afterParts, footer, revert, isStopped, renderRecovery, renderPart }: ChatViewProps<P>) => {
  const ownRef = useRef<HTMLDivElement>(null);
  const element = answerRef ?? ownRef;
  const trackUserScroll = useFollowScroll(element, isStreaming, parts, isFollowing);
  const runs = useMemo(() => groupToolRuns(parts), [parts]);
  const fileEdits = useMemo(() => fileEditsOf(parts), [parts]);
  useLayoutEffect(() => {
    if (isFinished && element.current) element.current.scrollTop = element.current.scrollHeight;
  }, []);
  const view = { isFinished, renderRecovery, renderPart };
  return (
    <>
      {header}
      <div className="answer nowheel" ref={element} data-roll={roll} onScroll={trackUserScroll}>
        {isGrouping
          ? runs.map((run, index) => (run.kind === "tools" ? <ToolGroup key={run.parts[0]?.id} parts={run.parts} /> : <PartView key={run.part.id} part={run.part} isLast={index === runs.length - 1} {...view} />))
          : parts.map((part, index) => <PartView key={part.id} part={part} isLast={index === parts.length - 1} {...view} />)}
        {afterParts}
        {isFinished && <FileEditsSummary edits={fileEdits} revert={revert} />}
        {isStopped && <div className="stopped-note">stopped</div>}
      </div>
      {footer}
    </>
  );
};
