import { useState } from "react";
import { splitPromptSegments, type GraphNode } from "@branchboard/core";
import { useExpandedPrompt } from "../expandedPrompts";
import { AttachmentList } from "./AttachmentList";
import { CodeFence, CopyButton } from "./CodeFence";
import { Selectable } from "./Selectable";

const COLLAPSE_CHARACTERS = 320;
const COLLAPSE_LINES = 6;
const LIST_ITEM = /^(\s*)(•|\d+\.) (.*)$/;

const isLongPrompt = (prompt: string): boolean => prompt.length > COLLAPSE_CHARACTERS || prompt.split("\n").length > COLLAPSE_LINES || prompt.includes("```");

const PromptLine = ({ line }: { line: string }) => {
  const item = LIST_ITEM.exec(line);
  if (!item) return <div className="prompt-line">{line === "" ? " " : <Selectable>{line}</Selectable>}</div>;
  return (
    <div className="prompt-line prompt-item" style={{ marginLeft: `${item[1].length}ch` }}>
      <span className="prompt-marker">{item[2]}</span>
      <Selectable>{item[3]}</Selectable>
    </div>
  );
};

const PromptBody = ({ prompt }: { prompt: string }) => (
  <>
    {splitPromptSegments(prompt).map((segment, index) =>
      segment.kind === "code" ? (
        <CodeFence key={index} language={segment.language} text={segment.text} />
      ) : (
        <div key={index} className="prompt-segment">{segment.text.split("\n").map((line, lineIndex) => <PromptLine key={lineIndex} line={line} />)}</div>
      ),
    )}
  </>
);

export const PromptBlock = ({ node }: { node: GraphNode }) => {
  const isLong = isLongPrompt(node.prompt);
  const [isExpanded, setIsExpanded] = useExpandedPrompt(node.id);
  const hasAttachments = (node.attachments ?? []).length > 0;
  if (!node.prompt && !hasAttachments) return null;
  return (
    <div className={`prompt-block ${isLong ? (isExpanded ? "is-expanded" : "is-collapsed") : ""}`}>
      {node.prompt && (
        <>
          <div className="prompt-head">
            <span>Prompt</span>
            <span className="prompt-tools">
              <CopyButton text={node.prompt} />
              {isLong && <button className="nodrag" onClick={() => setIsExpanded(!isExpanded)} aria-expanded={isExpanded}>{isExpanded ? "Collapse" : "Expand"}</button>}
            </span>
          </div>
          <div className="prompt-body nowheel"><PromptBody prompt={node.prompt} /></div>
        </>
      )}
      {hasAttachments && (
        <div className="prompt-files">
          <AttachmentList node={node} isEditable={false} />
        </div>
      )}
    </div>
  );
};
