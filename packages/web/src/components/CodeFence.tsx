import { useMemo, useState } from "react";
import { highlightCode } from "../highlight";

const COPIED_FLASH_MS = 1500;

export const useCopy = (text: string) => {
  const [isCopied, setIsCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), COPIED_FLASH_MS);
    } catch {
      return;
    }
  };
  return { isCopied, copy };
};

export const CopyButton = ({ text, label = "Copy" }: { text: string; label?: string }) => {
  const { isCopied, copy } = useCopy(text);
  return <button className="nodrag" onClick={() => void copy()}>{isCopied ? "Copied" : label}</button>;
};

export const CodeFence = ({ language, text }: { language?: string; text: string }) => {
  const highlighted = useMemo(() => highlightCode(text, language), [text, language]);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language ?? "text"}</span>
        <CopyButton text={text} />
      </div>
      <pre className="copyable nodrag nowheel">{highlighted === undefined ? <code>{text}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />}</pre>
    </div>
  );
};
