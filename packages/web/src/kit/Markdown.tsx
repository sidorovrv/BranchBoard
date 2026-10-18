import { Children, cloneElement, createContext, isValidElement, useContext, useDeferredValue, type ReactElement, type ReactNode, type ThHTMLAttributes } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { linkTargetOf, looksLikeFilePath, resolveRelativePath, tableFromText } from "@branchboard/core";
import { ChartBlock } from "./ChartBlock";
import { CodeFence } from "./CodeFence";
import { DataTable, TableBlock } from "./DataTable";
import { ExtractFileButton } from "./ExtractFileButton";
import { useChatHost } from "./host";
import { sanitizeSchema } from "./markdownSchema";
import { Selectable } from "./Selectable";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

const hastText = (node: HastNode): string => (node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join(""));

const hastElements = (node: HastNode | undefined, tagName?: string): HastNode[] =>
  (node?.children ?? []).filter((child) => child.type === "element" && (tagName === undefined || child.tagName === tagName));

type ParentElement = ReactElement<{ children?: ReactNode }>;

const elementsOf = (children: ReactNode): ParentElement[] => Children.toArray(children).filter(isValidElement) as ParentElement[];

const INLINE_TAGS = new Set(["a", "strong", "em", "code", "del", "span", "br", "b", "i", "sub", "sup"]);

const isInlineNode = (child: ReactNode): boolean =>
  typeof child === "string" || typeof child === "number" || (isValidElement(child) && (child.type === MarkdownLink || child.type === InlineCode || (typeof child.type === "string" && INLINE_TAGS.has(child.type))));

const selectableRuns = (children: ReactNode): ReactNode[] => {
  const runs: ReactNode[] = [];
  let pending: ReactNode[] = [];
  const flush = () => {
    if (pending.length > 0) runs.push(<Selectable key={`run-${runs.length}`}>{pending}</Selectable>);
    pending = [];
  };
  for (const child of Children.toArray(children)) {
    if (isInlineNode(child)) pending.push(child);
    else {
      flush();
      runs.push(child);
    }
  }
  flush();
  return runs;
};

const withSelectableRuns = (Tag: "p" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "td" | "th") =>
  ({ children, align }: { children?: ReactNode; align?: ThHTMLAttributes<HTMLElement>["align"] }) => <Tag align={align}>{selectableRuns(children)}</Tag>;

const ListItem = ({ children, number }: { children?: ReactNode; number?: number }) => (
  <li>
    {number !== undefined && <Selectable><span className="list-number">{number}.</span> </Selectable>}
    {selectableRuns(Children.toArray(children).filter((child) => typeof child !== "string" || child.trim() !== ""))}
  </li>
);

const OrderedList = ({ children, start }: { children?: ReactNode; start?: number }) => {
  let next = start ?? 1;
  return <ol>{Children.map(children, (child) => (isValidElement(child) ? cloneElement(child as ReactElement<{ number?: number }>, { number: next++ }) : child))}</ol>;
};

