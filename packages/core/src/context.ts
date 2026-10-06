import { adjacencyOf, ancestorIds, descendantIds, incomingEdges, makeNode, runEdit } from "./graph";
import { activeRollOf, partsOfRoll } from "./rolls";
import { estimateTokens, fnv1a, isRefusal, unique } from "./helpers";
import type { Attachment, BoardGraph, ContextMode, GraphEdit, GraphNode, Id, Part, SessionPlan, Turn } from "./types";

export type PartsByNode = Record<Id, Part[]>;

export const answerText = (parts: Part[] | undefined, roll: number): string =>
  partsOfRoll(parts, roll)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export const turnOf = (node: GraphNode, parts: PartsByNode): Turn => ({
  nodeId: node.id,
  kind: node.kind,
  title: node.title,
  input: withQuote(node.prompt, node.quoteText),
  output: node.kind === "turn" ? answerText(parts[node.id], activeRollOf(node)) : "",
  attachments: node.attachments ?? [],
});

export const orderedAncestorIds = (graph: BoardGraph, id: Id): Id[] => {
  const { parents } = adjacencyOf(graph);
  const ordered: Id[] = [];
  const visited = new Set<Id>();
  const visit = (current: Id) => {
    if (visited.has(current)) return;
    visited.add(current);
    for (const edge of parents.get(current) ?? []) visit(edge.fromId);
    ordered.push(current);
  };
  for (const edge of parents.get(id) ?? []) visit(edge.fromId);
  return ordered;
};

export const contextTurns = (graph: BoardGraph, parts: PartsByNode, id: Id): Turn[] =>
  orderedAncestorIds(graph, id).map((ancestorId) => turnOf(graph.nodes[ancestorId], parts));

export const contextHash = (graph: BoardGraph, id: Id): string =>
  fnv1a(orderedAncestorIds(graph, id).map((ancestorId) => `${ancestorId}:${graph.nodes[ancestorId].rev}`).join("|"));

export const isStale = (graph: BoardGraph, node: GraphNode): boolean =>
  node.kind === "turn" && node.status === "done" && node.contextHash !== undefined && node.contextHash !== contextHash(graph, node.id);

const isSessionReusable = (graph: BoardGraph, parent: GraphNode): boolean =>
  parent.status === "done" && parent.runtimeRef !== undefined && parent.contextHash === contextHash(graph, parent.id);

export const isSummaryUsable = (graph: BoardGraph, node: GraphNode): boolean =>
  Boolean(node.summary?.text) && node.status === "done" && node.summary!.rev === node.rev && node.summary!.contextHash === contextHash(graph, node.id);

const summaryTurnOf = (graph: BoardGraph, parts: PartsByNode, node: GraphNode): Turn => {
  const covered = node.summary!.coveredNodeIds;
  return {
    nodeId: node.id,
    kind: "summary",
    coveredNodeIds: covered,
    title: node.title,
    input: node.summary!.text,
    output: "",
    attachments: covered.flatMap((coveredId) => turnOf(graph.nodes[coveredId], parts).attachments),
  };
};

const turnsWithSummary = (graph: BoardGraph, parts: PartsByNode, missingIds: Id[]): Turn[] => {
  const missing = new Set(missingIds);
  const summarised = [...missingIds].reverse().find((id) => isSummaryUsable(graph, graph.nodes[id]) && graph.nodes[id].summary!.coveredNodeIds.every((coveredId) => missing.has(coveredId)));
  if (!summarised) return missingIds.map((missingId) => turnOf(graph.nodes[missingId], parts));
  const covered = new Set(graph.nodes[summarised].summary!.coveredNodeIds);
  return [summaryTurnOf(graph, parts, graph.nodes[summarised]), ...missingIds.filter((id) => !covered.has(id)).map((id) => turnOf(graph.nodes[id], parts))];
};

export const summarySource = (graph: BoardGraph, parts: PartsByNode, id: Id): { text: string; coveredNodeIds: Id[] } => {
  const coveredNodeIds = [...orderedAncestorIds(graph, id), id];
  return { text: renderTurns(coveredNodeIds.map((coveredId) => turnOf(graph.nodes[coveredId], parts))), coveredNodeIds };
};

export const planSession = (graph: BoardGraph, parts: PartsByNode, id: Id): SessionPlan => {
  const node = graph.nodes[id];
  const ancestors = orderedAncestorIds(graph, id);
  const spineParent = node.forceAssemble
    ? undefined
    : incomingEdges(graph, id)
        .map((edge) => graph.nodes[edge.fromId])
        .find((parent) => isSessionReusable(graph, parent));
  const covered = new Set<Id>(spineParent ? [spineParent.id, ...(spineParent.contextNodeIds ?? [])] : []);
  const missingIds = ancestors.filter((ancestorId) => !covered.has(ancestorId));
  return {
    spine: spineParent ? { nodeId: spineParent.id, runtimeRef: spineParent.runtimeRef! } : undefined,
    missingTurns: turnsWithSummary(graph, parts, missingIds),
  };
};

export const fidelityOf = (plan: SessionPlan): ContextMode => {
  if (plan.missingTurns.length === 0) return "exact";
  return plan.spine ? "injected" : "assembled";
};

const attachmentLines = (turn: Turn): string[] => turn.attachments.map((item) => `[attached file: ${item.name} (${item.mime})]`);

