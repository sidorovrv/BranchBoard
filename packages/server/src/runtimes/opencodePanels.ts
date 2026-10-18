import type { PanelRow, RuntimePanel } from "@branchboard/core";
import type { OpencodeServer } from "./opencodeServer";

interface PanelRequest {
  method: "POST" | "DELETE";
  path: string;
  body?: unknown;
}

interface PanelSpec {
  id: string;
  title: string;
  hint?: string;
  empty: string;
  path: string;
  entriesOf?(body: any): any[];
  extraPathOf?(entry: any): string;
  rowOf(entry: any, extra?: any): PanelRow;
  requestFor?(actionId: string, entry: any): PanelRequest | undefined;
}

export interface PanelTransport {
  server: OpencodeServer;
  directory: string;
}

const MAX_SHELL_ROWS = 10;
const SHELL_OUTPUT_BYTES = 4000;
const SHELL_OUTPUT_TAIL_CHARS = 400;

const listOf = (body: any): any[] => (Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []);

const statusOf = (status: unknown): string => (typeof status === "string" ? status : String((status as any)?.status ?? "unknown"));

const packageTargetOf = (entry: any): string | undefined => (entry?.source?.type === "package" ? String(entry.source.target) : undefined);

const countText = (value: number, noun: string) => `${value} ${noun}`;

const statsRows = (body: any): PanelRow[] => {
  const stats = body?.data ?? {};
  const tokens = stats.tokens ?? {};
  return [
    { id: "sessions", label: "Sessions", detail: `${stats.sessions ?? 0}, subagents ${stats.subagents ?? 0}` },
    { id: "work", label: "Work", detail: `${countText(stats.prompts ?? 0, "prompts")}, ${countText(stats.steps ?? 0, "steps")}` },
    { id: "tokens", label: "Tokens", detail: `input ${tokens.input ?? 0}, output ${tokens.output ?? 0}, reasoning ${tokens.reasoning ?? 0}` },
    { id: "cost", label: "Cost", detail: `$${Number(stats.cost ?? 0).toFixed(4)}` },
    ...(stats.models ?? []).map((entry: any) => ({ id: `${entry.model?.providerID}/${entry.model?.id}`, label: `${entry.model?.providerID}/${entry.model?.id}`, detail: `${countText(entry.steps ?? 0, "steps")}, $${Number(entry.cost ?? 0).toFixed(4)}` })),
  ];
};

const BASE_SPECS: PanelSpec[] = [
  {
    id: "permissions",
    title: "Saved permissions",
    hint: "Rules the runtime applies without asking. Remove a rule to be asked again.",
    empty: "No permission is saved. Choosing Always allow on a request saves one.",
    path: "/api/permission/saved",
    rowOf: (rule) => ({ id: String(rule.id), label: `${rule.effect ?? "allow"}: ${rule.action}`, detail: String(rule.resource), actions: [{ id: "remove", label: "Remove" }] }),
    requestFor: (actionId, rule) => (actionId === "remove" ? { method: "DELETE", path: `/api/permission/saved/${encodeURIComponent(rule.id)}` } : undefined),
  },
  {
    id: "mcp",
    title: "MCP servers",
    hint: "Each connected server adds its tools to the sessions of this folder.",
    empty: "No MCP server is configured.",
    path: "/api/mcp",
    rowOf: (server) => {
      const status = statusOf(server.status);
      return { id: String(server.name), label: String(server.name), detail: status, actions: [{ id: status === "connected" ? "disconnect" : "connect", label: status === "connected" ? "Disconnect" : "Connect" }] };
    },
    requestFor: (actionId, server) => (actionId === "connect" || actionId === "disconnect" ? { method: "POST", path: `/api/experimental/mcp/${encodeURIComponent(server.name)}/${actionId}` } : undefined),
  },
  {
    id: "plugins",
    title: "Plugins",
    empty: "No plugin is loaded.",
    path: "/api/plugin",
    rowOf: (plugin) => ({ id: String(plugin.id), label: String(plugin.id), detail: `${plugin.source?.type ?? "plugin"}, ${statusOf(plugin.state)}`, actions: packageTargetOf(plugin) ? [{ id: "update", label: "Update" }] : undefined }),
    requestFor: (actionId, plugin) => (actionId === "update" && packageTargetOf(plugin) ? { method: "POST", path: "/api/plugin/update", body: { targets: [packageTargetOf(plugin)] } } : undefined),
  },
  {
    id: "shells",
    title: "Background shells",
    hint: "Commands a run moved to the background. Stop one to end its process.",
    empty: "No background shell was started.",
    path: "/api/shell",
    entriesOf: (body) => listOf(body).slice(-MAX_SHELL_ROWS).reverse(),
    extraPathOf: (shell) => `/api/shell/${encodeURIComponent(shell.id)}/output?limit=${SHELL_OUTPUT_BYTES}`,
    rowOf: (shell, output) => {
      const tail = String(output?.data?.output ?? "").trimEnd().slice(-SHELL_OUTPUT_TAIL_CHARS);
      const state = shell.status === "exited" && typeof shell.exit === "number" ? `exited with ${shell.exit}` : String(shell.status);
      return { id: String(shell.id), label: String(shell.command), detail: tail ? `${state}\n${tail}` : state, actions: shell.status === "running" ? [{ id: "stop", label: "Stop" }] : undefined };
    },
    requestFor: (actionId, shell) => (actionId === "stop" ? { method: "DELETE", path: `/api/shell/${encodeURIComponent(shell.id)}` } : undefined),
  },
  {
    id: "references",
    title: "References",
    empty: "No reference folder or repository is configured.",
    path: "/api/reference",
    rowOf: (reference) => ({ id: String(reference.name), label: String(reference.name), detail: String(reference.path ?? reference.source?.path ?? reference.source?.type ?? "") }),
  },
  {
    id: "webSearch",
    title: "Web search providers",
    empty: "No web search provider is available.",
    path: "/api/websearch/provider",
    rowOf: (provider) => ({ id: String(provider.id), label: String(provider.name ?? provider.id) }),
  },
  {
    id: "stats",
    title: "Usage statistics",
    empty: "No usage is recorded.",
    path: "/api/experimental/session/stats",
    entriesOf: statsRows,
    rowOf: (row) => row,
  },
];

