import { contextHash, isStale } from "./context";
import { liveEdges, liveNodes } from "./graph";
import { indexBy, newId } from "./helpers";
import { LATEST_SCHEMA_VERSION, migrateDocumentWith } from "./migrations";
import type { Attachment, Board, BoardDocument, BoardGraph, DocumentFile, GraphEdge, GraphNode, Id, Part } from "./types";
import { hasCycle, MAX_EXPORT_FILE_BYTES, MAX_UNTRUSTED_EDGES, MAX_UNTRUSTED_NODES, MAX_UNTRUSTED_PARTS, megabytesLabel, sanitiseEdge, sanitiseFiles, sanitiseList, sanitiseNode, sanitisePart } from "./untrusted";

const DOCUMENT_VERSION = LATEST_SCHEMA_VERSION;
export const COMMAND_TYPE_HEADER = "x-command-type";
const DOCUMENT_FORMAT = "branchboard";
const LEGACY_DOCUMENT_FORMAT = "wanderboard";

export interface BoardSnapshot {
  board: Board;
  graph: BoardGraph;
  parts: Record<Id, Part[]>;
}

export const collectBoard = ({ board, graph, parts }: BoardSnapshot): BoardDocument => {
  const nodes = liveNodes(graph);
  return {
    format: DOCUMENT_FORMAT,
    version: DOCUMENT_VERSION,
    board,
    nodes,
    edges: liveEdges(graph),
    parts: nodes.flatMap((node) => parts[node.id] ?? []),
    staleNodeIds: nodes.filter((node) => isStale(graph, node)).map((node) => node.id),
  };
};

export interface FileSource {
  sizeOf: (attachmentId: Id) => number | undefined;
  read: (attachmentId: Id) => DocumentFile;
}

export const attachmentIdsOf = (nodes: GraphNode[]): Id[] => [
  ...new Set(nodes.flatMap((node) => [...(node.attachments ?? []).map((attachment) => attachment.id), ...(node.sourceAttachmentId ? [node.sourceAttachmentId] : [])])),
];

export const embedFiles = (document: BoardDocument, source: FileSource, capBytes = MAX_EXPORT_FILE_BYTES): BoardDocument => {
  const sizes = attachmentIdsOf(document.nodes).flatMap((id): [Id, number][] => {
    const size = source.sizeOf(id);
    return size === undefined ? [] : [[id, size]];
  });
  const total = sizes.reduce((sum, [, size]) => sum + size, 0);
  if (total > capBytes) throw new Error(`The attached files add up to ${megabytesLabel(total)} and exports are limited to ${megabytesLabel(capBytes)}. Export without files, or remove large attachments.`);
  return sizes.length === 0 ? document : { ...document, files: Object.fromEntries(sizes.map(([id]) => [id, source.read(id)])) };
};

export type RestoreFile = (file: DocumentFile) => Attachment | undefined;

export const restoreFiles = (document: BoardDocument, restore: RestoreFile): BoardDocument => {
  const files = document.files ?? {};
  const restored = new Map<Id, Attachment | undefined>();
  const restoredBy = (id: Id): Attachment | undefined => {
    if (!restored.has(id)) restored.set(id, files[id] ? restore(files[id]) : undefined);
    return restored.get(id);
  };
  const nodes = document.nodes.map((node) => {
    const attachments = (node.attachments ?? []).flatMap((attachment) => restoredBy(attachment.id) ?? []);
    return { ...node, attachments: attachments.length > 0 ? attachments : undefined, sourceAttachmentId: node.sourceAttachmentId ? restoredBy(node.sourceAttachmentId)?.id : undefined };
  });
  return { ...document, nodes, files: undefined };
};

export const encoders: Record<string, (document: BoardDocument) => string> = {
  json: (document) => JSON.stringify(document, null, 2),
};

export const decoders: Record<string, (raw: string) => unknown> = {
  json: (raw) => JSON.parse(raw),
};

const isDocument = (value: unknown): value is BoardDocument => {
  const candidate = value as Omit<BoardDocument, "format"> & { format?: string };
  return (
    (candidate?.format === DOCUMENT_FORMAT || candidate?.format === LEGACY_DOCUMENT_FORMAT) &&
    typeof candidate.version === "number" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    Array.isArray(candidate.parts) &&
    typeof candidate.board === "object"
  );
};

export const validateDocument = (value: unknown): BoardDocument => {
  if (!isDocument(value)) throw new Error("Not a Branchboard export");
  if (value.version > DOCUMENT_VERSION) throw new Error(`Export version ${value.version} is newer than this app understands`);
  return { ...value, format: DOCUMENT_FORMAT };
};