const codeOf = (children: ReactNode): { language?: string; text: string } => {
  const code = Children.toArray(children).find(isValidElement) as ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const language = /language-([\w+#-]+)/.exec(code?.props.className ?? "")?.[1];
  const text = Children.toArray(code?.props.children ?? children).join("").replace(/\n$/, "");
  return { language, text };
};

const StreamingContext = createContext(false);

const CodeBlock = ({ children }: { children?: ReactNode }) => {
  const isStreaming = useContext(StreamingContext);
  const { language, text } = codeOf(children);
  if (language === "chart" && !isStreaming) return <ChartBlock source={text} />;
  if (language === "table" && !isStreaming) return <TableBlock source={text} />;
  return <CodeFence language={language} text={text} />;
};

const MarkdownTable = ({ node, children }: { node?: HastNode; children?: ReactNode }) => {
  const isStreaming = useContext(StreamingContext);
  if (isStreaming) return <table>{children}</table>;
  const [head, body] = [hastElements(node, "thead")[0], hastElements(node, "tbody")[0]];
  const headerCells = hastElements(hastElements(head, "tr")[0]).map(hastText);
  const bodyRows = hastElements(body, "tr").map((row) => hastElements(row).map(hastText));
  const bodyElement = elementsOf(children)[1];
  const cellNodes = elementsOf(bodyElement?.props.children).map((row) => elementsOf(row.props.children));
  const isAligned = bodyRows.length === cellNodes.length && cellNodes.every((cells, index) => cells.length === bodyRows[index]?.length);
  if (!isAligned || headerCells.length === 0) return <table>{children}</table>;
  return <DataTable table={tableFromText(headerCells, bodyRows)} cellNodes={cellNodes} />;
};

const OpenerLink = ({ open, className, children }: { open: () => void; className?: string; children?: ReactNode }) => (
  <a
    href="#"
    className={className}
    onClick={(event) => {
      event.preventDefault();
      open();
    }}
  >
    {children}
  </a>
);

const MarkdownLink = ({ href, children }: { href?: string; children?: ReactNode }) => {
  const { fileUrl, fileOpener } = useChatHost();
  const target = href === undefined ? undefined : linkTargetOf(href);
  if (target?.kind === "file" && fileOpener) {
    const open = fileOpener(target.path, target.hash);
    return open ? <OpenerLink open={open}>{children}</OpenerLink> : <span className="plain-link">{children}</span>;
  }
  const url = target?.kind === "file" ? (fileUrl(target.path, target.hash) ?? href) : href;
  const link = <a href={url} target="_blank" rel="noreferrer noopener">{children}</a>;
  return target?.kind === "file" && looksLikeFilePath(target.path) ? <>{link}<ExtractFileButton path={target.path} /></> : link;
};

const InlineCode = ({ className, children }: { className?: string; children?: ReactNode }) => {
  const { fileOpener } = useChatHost();
  const text = Children.toArray(children).join("");
  const code = <code className={className}>{children}</code>;
  if (className || !looksLikeFilePath(text)) return code;
  const open = fileOpener?.(text.trim());
  if (open) return <OpenerLink open={open} className="code-link">{code}</OpenerLink>;
  return fileOpener ? code : <>{code}<ExtractFileButton path={text.trim()} /></>;
};

const SourcePathContext = createContext<string | undefined>(undefined);

const MarkdownImage = ({ src, alt, width, height }: { src?: string; alt?: string; width?: string | number; height?: string | number }) => {
  const { fileUrl } = useChatHost();
  const sourcePath = useContext(SourcePathContext);
  const imagePath = sourcePath === undefined || src === undefined ? undefined : resolveRelativePath(sourcePath, src);
  const imageUrl = imagePath === undefined ? undefined : fileUrl(imagePath);
  if (imageUrl === undefined) return <span className="blocked-image">[image: {alt || "blocked"}]</span>;
  return <img className="markdown-image" src={imageUrl} alt={alt} width={width} height={height} />;
};

const components: Components = {
  img: MarkdownImage,
  a: MarkdownLink,
  code: InlineCode,
  table: ({ node, children }) => <MarkdownTable node={node as HastNode | undefined}>{children}</MarkdownTable>,
  p: withSelectableRuns("p"),
  li: ListItem,
  ol: OrderedList,
  h1: withSelectableRuns("h1"),
  h2: withSelectableRuns("h2"),
  h3: withSelectableRuns("h3"),
  h4: withSelectableRuns("h4"),
  h5: withSelectableRuns("h5"),
  h6: withSelectableRuns("h6"),
  td: withSelectableRuns("td"),
  th: withSelectableRuns("th"),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

const MODEL_PLUGINS: PluggableList = [[rehypeSanitize, sanitizeSchema]];
const FILE_PLUGINS: PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

export const Markdown = ({ text, isStreaming = false, sourcePath }: { text: string; isStreaming?: boolean; sourcePath?: string }) => {
  const renderedText = useDeferredValue(text);
  return (
    <StreamingContext.Provider value={isStreaming}>
      <SourcePathContext.Provider value={sourcePath}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={sourcePath === undefined ? MODEL_PLUGINS : FILE_PLUGINS} components={components}>
          {isStreaming ? renderedText : text}
        </ReactMarkdown>
      </SourcePathContext.Provider>
    </StreamingContext.Provider>
  );
};
