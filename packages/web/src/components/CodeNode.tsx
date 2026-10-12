import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  codeViewOfPath,
  collapseUnchanged,
  diffRows,
  fileNameOf,
  gitChangesOf,
  HTML_SANDBOX_FLAGS,
  languageOfPath,
  rowsOfGitChanges,
  type Attachment,
  type CodeViewId,
  type GitBranches,
  type GitChanges,
  type GraphNode,
} from "@branchboard/core";
import { fetchWorkspaceFiles, pickPath } from "../api";
import { createAndFocus } from "../actions";
import { useAutosavedText } from "../autosave";
import { highlightCode } from "../highlight";
import { boardId, sendBoardCommand } from "../store";
import { ChipSelect } from "./ChipSelect";
import { CopyButton } from "./CodeFence";
import { DiffView } from "./DiffView";
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
const FRESH_NODE_MS = 3000;

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
  const browse = () => pickPath("file", boardId()).then((path) => path && open(path), () => undefined);
  useEffect(() => {
    if (Date.now() - node.createdAt < FRESH_NODE_MS) void browse();
  }, []);
  return (
    <div className="code-node file-picker">
      <button className="nodrag" onClick={() => void browse()} title="Open the system file dialog">Browse…</button>
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

type ViewMode = "formatted" | "edit" | "preview" | "source" | "diff";

const VIEW_LABELS: Record<ViewMode, string> = { formatted: "Formatted", edit: "Edit", preview: "Preview", source: "Source", diff: "Diff" };

const CODE_VIEWS: Record<CodeViewId, { modes: ViewMode[] }> = {
  markdown: { modes: ["formatted", "edit"] },
  html: { modes: ["preview", "source"] },
  source: { modes: ["source"] },
};

const DIFF_CONTEXT_LINES = 3;
const PREVIEW_RENEW_MS = 4 * 60 * 1000;

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
  const [shownContent] = useState(node.prompt);
  const sinceShown = useMemo(() => gitChangesOf(diffRows(shownContent, node.prompt, Infinity)), [shownContent, node.prompt]);
  useEffect(() => {
    if (!git) return setChanges(undefined);
    let isCurrent = true;
    void sendBoardCommand<GitChanges>({ type: "gitChanges", nodeId: node.id }).then((loaded) => isCurrent && setChanges(loaded));
    return () => {
      isCurrent = false;
    };
  }, [git, node.id, node.gitRef, node.prompt]);
  return git ? changes : sinceShown;
};

const hasChanges = (changes: GitChanges | undefined): changes is GitChanges => Boolean(changes && (changes.added.length > 0 || changes.removed > 0));

const changeSummary = (changes: GitChanges | undefined, node: GraphNode, git: GitBranches | undefined): string | undefined => {
  if (!hasChanges(changes)) return undefined;
  const base = !git ? "when this node was opened" : node.gitRef ? "the checked-out branch" : "the last commit";
  return `+${changes.added.length} −${changes.removed} compared with ${base}`;
};

const changedRanges = (lines: number[]): { start: number; length: number }[] =>
  lines.reduce<{ start: number; length: number }[]>((ranges, line) => {
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.length === line) last.length += 1;
    else ranges.push({ start: line, length: 1 });
    return ranges;
  }, []);

const ViewSwitch = ({ modes, mode, onChange }: { modes: ViewMode[]; mode: ViewMode; onChange: (mode: ViewMode) => void }) => {
  if (modes.length < 2) return null;
  return (
    <span className="view-switch nodrag" role="tablist">
      {modes.map((candidate) => (
        <button key={candidate} role="tab" aria-selected={candidate === mode} className={candidate === mode ? "active" : ""} onClick={() => onChange(candidate)}>
          {VIEW_LABELS[candidate]}
        </button>
      ))}
    </span>
  );
};

interface ViewProps {
  node: GraphNode;
  path: string;
  changes?: GitChanges;
}

const FormattedView = ({ node }: ViewProps) => (
  <div className="markdown-view copyable nowheel"><Markdown text={node.prompt} sourcePath={node.sourceAttachmentId ? undefined : node.filePath} /></div>
);

const EditView = ({ node }: ViewProps) => {
  const isFileBacked = !node.sourceAttachmentId && !node.gitRef;
  const { text, change, flush } = useAutosavedText(node.prompt, (saved) =>
    void sendBoardCommand(isFileBacked ? { type: "writeCodeFile", nodeId: node.id, content: saved } : { type: "editNode", nodeId: node.id, fields: { prompt: saved } }),
  );
  return <textarea className="markdown-edit nodrag nowheel" autoFocus value={text} onChange={(event) => change(event.target.value)} onBlur={flush} />;
};

