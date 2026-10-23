import { activeRollOf, partsOfRoll, toolInputView, type GraphNode, type Part } from "@branchboard/core";

const CONTEXT_CHARS = 36;
export const MAX_HITS = 200;

export type HitField = "title" | "prompt" | "answer" | "tool";

export interface SearchHit {
  nodeId: string;
  field: HitField;
  toolName?: string;
  toolOrdinal?: number;
  occurrence: number;
  nodeOccurrence: number;
  duplicate: number;
  before: string;
  match: string;
  after: string;
}

interface Source {
  field: HitField;
  text: string;
  toolName?: string;
  toolOrdinal?: number;
}

const toolTextOf = (part: Part): string => {
  const inputView = toolInputView(part.meta?.input);
  const input = inputView ? [inputView.primaryText, inputView.remaining ? JSON.stringify(inputView.remaining, null, 2) : ""] : [part.meta?.input === undefined ? "" : JSON.stringify(part.meta.input, null, 2)];
  const output = part.meta?.output === undefined ? "" : String(part.meta.output);
  return [part.text, ...input, output].filter(Boolean).join("\n");
};

const sourcesOf = (node: GraphNode, parts: Part[] | undefined): Source[] => {
  const rolled = partsOfRoll(parts, activeRollOf(node));
  const tools = rolled.filter((part) => part.type === "tool");
  return [
    { field: "title", text: node.title },
    { field: "prompt", text: node.prompt },
    { field: "answer", text: rolled.filter((part) => part.type === "text").map((part) => part.text).join("") },
    ...tools.map((part, toolOrdinal) => ({ field: "tool" as const, text: toolTextOf(part), toolName: String(part.meta?.tool ?? ""), toolOrdinal })),
  ];
};

const flatten = (text: string): string => text.replace(/\s+/g, " ");

const snippetAround = (text: string, at: number, length: number) => {
  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(text.length, at + length + CONTEXT_CHARS);
  return {
    before: `${start > 0 ? "…" : ""}${flatten(text.slice(start, at))}`,
    match: flatten(text.slice(at, at + length)),
    after: `${flatten(text.slice(at + length, end))}${end < text.length ? "…" : ""}`,
  };
};

export const hitsOfNode = (node: GraphNode, parts: Part[] | undefined, needle: string): SearchHit[] => {
  const hits: SearchHit[] = [];
  const counts = { text: 0, tool: 0 };
  const seenContexts = new Map<string, number>();
  for (const source of sourcesOf(node, parts)) {
    const content = source.text.toLowerCase();
    const kind = source.field === "tool" ? "tool" : "text";
    let occurrence = 0;
    for (let at = content.indexOf(needle); at >= 0; at = content.indexOf(needle, at + needle.length)) {
      const snippet = snippetAround(source.text, at, needle.length);
      const contextKey = `${source.toolOrdinal ?? kind}|${snippet.before}|${snippet.match}|${snippet.after}`;
      const duplicate = seenContexts.get(contextKey) ?? 0;
      seenContexts.set(contextKey, duplicate + 1);
      hits.push({ nodeId: node.id, field: source.field, toolName: source.toolName, toolOrdinal: source.toolOrdinal, occurrence: occurrence++, nodeOccurrence: counts[kind]++, duplicate, ...snippet });
    }
  }
  return hits;
};

export const hitsOfNodes = (nodes: GraphNode[], partsByNode: Record<string, Part[]>, needle: string): SearchHit[] => {
  const hits: SearchHit[] = [];
  for (const node of nodes) {
    if (hits.length >= MAX_HITS) break;
    hits.push(...hitsOfNode(node, partsByNode[node.id], needle));
  }
  return hits.slice(0, MAX_HITS);
};