export const migrateDocument = (document: BoardDocument): BoardDocument => migrateDocumentWith(document);

const STALE_MARKER = "imported-stale";
const MAX_TITLE_CHARS = 200;

export interface ImportedBoard {
  boardId: Id;
  title: string;
  graph: BoardGraph;
  parts: Record<Id, Part[]>;
}

export const sanitiseDocument = (document: BoardDocument): BoardDocument => {
  const nodes = sanitiseList(document.nodes, sanitiseNode, MAX_UNTRUSTED_NODES, "nodes");
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("Two nodes share one id");
  const edges = sanitiseList(document.edges, sanitiseEdge, MAX_UNTRUSTED_EDGES, "edges")
    .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId) && edge.fromId !== edge.toId)
    .map((edge) => ({ ...edge, id: "", boardId: "", createdAt: 0, deleted: false }));
  if (hasCycle([...nodeIds], edges)) throw new Error("The connections form a loop");
  const parts = sanitiseList(document.parts, sanitisePart, MAX_UNTRUSTED_PARTS, "parts").filter((part) => nodeIds.has(part.nodeId));
  const staleNodeIds = (Array.isArray(document.staleNodeIds) ? document.staleNodeIds : []).filter((id): id is Id => typeof id === "string");
  const title = typeof document.board?.title === "string" ? document.board.title.slice(0, MAX_TITLE_CHARS) : "";
  return { ...document, board: { ...document.board, title }, nodes, edges, parts, staleNodeIds, files: sanitiseFiles(document.files) };
};

export const reidentifyDocument = (document: BoardDocument, title?: string): ImportedBoard => {
  const boardId = newId();
  const nodeIds = new Map(document.nodes.map((node) => [node.id, newId()]));
  const remap = (id: Id): Id => nodeIds.get(id) ?? id;
  const nodes: GraphNode[] = document.nodes.map((node) => ({
    ...node,
    id: remap(node.id),
    boardId,
    runtimeRef: undefined,
    satelliteOf: node.satelliteOf === undefined ? undefined : nodeIds.get(node.satelliteOf),
    contextNodeIds: node.contextNodeIds?.map(remap),
    contextHash: node.contextHash === undefined ? undefined : STALE_MARKER,
    status: node.status === "done" ? "done" : node.kind === "turn" ? "interrupted" : node.status,
  }));
  const edges: GraphEdge[] = document.edges.map((edge) => ({ ...edge, id: newId(), boardId, fromId: remap(edge.fromId), toId: remap(edge.toId) }));
  const parts: Part[] = document.parts.map((part) => ({ ...part, id: part.id.replace(part.nodeId, remap(part.nodeId)), nodeId: remap(part.nodeId) }));
  const graph: BoardGraph = { nodes: indexBy(nodes, (node) => node.id), edges: indexBy(edges, (edge) => edge.id) };
  const staleIds = new Set(document.staleNodeIds.map(remap));
  const sourceGraph: BoardGraph = { nodes: indexBy(document.nodes, (node) => node.id), edges: Object.fromEntries(document.edges.map((edge, index) => [String(index), edge])) };
  const keepsSummary = (source: GraphNode): boolean => Boolean(source.summary) && source.summary!.rev === source.rev && source.summary!.contextHash === contextHash(sourceGraph, source.id);
  const settled = nodes.map((node, index) => {
    const source = document.nodes[index];
    const withHash = node.contextHash === STALE_MARKER && !staleIds.has(node.id) ? { ...node, contextHash: contextHash(graph, node.id) } : node;
    if (!node.summary) return withHash;
    const summary = { ...node.summary, coveredNodeIds: node.summary.coveredNodeIds.map(remap), contextHash: keepsSummary(source) ? contextHash(graph, node.id) : "" };
    return { ...withHash, summary };
  });
  const partsByNode: Record<Id, Part[]> = {};
  parts.forEach((part) => (partsByNode[part.nodeId] = [...(partsByNode[part.nodeId] ?? []), part]));
  return { boardId, title: title ?? `${document.board.title} (imported)`, graph: { ...graph, nodes: indexBy(settled, (node) => node.id) }, parts: partsByNode };
};

export const importBoardDocument = (raw: string, format = "json", title?: string, restore: RestoreFile = () => undefined): ImportedBoard =>
  reidentifyDocument(restoreFiles(sanitiseDocument(migrateDocument(validateDocument(decoders[format](raw)))), restore), title);