const turnLineBuilders: Record<Turn["kind"], (turn: Turn) => string[]> = {
  summary: (turn) => [`[summary of the earlier conversation]`, turn.input, ...attachmentLines(turn)],
  subagent: () => [],
  context: (turn) => [`[note: ${turn.title}]`, turn.input],
  file: (turn) => [`[files: ${turn.title}]`, ...attachmentLines(turn)],
  code: (turn) => [`[file: ${turn.title}]`, "```", turn.input, "```"],
  turn: (turn) => [`[user]`, turn.input, ...attachmentLines(turn), `[assistant]`, turn.output],
};

const renderTurnLines = (turn: Turn): string[] => turnLineBuilders[turn.kind](turn);

export const attachmentsToSend = (plan: SessionPlan, node: GraphNode): Attachment[] => [...plan.missingTurns.flatMap((turn) => turn.attachments), ...(node.attachments ?? [])];

export const renderTurns = (turns: Turn[]): string =>
  turns.length === 0 ? "" : ["<branchboard_context>", ...turns.flatMap(renderTurnLines), "</branchboard_context>"].join("\n");

const withQuote = (prompt: string, quoteText: string | undefined): string =>
  quoteText ? `Regarding this passage from the previous answer:\n${quoteText.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${prompt}` : prompt;

export const renderInput = (plan: SessionPlan, prompt: string, quoteText?: string): string => {
  const contextBlock = renderTurns(plan.missingTurns);
  const request = withQuote(prompt, quoteText);
  return contextBlock ? `${contextBlock}\n\n${request}` : request;
};

export const IMAGE_ATTACHMENT_TOKENS = 1500;

export const estimateAttachmentTokens = (attachment: Attachment): number =>
  attachment.mime.startsWith("image/") ? IMAGE_ATTACHMENT_TOKENS : Math.ceil(attachment.size / 4);

const estimateAttachmentsTokens = (attachments: Attachment[]): number => attachments.reduce((total, attachment) => total + estimateAttachmentTokens(attachment), 0);

const hasEstimatedAttachment = (attachments: Attachment[]): boolean => attachments.some((attachment) => !attachment.mime.startsWith("text/"));

const republishedTokens = (plan: SessionPlan): number =>
  estimateTokens(renderTurns(plan.missingTurns)) + estimateAttachmentsTokens(plan.missingTurns.flatMap((turn) => turn.attachments));

export interface Republication {
  nodeId: Id;
  tokens: number;
  mode: ContextMode;
  staleCount: number;
}

const relinkTargets: Partial<Record<GraphEdit["type"], (graph: BoardGraph, edit: any) => Id[]>> = {
  connect: (_graph, edit) => [edit.toId],
  disconnect: (graph, edit) => [graph.edges[edit.edgeId].toId],
  reattach: (graph, edit) => unique([graph.edges[edit.edgeId].toId, edit.end === "to" ? edit.nodeId : graph.edges[edit.edgeId].toId]),
  reorderParents: (_graph, edit) => [edit.nodeId],
};

export const estimateRepublication = (graph: BoardGraph, parts: PartsByNode, edit: GraphEdit): Republication[] => {
  const result = runEdit(graph, edit);
  const targets = relinkTargets[edit.type]?.(graph, edit);
  if (isRefusal(result) || !targets) return [];
  return targets.map((nodeId) => {
    const plan = planSession(result.graph, parts, nodeId);
    const affected = [nodeId, ...descendantIds(result.graph, nodeId)].filter((id) => result.graph.nodes[id].status === "done");
    return { nodeId, tokens: republishedTokens(plan), mode: fidelityOf(plan), staleCount: affected.length };
  });
};

export const estimateChildRepublication = (graph: BoardGraph, parts: PartsByNode, parentIds: Id[]): number => {
  const probe = makeNode("probe", { id: "probe-node" });
  const result = runEdit(graph, { type: "addNode", node: probe, parentIds });
  return isRefusal(result) ? 0 : republishedTokens(planSession(result.graph, parts, probe.id));
};

export interface ContextDescription {
  turns: Turn[];
  tokens: number;
  republished: number;
  mode: ContextMode;
  hash: string;
  plan: SessionPlan;
  parentIds: Id[];
  isApproximate: boolean;
  summarisedNodeIds: Id[];
}

export const describeContext = (graph: BoardGraph, parts: PartsByNode, id: Id): ContextDescription => {
  const turns = contextTurns(graph, parts, id);
  const plan = planSession(graph, parts, id);
  const inputText = renderTurns(turns) + graph.nodes[id].prompt;
  const attachments = [...turns.flatMap((turn) => turn.attachments), ...(graph.nodes[id].attachments ?? [])];
  return {
    turns,
    tokens: estimateTokens(inputText) + estimateAttachmentsTokens(attachments),
    isApproximate: hasEstimatedAttachment(attachments),
    republished: republishedTokens(plan),
    mode: fidelityOf(plan),
    hash: contextHash(graph, id),
    plan,
    parentIds: incomingEdges(graph, id).map((edge) => edge.fromId),
    summarisedNodeIds: plan.missingTurns.flatMap((turn) => turn.coveredNodeIds ?? []),
  };
};

export const ancestorEdgeIds = (graph: BoardGraph, id: Id): Set<Id> => {
  const members = new Set([id, ...ancestorIds(graph, id)]);
  const { parents } = adjacencyOf(graph);
  const edgeIds = new Set<Id>();
  for (const member of members) for (const edge of parents.get(member) ?? []) edgeIds.add(edge.id);
  return edgeIds;
};
