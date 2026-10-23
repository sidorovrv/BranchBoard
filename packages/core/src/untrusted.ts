import { isSafeChoice } from "./choices";
import { MAX_COMMENT_CHARS, MAX_COMMENTS_PER_NODE, NODE_MAX_HEIGHT, NODE_MAX_WIDTH } from "./graph";
import type { PartType } from "./kit/types";
import type { Attachment, ContextMode, DocumentFile, GraphEdge, GraphNode, Id, NodeComment, NodeKind, NodeStatus, NodeSummary, Part, RollSnapshot, Usage } from "./types";

export const MAX_UNTRUSTED_NODES = 2000;
export const MAX_UNTRUSTED_PARTS = 50000;
export const MAX_UNTRUSTED_EDGES = 10000;

const MAX_TEXT_CHARS = 2_000_000;
const MAX_SHORT_CHARS = 2000;
const MAX_COORDINATE = 10_000_000;
const MIN_NODE_SIDE = 40;

const NODE_KINDS: NodeKind[] = ["turn", "context", "file", "subagent", "code"];
const NODE_STATUSES: NodeStatus[] = ["idle", "queued", "running", "awaiting_approval", "done", "error", "interrupted"];
const CONTEXT_MODES: ContextMode[] = ["exact", "injected", "assembled"];
const PART_TYPES: PartType[] = ["text", "reasoning", "tool", "error", "todo"];
const USAGE_KEYS: (keyof Usage)[] = ["inputTokens", "outputTokens", "contextTokens", "contextWindow", "cacheReadTokens", "cacheCreationTokens", "firstCallCacheReadTokens", "firstCallCacheCreationTokens"];

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown, maxChars = MAX_SHORT_CHARS): string | undefined => (typeof value === "string" && value.length <= maxChars ? value : undefined);

const numberOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const countOf = (value: unknown): number | undefined => {
  const number = numberOf(value);
  return number !== undefined && Number.isInteger(number) && number >= 0 ? number : undefined;
};

const clampedOf = (value: unknown, min: number, max: number, fallback: number): number => Math.min(max, Math.max(min, numberOf(value) ?? fallback));

const choiceOf = (value: unknown): string | undefined => (isSafeChoice(value) ? value : undefined);

const oneOf = <T extends string>(value: unknown, allowed: T[]): T | undefined => allowed.find((candidate) => candidate === value);

const idsOf = (value: unknown): Id[] | undefined =>
  Array.isArray(value) && value.length <= MAX_UNTRUSTED_NODES && value.every((item) => textOf(item) !== undefined) ? (value as Id[]) : undefined;

const usageOf = (value: unknown): Usage | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = USAGE_KEYS.flatMap((key) => (numberOf(value[key]) === undefined ? [] : [[key, value[key]]]));
  return entries.length === 0 ? undefined : ({ inputTokens: 0, outputTokens: 0, ...Object.fromEntries(entries) } as Usage);
};

const attachmentsOf = (value: unknown): Attachment[] | undefined => {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const kept = value.flatMap((item): Attachment[] => {
    if (!isRecord(item)) return [];
    const [id, name, mime, size] = [textOf(item.id), textOf(item.name), textOf(item.mime), countOf(item.size)];
    return id !== undefined && name !== undefined && mime !== undefined && size !== undefined ? [{ id, name, mime, size }] : [];
  });
  return kept.length > 0 ? kept : undefined;
};

const summaryOf = (value: unknown): NodeSummary | undefined => {
  if (!isRecord(value)) return undefined;
  const [text, coveredNodeIds, contextHash, rev, tokens] = [textOf(value.text, MAX_TEXT_CHARS), idsOf(value.coveredNodeIds), textOf(value.contextHash), countOf(value.rev), countOf(value.tokens)];
  if (text === undefined || !coveredNodeIds || contextHash === undefined || rev === undefined || tokens === undefined) return undefined;
  return { text, coveredNodeIds, contextHash, rev, tokens, model: choiceOf(value.model) };
};

