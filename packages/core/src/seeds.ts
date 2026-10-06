import { inheritChoices, withBoardDefaults, type RunChoices } from "./choices";
import { BRANCH_TITLE_SEPARATOR, childIdsOf, makeNode, minSizeOf, NODE_HEIGHT, NODE_MAX_HEIGHT, NODE_MAX_WIDTH, NODE_WIDTH, NOTE_HEIGHT, NOTE_WIDTH, parentIdsOf, placeNode, type PlacementAnchor, type PlacementFlow } from "./graph";
import { fileNameOf } from "./codeFiles";
import { deriveTitle } from "./helpers";
import type { Attachment, Board, BoardGraph, GraphEdit, GraphNode, Id } from "./types";

export interface NodeSeed extends RunChoices {
  kind: GraphNode["kind"];
  parentIds: Id[];
  prompt: string;
  attachments?: Attachment[];
  quoteText?: string;
  filePath?: string;
  sourceAttachmentId?: Id;
  width?: number;
  height?: number;
  anchor?: PlacementAnchor;
  near?: { x: number; y: number };
  flow?: PlacementFlow;
}

export interface SeedCommand extends RunChoices {
  type: "reply" | "sibling" | "note" | "file" | "code";
  attachments?: Attachment[];
  filePath?: string;
  sourceAttachmentId?: Id;
  isOriginLinked?: boolean;
  parentIds?: Id[];
  originalId?: Id;
  originId?: Id;
  snapBelow?: boolean;
  prompt?: string;
  quoteText?: string;
  position?: { x: number; y: number };
  nearPosition?: { x: number; y: number };
  flowDirection?: PlacementFlow;
  run?: boolean;
  width?: number;
  height?: number;
}

const isPoint = (value: unknown): value is { x: number; y: number } =>
  typeof value === "object" && value !== null && Number.isFinite((value as { x: unknown }).x) && Number.isFinite((value as { y: unknown }).y);

const seedsByKind: Record<SeedCommand["type"], (graph: BoardGraph, command: SeedCommand) => NodeSeed> = {
  reply: (graph, command) => ({
    kind: "turn",
    parentIds: command.parentIds ?? [],
    prompt: command.prompt ?? "",
    ...inheritChoices(command, graph.nodes[command.parentIds?.[0] ?? ""]),
    quoteText: command.quoteText,
    width: graph.nodes[command.parentIds?.[0] ?? ""]?.w ?? command.width,
    height: graph.nodes[command.parentIds?.[0] ?? ""]?.h ?? command.height,
    anchor: command.snapBelow && command.parentIds?.[0] ? { id: command.parentIds[0], side: "below" } : undefined,
  }),
  sibling: (graph, command) => {
    const original = graph.nodes[command.originalId!];
    return {
      kind: original.kind,
      parentIds: parentIdsOf(graph, original.id),
      prompt: command.prompt ?? original.prompt,
      ...inheritChoices(command, original),
      quoteText: original.quoteText,
      attachments: original.attachments,
      width: original.w,
      height: original.h,
      anchor: { id: original.id, side: "below" },
    };
  },
  note: (_graph, command) => ({ kind: "context", parentIds: [], prompt: command.prompt ?? "", width: NOTE_WIDTH, height: NOTE_HEIGHT, anchor: command.originId ? { id: command.originId, side: "beside" } : undefined }),
  file: (_graph, command) => ({ kind: "file", parentIds: [], prompt: "", attachments: command.attachments ?? [], width: command.width, height: command.height }),
  code: (graph, command) => {
    const origin = command.originId ? graph.nodes[command.originId] : undefined;
    const canBranch = origin !== undefined && !origin.deleted && origin.kind !== "subagent" && command.isOriginLinked !== false;
    return { kind: "code", parentIds: canBranch ? [origin.id] : [], prompt: command.prompt ?? "", filePath: command.filePath, sourceAttachmentId: command.sourceAttachmentId, anchor: origin && !canBranch ? { id: origin.id, side: "beside" } : undefined };
  },
};

export const seedFrom = Object.fromEntries(
  Object.entries(seedsByKind).map(([type, seed]) => [type, (graph: BoardGraph, command: SeedCommand): NodeSeed => ({ ...seed(graph, command), near: isPoint(command.nearPosition) ? command.nearPosition : undefined, flow: command.flowDirection === "vertical" ? "vertical" : "horizontal" })]),
) as typeof seedsByKind;

export const DEFAULT_CHAT_TITLE = "New chat";
export const DEFAULT_BOARD_TITLE = "Untitled board";

export const hasAutoTitle = (node: GraphNode): boolean => {
  const promptTitle = deriveTitle(node.prompt, DEFAULT_CHAT_TITLE);
  return (
    node.title === DEFAULT_CHAT_TITLE ||
    node.title === promptTitle ||
    node.title.endsWith(`${BRANCH_TITLE_SEPARATOR}${promptTitle}`) ||
    node.title.endsWith(`${BRANCH_TITLE_SEPARATOR}${DEFAULT_CHAT_TITLE}`)
  );
};