const SIGN_IN_SPEC: PanelSpec = {
  id: "signIn",
  title: "Signed-in providers",
  hint: "Providers this OpenCode installation is signed in to. Add one by running opencode2 auth login in a terminal; sign out here.",
  empty: "No provider is signed in. Sign in with the opencode2 command.",
  path: "/api/credential",
  rowOf: (credential) => ({ id: String(credential.id), label: String(credential.label ?? credential.integrationID ?? credential.id), detail: `${credential.integrationID ?? ""}${credential.active ? ", active" : ""}`, actions: [{ id: "remove", label: "Sign out" }] }),
  requestFor: (actionId, credential) => (actionId === "remove" ? { method: "DELETE", path: `/api/credential/${encodeURIComponent(credential.id)}` } : undefined),
};

export const panelSpecsOf = (managesCredentials: boolean): PanelSpec[] => (managesCredentials ? BASE_SPECS : [BASE_SPECS[0], SIGN_IN_SPEC, ...BASE_SPECS.slice(1)]);

type Call = (server: OpencodeServer, directory: string, path: string, init?: RequestInit) => Promise<Response>;

const entriesFor = async (call: Call, { server, directory }: PanelTransport, spec: PanelSpec): Promise<any[]> => {
  const body = await (await call(server, directory, spec.path)).json();
  return spec.entriesOf ? spec.entriesOf(body) : listOf(body);
};

const rowFor = async (call: Call, { server, directory }: PanelTransport, spec: PanelSpec, entry: any): Promise<PanelRow> => {
  const extra = spec.extraPathOf ? await call(server, directory, spec.extraPathOf(entry)).then((response) => response.json(), () => undefined) : undefined;
  return spec.rowOf(entry, extra);
};

export const loadPanels = async (call: Call, transport: PanelTransport, specs: PanelSpec[]): Promise<RuntimePanel[]> =>
  Promise.all(
    specs.map(async (spec) => {
      const entries = await entriesFor(call, transport, spec).catch(() => []);
      return { id: spec.id, title: spec.title, hint: spec.hint, empty: spec.empty, rows: await Promise.all(entries.map((entry) => rowFor(call, transport, spec, entry))) };
    }),
  );

export const runPanelAction = async (call: Call, transport: PanelTransport, specs: PanelSpec[], panelId: string, rowId: string, actionId: string): Promise<void> => {
  const spec = specs.find((candidate) => candidate.id === panelId);
  const entries = spec ? await entriesFor(call, transport, spec) : [];
  const entry = entries.find((candidate) => spec!.rowOf(candidate).id === rowId);
  const request = entry && spec?.requestFor?.(actionId, entry);
  if (!request) throw new Error(`Unknown action ${actionId} on ${panelId}`);
  await call(transport.server, transport.directory, request.path, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body) });
};
