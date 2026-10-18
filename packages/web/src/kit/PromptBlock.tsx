import type { ReactNode } from "react";
import { isLongPrompt, splitPromptSegments } from "@branchboard/core";
import { CodeFence, CopyButton } from "./CodeFence";
import { Selectable } from "./Selectable";

const DEFAULT_COLLAPSE_LINES = 6;
const LIST_ITEM = /^(\s*)(•|\d+\.) (.*)$/;

const PromptLine = ({ line }: { line: string }) => {
  const item = LIST_ITEM.exec(line);
  if (!item) return <div className="prompt-line">{line === "" ? " " : <Selectable>{line}</Selectable>}</div>;
  return (
    <div className="prompt-line prompt-item" style={{ marginLeft: `${item[1]?.length ?? 0}ch` }}>
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

interface PromptBlockProps {
  prompt: string;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  attachments?: ReactNode;
  collapseLines?: number;
}

export const PromptBlock = ({ prompt, isExpanded, onExpandedChange: setIsExpanded, attachments, collapseLines = DEFAULT_COLLAPSE_LINES }: PromptBlockProps) => {
  const isLong = isLongPrompt(prompt, collapseLines);
  if (!prompt && !attachments) return null;
  return (
    <div className={`prompt-block ${isLong ? (isExpanded ? "is-expanded" : "is-collapsed") : ""}`}>
      {prompt && (
        <>
          <span className="prompt-tools">
            <CopyButton text={prompt} />
            {isLong && <button className="nodrag" onClick={() => setIsExpanded(!isExpanded)} aria-expanded={isExpanded}>{isExpanded ? "Collapse" : "Expand"}</button>}
          </span>
          <div className="prompt-body nowheel"><PromptBody prompt={prompt} /></div>
        </>
      )}
      {attachments && <div className="prompt-files">{attachments}</div>}
    </div>
  );
};
