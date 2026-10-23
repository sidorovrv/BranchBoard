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

export interface ExtraTool {
  definition: { name: string; description: string; inputSchema: Record<string, unknown> };
  isEnabled: () => boolean;
  call: (args: Record<string, any>) => Promise<unknown>;
}

interface Registration {
  handler: ApprovalHandler;
  tools: ExtraTool[];
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

const textResult = (id: unknown, value: unknown, isError = false) => success(id, { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) });

const respondToExtraTool = async (tool: ExtraTool, message: any) => {
  try {
    return textResult(message.id, await tool.call(message.params?.arguments ?? {}));
  } catch (error) {
    return textResult(message.id, error instanceof Error ? error.message : String(error), true);
  }
};

const respondToCall = async ({ handler, tools }: Registration, message: any) => {
  const extra = tools.find((tool) => tool.isEnabled() && tool.definition.name === message.params?.name);
  if (extra) return respondToExtraTool(extra, message);
  const call = message.params?.name === APPROVAL_TOOL_NAME ? parseCall(message.params) : undefined;
  if (!call) return failure(message.id, INVALID_PARAMS, "Unknown tool or missing arguments");
  return textResult(message.id, await decide(handler, call));
};

const respond = async (registration: Registration, message: any): Promise<unknown | undefined> => {
  if (message?.id === undefined || message.id === null) return undefined;
  if (message.method === "initialize")
    return success(message.id, { protocolVersion: message.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "branchboard-approvals", version: "1.0.0" } });
  if (message.method === "ping") return success(message.id, {});
  if (message.method === "tools/list") return success(message.id, { tools: [approveToolDefinition, ...registration.tools.filter((tool) => tool.isEnabled()).map((tool) => tool.definition)] });
  if (message.method === "tools/call") return respondToCall(registration, message);
  return failure(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
};

export const createApprovalBroker = () => {
  const registrations = new Map<string, Registration>();

  const register = (handler: ApprovalHandler, tools: ExtraTool[] = []) => {
    const secret = randomBytes(24).toString("hex");
    registrations.set(secret, { handler, tools });
    return { secret, dispose: () => void registrations.delete(secret) };
  };

  const handle = async (secret: string, payload: unknown): Promise<BrokerReply> => {
    const registration = registrations.get(secret);
    if (!registration) return { status: 404 };
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = (await Promise.all(messages.map((message) => respond(registration, message)))).filter((reply) => reply !== undefined);
    if (replies.length === 0) return { status: 202 };
    return { status: 200, body: Array.isArray(payload) ? replies : replies[0] };
  };

  return { register, handle, isRegistered: (secret: string) => registrations.has(secret), registeredCount: () => registrations.size };
};

export type ApprovalBroker = ReturnType<typeof createApprovalBroker>;
