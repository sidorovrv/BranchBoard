import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { fileNameOf, isMarkdownPath, languageOfPath, type Attachment, type GitBranches, type GitChanges, type GraphNode } from "@branchboard/core";
import { fetchWorkspaceFiles } from "../api";
import { createAndFocus } from "../actions";
import { useAutosavedText } from "../autosave";
import { highlightCode } from "../highlight";
import { boardId, sendBoardCommand } from "../store";
import { ChipSelect } from "./ChipSelect";
import { CopyButton } from "./CodeFence";
import { Icon } from "./Icons";
import { Markdown } from "./Markdown";

const ExtractButton = ({ name, command }: { name: string; command: Record<string, unknown> }) => {
  const extract = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const originId = event.currentTarget.closest(".react-flow__node")?.getAttribute("data-id") ?? undefined;
    void createAndFocus({ ...command, originId });
  };
  return (
    <button className="extract-file nodrag" onClick={extract} title={`Extract ${name} into a code node`} aria-label={`Extract ${name} into a code node`}>
      <Icon name="extract" />
    </button>
  );
};

export const ExtractFileButton = ({ path }: { path: string }) => <ExtractButton name={fileNameOf(path)} command={{ type: "extractFile", path }} />;

export const ExtractAttachmentButton = ({ attachment }: { attachment: Attachment }) => (
  <ExtractButton name={attachment.name} command={{ type: "extractAttachment", attachmentId: attachment.id }} />
);

const PICKER_SEARCH_DELAY_MS = 150;

const FilePicker = ({ node }: { node: GraphNode }) => {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchWorkspaceFiles(boardId(), query).then(setFiles, () => setFiles([]));
    }, PICKER_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const open = (path: string) => void sendBoardCommand({ type: "openFile", nodeId: node.id, path });
  return (
    <div className="code-node file-picker">
      <input className="nodrag" autoFocus value={query} placeholder="Search the repository for a file to open" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && files[0] && open(files[0])} />
      <div className="file-picker-list nodrag nowheel">
        {files.map((path) => (
          <button key={path} onClick={() => open(path)} title={path}>{path}</button>
        ))}
        {files.length === 0 && <span className="muted">No matching files</span>}
      </div>
    </div>
  );
};

type MarkdownMode = "view" | "edit";

const MarkdownBody = ({ node }: { node: GraphNode }) => {
  const [mode, setMode] = useState<MarkdownMode>("view");
  const isFileBacked = !node.sourceAttachmentId && !node.gitRef;
  const { text, change, flush } = useAutosavedText(node.prompt, (saved) =>
    void sendBoardCommand(isFileBacked ? { type: "writeCodeFile", nodeId: node.id, content: saved } : { type: "editNode", nodeId: node.id, fields: { prompt: saved } }),
  );
  const git = useGitBranches(node);
  const showView = () => {
    flush();
    setMode("view");
  };
  return (
    <div className="code-node">
      <CodeHead node={node} git={git}>
        <button className="nodrag" onClick={mode === "view" ? () => setMode("edit") : showView} title={mode === "view" ? "Edit the Markdown in this node" : "Show formatted"}>
          <Icon name={mode === "view" ? "edit" : "check"} />{mode === "view" ? "Edit" : "Done"}
        </button>
      </CodeHead>
      {mode === "view" ? (
        <div className="markdown-view copyable nowheel"><Markdown text={text} sourcePath={node.sourceAttachmentId ? undefined : node.filePath} /></div>
      ) : (
        <textarea className="markdown-edit nodrag nowheel" autoFocus value={text} onChange={(event) => change(event.target.value)} onBlur={flush} />
      )}
    </div>
  );
};

const useGitBranches = (node: GraphNode): GitBranches | undefined => {
  const [info, setInfo] = useState<GitBranches>();
  const isFromWorkspace = Boolean(node.filePath) && !node.sourceAttachmentId;
  useEffect(() => {
    if (!isFromWorkspace) return;
    let isCurrent = true;
    void sendBoardCommand<GitBranches>({ type: "gitInfo" }).then((loaded) => isCurrent && setInfo(loaded));
    return () => {
      isCurrent = false;
    };
  }, [isFromWorkspace, node.gitRef]);
  return info?.isRepo ? info : undefined;
};