const RemovedMarker = ({ block }: { block: GitChanges["removedBlocks"][number] }) => (
  <>
    <span className="removed-marker" style={{ top: `calc(var(--code-pad) + ${block.after} * var(--code-line))` }} />
    <span className="removed-hit" style={{ top: `calc(var(--code-pad) + ${block.after} * var(--code-line) - 6px)` }}>
      <span className="removed-popover">
        {block.lines.map((line, index) => <span key={index} className="removed-line">{line || " "}</span>)}
      </span>
    </span>
  </>
);

const SourceView = ({ node, path, changes }: ViewProps) => {
  const highlighted = useMemo(() => highlightCode(node.prompt, languageOfPath(path)), [node.prompt, path]);
  return (
    <pre className="copyable nodrag nowheel">
      {changedRanges(changes?.added ?? []).map(({ start, length }) => <span key={start} className="changed-lines" style={{ top: `calc(var(--code-pad) + ${start - 1} * var(--code-line))`, height: `calc(${length} * var(--code-line))` }} />)}
      {(changes?.removedBlocks ?? []).map((block) => <RemovedMarker key={`${block.after}-${block.lines[0]}`} block={block} />)}
      {highlighted === undefined ? <code>{node.prompt}</code> : <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />}
    </pre>
  );
};

const DiffBody = ({ node, changes }: ViewProps) => {
  const rows = useMemo(() => (hasChanges(changes) ? collapseUnchanged(rowsOfGitChanges(node.prompt, changes), DIFF_CONTEXT_LINES) : []), [node.prompt, changes]);
  return rows.length === 0 ? <div className="muted code-empty-note">No differences from the comparison point.</div> : <DiffView rows={rows} />;
};

const useCapabilityUrl = (node: GraphNode, isSnapshot: boolean): string | undefined => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (isSnapshot) return;
    let isCurrent = true;
    const open = () => void sendBoardCommand<{ url: string }>({ type: "openPreview", nodeId: node.id }).then((opened) => isCurrent && opened && setUrl(opened.url));
    open();
    const timer = setInterval(open, PREVIEW_RENEW_MS);
    return () => {
      isCurrent = false;
      clearInterval(timer);
    };
  }, [node.id, node.filePath, isSnapshot]);
  return url;
};

const PreviewView = ({ node, path }: ViewProps) => {
  const isSnapshot = Boolean(node.gitRef || node.sourceAttachmentId);
  const url = useCapabilityUrl(node, isSnapshot);
  const sandbox = HTML_SANDBOX_FLAGS.join(" ");
  if (isSnapshot) return <iframe key={node.rev} className="html-preview nodrag nowheel" title={`Preview of ${path}`} sandbox={sandbox} srcDoc={node.prompt} />;
  if (!url) return <div className="muted code-empty-note">Opening the preview…</div>;
  return <iframe key={node.rev} className="html-preview nodrag nowheel" title={`Preview of ${path}`} sandbox={sandbox} src={url} />;
};

const VIEW_RENDERERS: Record<ViewMode, (props: ViewProps) => ReactNode> = {
  formatted: FormattedView,
  edit: EditView,
  preview: PreviewView,
  source: SourceView,
  diff: DiffBody,
};

const CodeFileBody = ({ node, path }: { node: GraphNode; path: string }) => {
  const view = CODE_VIEWS[codeViewOfPath(path)];
  const git = useGitBranches(node);
  const changes = useChangedLines(node, git);
  const modes = hasChanges(changes) ? [...view.modes, "diff" as const] : view.modes;
  const [chosen, setMode] = useState<ViewMode>(view.modes[0]);
  const mode = modes.includes(chosen) ? chosen : view.modes[0];
  const summary = changeSummary(changes, node, git);
  const Renderer = VIEW_RENDERERS[mode];
  return (
    <div className="code-node">
      <div data-tour="code" className="code-node-head">
        <span className="code-node-path copyable nodrag" title={node.filePath}>{node.filePath}</span>
        {git && <BranchPicker node={node} git={git} />}
        <ViewSwitch modes={modes} mode={mode} onChange={setMode} />
        {!node.sourceAttachmentId && (
          <button className="nodrag" onClick={() => void sendBoardCommand({ type: "revealFile", path: node.filePath })} title="Show the file in your file manager">
            <Icon name="reveal" />Show in folder
          </button>
        )}
        <CopyButton text={node.prompt} />
      </div>
      {summary && mode === "source" && <div className="code-changes-note" title="Highlighted lines are the ones that differ">{summary}</div>}
      <Renderer node={node} path={path} changes={changes} />
    </div>
  );
};

export const CodeBody = ({ node }: { node: GraphNode }) => (node.filePath ? <CodeFileBody node={node} path={node.filePath} /> : <FilePicker node={node} />);
