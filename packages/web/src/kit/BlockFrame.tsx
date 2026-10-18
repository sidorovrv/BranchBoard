import { useState, type ReactNode } from "react";
import { CodeFence, CopyButton } from "./CodeFence";

interface BlockFrameProps {
  label: string;
  tourAnchor?: string;
  source: string;
  language: string;
  children: ReactNode;
}

export const BlockFrame = ({ label, tourAnchor, source, language, children }: BlockFrameProps) => {
  const [isSourceShown, setIsSourceShown] = useState(false);
  return (
    <div className="code-block rich-block" data-tour={tourAnchor}>
      <div className="code-head">
        <span>{label}</span>
        <span className="rich-actions">
          <button className="nodrag" onClick={() => setIsSourceShown(!isSourceShown)}>{isSourceShown ? "View" : "Source"}</button>
          <CopyButton text={source} label="Copy source" />
        </span>
      </div>
      {isSourceShown ? <CodeFence language={language} text={source} /> : children}
    </div>
  );
};

export const BlockError = ({ message }: { message: string }) => <div className="rich-error">{message}</div>;
