import { randomBytes } from "node:crypto";
import { APPROVAL_TOOL_NAME } from "./claudeStream";

export interface ApprovalCall {
  toolName: string;
  input: Record<string, any>;
  toolUseId?: string;
}

export type ApprovalVerdict = { behavior: "allow"; updatedInput: Record<string, any> } | { behavior: "deny"; message: string };

export type ApprovalHandler = (call: ApprovalCall) => Promise<ApprovalVerdict>;

export interface BrokerReply {
  status: 200 | 202 | 404;
  body?: unknown;
}

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const approveToolDefinition = {
  name: APPROVAL_TOOL_NAME,
  description: "Asks the Branchboard user whether a tool call may run, and relays their answers to questions.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
};

const success = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const parseCall = (params: any): ApprovalCall | undefined => {
  const args = params?.arguments;
  if (typeof args?.tool_name !== "string") return undefined;
  return { toolName: args.tool_name, input: args.input && typeof args.input === "object" ? args.input : {}, toolUseId: typeof args.tool_use_id === "string" ? args.tool_use_id : undefined };
};

const decide = async (handler: ApprovalHandler, call: ApprovalCall): Promise<ApprovalVerdict> => {
  try {
    return await handler(call);
  } catch (error) {
    return { behavior: "deny", message: `Branchboard could not ask for approval: ${error instanceof Error ? error.message : String(error)}` };
  }
};

const respondToCall = async (handler: ApprovalHandler, message: any) => {
  const call = message.params?.name === APPROVAL_TOOL_NAME ? parseCall(message.params) : undefined;
  if (!call) return failure(message.id, INVALID_PARAMS, "Unknown tool or missing arguments");
  const verdict = await decide(handler, call);
  return success(message.id, { content: [{ type: "text", text: JSON.stringify(verdict) }] });
};

const respond = async (handler: ApprovalHandler, message: any): Promise<unknown | undefined> => {
  if (message?.id === undefined || message.id === null) return undefined;
  if (message.method === "initialize")
    return success(message.id, { protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "branchboard-approvals", version: "1.0.0" } });
  if (message.method === "ping") return success(message.id, {});
  if (message.method === "tools/list") return success(message.id, { tools: [approveToolDefinition] });
  if (message.method === "tools/call") return respondToCall(handler, message);
  return failure(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
};

export const createApprovalBroker = () => {
  const handlers = new Map<string, ApprovalHandler>();

  const register = (handler: ApprovalHandler) => {
    const secret = randomBytes(24).toString("hex");
    handlers.set(secret, handler);
    return { secret, dispose: () => void handlers.delete(secret) };
  };

  const handle = async (secret: string, payload: unknown): Promise<BrokerReply> => {
    const handler = handlers.get(secret);
    if (!handler) return { status: 404 };
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = (await Promise.all(messages.map((message) => respond(handler, message)))).filter((reply) => reply !== undefined);
    if (replies.length === 0) return { status: 202 };
    return { status: 200, body: Array.isArray(payload) ? replies : replies[0] };
  };

  return { register, handle, registeredCount: () => handlers.size };
};

export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