const snapshotOf = (value: unknown): RollSnapshot | undefined => {
  if (!isRecord(value)) return undefined;
  const status = oneOf(value.status, NODE_STATUSES);
  if (!status) return undefined;
  return {
    status,
    contextHash: textOf(value.contextHash),
    contextNodeIds: idsOf(value.contextNodeIds),
    contextMode: oneOf(value.contextMode, CONTEXT_MODES),
    usage: usageOf(value.usage),
    stopped: typeof value.stopped === "boolean" ? value.stopped : undefined,
    startedAt: numberOf(value.startedAt),
    completedAt: numberOf(value.completedAt),
  };
};

const rollsOf = (value: unknown): Record<number, RollSnapshot> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, snapshot]) => (countOf(Number(key)) === undefined || key !== String(Number(key)) || snapshotOf(snapshot) === undefined ? [] : [[key, snapshotOf(snapshot)]]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const commentOf = (value: unknown): NodeComment | undefined => {
  if (!isRecord(value)) return undefined;
  const [id, roll, start, end, quote, text] = [textOf(value.id), countOf(value.roll), countOf(value.start), countOf(value.end), textOf(value.quote, MAX_COMMENT_CHARS), textOf(value.text, MAX_COMMENT_CHARS)];
  if (id === undefined || roll === undefined || start === undefined || end === undefined || quote === undefined || text === undefined) return undefined;
  return { id, roll, start, end, quote, text };
};

const commentsOf = (value: unknown): NodeComment[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const comments = value.slice(0, MAX_COMMENTS_PER_NODE).flatMap((item) => commentOf(item) ?? []);
  return comments.length > 0 ? comments : undefined;
};

export const sanitiseNode = (raw: unknown): GraphNode | undefined => {
  if (!isRecord(raw)) return undefined;
  const [id, kind, status, title, prompt] = [textOf(raw.id), oneOf(raw.kind, NODE_KINDS), oneOf(raw.status, NODE_STATUSES), textOf(raw.title), textOf(raw.prompt, MAX_TEXT_CHARS)];
  if (id === undefined || !kind || !status || title === undefined || prompt === undefined) return undefined;
  return {
    id,
    boardId: textOf(raw.boardId) ?? "",
    kind,
    model: choiceOf(raw.model),
    effort: choiceOf(raw.effort),
    status,
    title,
    prompt,
    quoteText: textOf(raw.quoteText, MAX_TEXT_CHARS),
    filePath: textOf(raw.filePath),
    sourceAttachmentId: textOf(raw.sourceAttachmentId),
    attachments: attachmentsOf(raw.attachments),
    x: clampedOf(raw.x, -MAX_COORDINATE, MAX_COORDINATE, 0),
    y: clampedOf(raw.y, -MAX_COORDINATE, MAX_COORDINATE, 0),
    w: clampedOf(raw.w, MIN_NODE_SIDE, NODE_MAX_WIDTH, NODE_MAX_WIDTH / 2),
    h: clampedOf(raw.h, MIN_NODE_SIDE, NODE_MAX_HEIGHT, NODE_MAX_HEIGHT / 8),
    collapsed: raw.collapsed === true,
    forceAssemble: raw.forceAssemble === true,
    rev: countOf(raw.rev) ?? 0,
    contextHash: textOf(raw.contextHash),
    contextNodeIds: idsOf(raw.contextNodeIds),
    contextMode: oneOf(raw.contextMode, CONTEXT_MODES),
    usage: usageOf(raw.usage),
    stopped: typeof raw.stopped === "boolean" ? raw.stopped : undefined,
    createdAt: numberOf(raw.createdAt) ?? 0,
    startedAt: numberOf(raw.startedAt),
    completedAt: numberOf(raw.completedAt),
    activeRoll: countOf(raw.activeRoll),
    rollCount: countOf(raw.rollCount),
    rolls: rollsOf(raw.rolls),
    comments: commentsOf(raw.comments),
    pinned: raw.pinned === true ? true : undefined,
    satelliteOf: textOf(raw.satelliteOf),
    summary: summaryOf(raw.summary),
    deleted: false,
  };
};

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_EXPORT_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_UNTRUSTED_FILES = 1000;

const FILE_ID_PATTERN = /^[0-9a-f-]{36}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MEGABYTE = 1024 * 1024;

export const base64ByteLength = (base64: string): number => Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

export const megabytesLabel = (bytes: number): string => `${(bytes / MEGABYTE).toFixed(1)} MB`;

const fileOf = (raw: unknown): DocumentFile | undefined => {
  if (!isRecord(raw)) return undefined;
  const [name, mime, base64] = [textOf(raw.name), textOf(raw.mime), typeof raw.base64 === "string" ? raw.base64 : undefined];
  if (name === undefined || mime === undefined || base64 === undefined || base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) return undefined;
  const size = base64ByteLength(base64);
  return size > 0 && size <= MAX_FILE_BYTES ? { name: name.replace(/[\\/\0]/g, "_") || "file", mime, base64 } : undefined;
};

export const sanitiseFiles = (raw: unknown): Record<Id, DocumentFile> => {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("The embedded files are malformed");
  const entries = Object.entries(raw);
  if (entries.length > MAX_UNTRUSTED_FILES) throw new Error(`Too many embedded files (limit ${MAX_UNTRUSTED_FILES})`);
  const kept = entries.flatMap(([id, file]): [Id, DocumentFile][] => {
    const clean = FILE_ID_PATTERN.test(id) ? fileOf(file) : undefined;
    return clean ? [[id, clean]] : [];
  });
  const total = kept.reduce((sum, [, file]) => sum + base64ByteLength(file.base64), 0);
  if (total > MAX_EXPORT_FILE_BYTES) throw new Error(`The embedded files add up to ${megabytesLabel(total)}; the limit is ${megabytesLabel(MAX_EXPORT_FILE_BYTES)}`);
  return Object.fromEntries(kept);
};

export const sanitisePart = (raw: unknown): Part | undefined => {
  if (!isRecord(raw)) return undefined;
  const [id, nodeId, type, text, seq] = [textOf(raw.id), textOf(raw.nodeId), oneOf(raw.type, PART_TYPES), textOf(raw.text, MAX_TEXT_CHARS), numberOf(raw.seq)];
  if (id === undefined || nodeId === undefined || !type || text === undefined || seq === undefined) return undefined;
  return { id, nodeId, type, text, seq, roll: countOf(raw.roll), meta: isRecord(raw.meta) ? raw.meta : undefined };
};

export const sanitiseEdge = (raw: unknown): Pick<GraphEdge, "fromId" | "toId" | "seq"> | undefined => {
  if (!isRecord(raw)) return undefined;
  const [fromId, toId] = [textOf(raw.fromId), textOf(raw.toId)];
  return fromId === undefined || toId === undefined ? undefined : { fromId, toId, seq: numberOf(raw.seq) ?? 0 };
};

export const sanitiseList = <T>(raw: unknown[], sanitiseItem: (item: unknown) => T | undefined, limit: number, label: string): T[] => {
  if (raw.length > limit) throw new Error(`Too many ${label} (limit ${limit})`);
  const kept = raw.map(sanitiseItem);
  if (kept.some((item) => item === undefined)) throw new Error(`At least one of the ${label} is malformed`);
  return kept as T[];
};

export const hasCycle = (nodeIds: Id[], edges: { fromId: Id; toId: Id }[]): boolean => {
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  edges.forEach((edge) => incoming.set(edge.toId, (incoming.get(edge.toId) ?? 0) + 1));
  const ready = nodeIds.filter((id) => incoming.get(id) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop()!;
    visited++;
    edges.filter((edge) => edge.fromId === id).forEach((edge) => {
      incoming.set(edge.toId, incoming.get(edge.toId)! - 1);
      if (incoming.get(edge.toId) === 0) ready.push(edge.toId);
    });
  }
  return visited < nodeIds.length;
};