const BranchPicker = ({ node, git }: { node: GraphNode; git: GitBranches }) => {
  if (git.branches.length === 0) return null;
  const options = git.branches.map((branch) => ({ value: branch, label: branch === git.current ? `${branch} (checked out)` : branch }));
  return (
    <span className="nodrag branch-picker">
      <ChipSelect icon="branch" title="Show this file on another branch" value={node.gitRef || git.current || ""} options={options} onChange={(ref) => void sendBoardCommand({ type: "selectCodeBranch", nodeId: node.id, ref })} />
    </span>
  );
};

const useChangedLines = (node: GraphNode, git: GitBranches | undefined): GitChanges | undefined => {
  const [changes, setChanges] = useState<GitChanges>();
  useEffect(() => {
    if (!git) return setChanges(undefined);
    let isCurrent = true;
    void sendBoardCommand<GitChanges>({ type: "gitChanges", nodeId: node.id }).then((loaded) => isCurrent && setChanges(loaded));
    return () => {
      isCurrent = false;
    };
  }, [git, node.id, node.gitRef, node.prompt]);
  return changes;
};

const CodeHead = ({ node, git, children }: { node: GraphNode; git?: GitBranches; children?: ReactNode }) => (
  <div className="code-node-head">
    <span className="code-node-path copyable nodrag" title={node.filePath}>{node.filePath}</span>
    {git && <BranchPicker node={node} git={git} />}
    {children}
    {!node.sourceAttachmentId && (
      <button className="nodrag" onClick={() => void sendBoardCommand({ type: "revealFile", path: node.filePath })} title="Show the file in your file manager">
        <Icon name="reveal" />Show in folder
      </button>
    )}
    <CopyButton text={node.prompt} />
  </div>
);

const changedRanges = (lines: number[]): { start: number; length: number }[] =>
  lines.reduce<{ start: number; length: number }[]>((ranges, line) => {
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.length === line) last.length += 1;
    else ranges.push({ start: line, length: 1 });
    return ranges;
  }, []);

const changeSummary = (changes: GitChanges | undefined, node: GraphNode): string | undefined => {
  if (!changes || (changes.added.length === 0 && changes.removed === 0)) return undefined;
  const base = node.gitRef ? "the checked-out branch" : "the last commit";
  return `+${changes.added.length} −${changes.removed} compared with ${base}`;
};

const SourceBody = ({ node, path }: { node: GraphNode; path: string }) => {
  const highlighted = useMemo(() => highlightCode(node.prompt, languageOfPath(path)), [node.prompt, path]);
  const git = useGitBranches(node);
  const changes = useChangedLines(node, git);
  const summary = changeSummary(changes, node);
  return (
    <div className="code-node">
      <CodeHead node={node} git={git} />
      {summary && <div className="code-changes-note" title="Highlighted lines are the ones that differ">{summary}</div>}
      <pre className="copyable nodrag nowheel">
        {changedRanges(changes?.added ?? []).map(({ start, length }) => <span key={start} className="changed-lines" style={{ top: `calc(var(--code-pad) + ${start - 1} * var(--code-line))`, height: `calc(${length} * var(--code-line))` }} />)}
        {[...new Set(changes?.removedAfter ?? [])].map((lineCount) => <span key={`removed-${lineCount}`} className="removed-marker" style={{ top: `calc(var(--code-pad) + ${lineCount} * var(--code-line))` }} />)}
        {highlighted === undefined ? <code>{node.prompt}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />}
      </pre>
    </div>
  );
};

export const CodeBody = ({ node }: { node: GraphNode }) => {
  if (!node.filePath) return <FilePicker node={node} />;
  return isMarkdownPath(node.filePath) ? <MarkdownBody node={node} /> : <SourceBody node={node} path={node.filePath} />;
};