export const titleForPrompt = (node: GraphNode, prompt: string): string => {
  const promptTitle = deriveTitle(prompt, DEFAULT_CHAT_TITLE);
  return node.title.includes(BRANCH_TITLE_SEPARATOR) ? `${node.title.split(BRANCH_TITLE_SEPARATOR)[0]}${BRANCH_TITLE_SEPARATOR}${promptTitle}` : promptTitle;
};

export type NamingRole = "new" | "branch";

export const namingRoleOf = (graph: BoardGraph, nodeId: Id): NamingRole | undefined => {
  const node = graph.nodes[nodeId];
  const parentIds = parentIdsOf(graph, nodeId);
  if (parentIds.length === 0) return "new";
  const isFork = parentIds.some((parentId) => childIdsOf(graph, parentId).length > 1);
  return node.quoteText || isFork ? "branch" : undefined;
};

const rootTitleOf = (graph: BoardGraph, nodeId: Id): string => {
  let rootId = nodeId;
  for (let parentId = parentIdsOf(graph, rootId)[0]; parentId; parentId = parentIdsOf(graph, rootId)[0]) rootId = parentId;
  return graph.nodes[rootId].title.split(BRANCH_TITLE_SEPARATOR)[0];
};

export const branchTitle = (graph: BoardGraph, nodeId: Id, branchName: string): string => {
  const firstParentId = parentIdsOf(graph, nodeId)[0];
  return firstParentId ? `${rootTitleOf(graph, firstParentId)}${BRANCH_TITLE_SEPARATOR}${branchName}` : branchName;
};

const isBranchSeed = (graph: BoardGraph, seed: NodeSeed): boolean =>
  seed.kind === "turn" && seed.parentIds.length > 0 && (Boolean(seed.quoteText) || seed.parentIds.some((parentId) => childIdsOf(graph, parentId).length > 0));

const placeholderTitle = (graph: BoardGraph, seed: NodeSeed): string => {
  if (seed.kind === "turn" && seed.parentIds.length > 0) {
    return isBranchSeed(graph, seed) ? `${rootTitleOf(graph, seed.parentIds[0])}${BRANCH_TITLE_SEPARATOR}${seedTitles.turn(seed)}` : graph.nodes[seed.parentIds[0]].title;
  }
  return seedTitles[seed.kind](seed);
};

const seedTitles: Record<GraphNode["kind"], (seed: NodeSeed) => string> = {
  subagent: (seed) => deriveTitle(seed.prompt, "Subagent"),
  turn: (seed) => deriveTitle(seed.prompt, DEFAULT_CHAT_TITLE),
  context: (seed) => deriveTitle(seed.prompt, "Note"),
  code: (seed) => (seed.filePath ? fileNameOf(seed.filePath) : "Code"),
  file: (seed) => (seed.attachments?.length ? deriveTitle(seed.attachments.map((item) => item.name).join(", "), "Files") : "Files"),
};

export const shouldAutoRun = (seed: NodeSeed, command: SeedCommand): boolean =>
  seed.kind === "turn" && seed.prompt.trim() !== "" && command.run !== false;

const seedSizeOf = (seed: NodeSeed): Partial<Pick<GraphNode, "w" | "h">> => ({
  ...(typeof seed.width === "number" && Number.isFinite(seed.width) ? { w: Math.min(NODE_MAX_WIDTH, Math.max(minSizeOf(seed.kind).w, Math.round(seed.width))) } : {}),
  ...(typeof seed.height === "number" && Number.isFinite(seed.height) ? { h: Math.min(NODE_MAX_HEIGHT, Math.max(minSizeOf(seed.kind).h, Math.round(seed.height))) } : {}),
});

export const addNodeEdit = (graph: BoardGraph, board: Board, seed: NodeSeed, position?: { x: number; y: number }): Extract<GraphEdit, { type: "addNode" }> => {
  const size = seedSizeOf(seed);
  return {
    type: "addNode",
    parentIds: seed.parentIds,
    node: makeNode(board.id, {
      kind: seed.kind,
      prompt: seed.prompt,
      title: placeholderTitle(graph, seed),
      attachments: seed.attachments,
      ...withBoardDefaults(seed, board),
      quoteText: seed.quoteText,
      filePath: seed.filePath,
      sourceAttachmentId: seed.sourceAttachmentId,
      ...size,
      ...(position ?? placeNode(graph, seed.parentIds, { w: size.w ?? NODE_WIDTH, h: size.h ?? NODE_HEIGHT }, seed.anchor, seed.near, seed.flow)),
    }),
  };
};
