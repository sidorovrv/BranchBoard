import { useEffect, useMemo, useState } from "react";
import { describeToolGroup, fileEditOf, isRepeatedToolName, todoProgress, toolFilePathOf, toolGroupStatus, toolInputView, type ChatPart, type FileEdit, type TodoItem } from "@branchboard/core";
import { DiffStat, DiffView } from "./DiffView";
import { ExtractFileButton } from "./ExtractFileButton";
import { useChatHost } from "./host";
import { Icon } from "./Icons";

const useToolOutput = (part: ChatPart): unknown => {
  const { toolOutput } = useChatHost();
  const isOmitted = part.meta?.output === undefined && part.meta?.outputChars !== undefined;
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (!isOmitted || !toolOutput) return;
    let isCurrent = true;
    toolOutput(part).then(
      (output) => isCurrent && setLoaded(output),
      () => isCurrent && setLoaded("The tool output could not be loaded."),
    );
    return () => {
      isCurrent = false;
    };
  }, [isOmitted, toolOutput, part.id]);
  return isOmitted ? (loaded ?? "Loading the tool output…") : part.meta?.output;
};

const ToolCardBody = ({ part, edit }: { part: ChatPart; edit: FileEdit | undefined }) => {
  const output = useToolOutput(part);
  const inputView = edit ? undefined : toolInputView(part.meta?.input);
  return (
    <>
      {edit && <DiffView rows={edit.rows} />}
      {inputView && <pre className="copyable nodrag tool-primary">{inputView.primaryText}</pre>}
      {inputView?.remaining && <pre className="copyable nodrag">{JSON.stringify(inputView.remaining, null, 2)}</pre>}
      {!edit && !inputView && part.meta?.input !== undefined && <pre className="copyable nodrag">{JSON.stringify(part.meta.input, null, 2)}</pre>}
      {output !== undefined && <pre className="copyable nodrag">{String(output)}</pre>}
    </>
  );
};

export const ToolCard = ({ part }: { part: ChatPart }) => {
  const [isOpen, setIsOpen] = useState(false);
  const edit = useMemo(() => fileEditOf(part.meta?.tool, part.meta?.input), [part.meta?.tool, part.meta?.input]);
  const filePath = toolFilePathOf(part.meta?.input);
  const toolName = String(part.meta?.tool);
  const summaryText = isRepeatedToolName(part.text, toolName) ? (edit ? "" : (toolInputView(part.meta?.input)?.summary ?? "")) : part.text;
  return (
    <details className={`tool-card tool-${String(part.meta?.status)}`} onToggle={(event) => setIsOpen(event.currentTarget.open)}>
      <summary>
        <span className="tool-name">{toolName}</span>
        <span className="tool-text">{summaryText}</span>
        {edit && <DiffStat change={edit} isPill />}
        {filePath && <ExtractFileButton path={filePath} />}
        <span className="tool-status">{String(part.meta?.status)}</span>
      </summary>
      {isOpen && <ToolCardBody part={part} edit={edit} />}
    </details>
  );
};

const TODO_ICONS = { completed: "todoDone", in_progress: "todoActive", pending: "todoOpen" } as const;

export const TodoList = ({ part }: { part: ChatPart }) => {
  const items = (part.meta?.items ?? []) as TodoItem[];
  const { done, total } = todoProgress(items);
  return (
    <div className="todo-list">
      <div className="todo-head">Todos <span className="muted">{done}/{total}</span></div>
      <ul>
        {items.map((item, index) => (
          <li key={index} className={`todo-${item.status}`}>
            <Icon name={TODO_ICONS[item.status]} />
            <span>{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export const ToolGroup = ({ parts }: { parts: ChatPart[] }) => {
  const status = toolGroupStatus(parts);
  return (
    <details className={`tool-group tool-${status}`}>
      <summary>
        <span className="tool-text">{describeToolGroup(parts)}</span>
        <span className="tool-status">{status}</span>
      </summary>
      <div className="tool-group-body">{parts.map((part) => <ToolCard key={part.id} part={part} />)}</div>
    </details>
  );
};
