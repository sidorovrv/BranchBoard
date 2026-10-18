export interface CredentialSpec {
  defaultBaseUrl: string;
  baseUrlEditable: boolean;
  keyRequired: boolean;
  keyOptionalOnLocalhost: boolean;
}

export interface SetupGuide {
  install?: Record<"win32" | "darwin" | "linux", string>;
  signIn?: string;
  signInNote?: string;
  keyUrl?: string;
  docsUrl: string;
}

export interface RuntimeInfo {
  label: string;
  kind: "cli" | "api";
  pathVariable?: string;
  trustNote?: boolean;
  credential?: CredentialSpec;
  setup?: SetupGuide;
}

const NPM_INSTALL = (packageName: string) => ({ win32: `npm install -g ${packageName}`, darwin: `npm install -g ${packageName}`, linux: `npm install -g ${packageName}` });

export const RUNTIMES = {
  fake: { label: "Built-in demo", kind: "cli" },
  opencode: {
    label: "OpenCode",
    kind: "cli",
    trustNote: true,
    pathVariable: "BRANCHBOARD_OPENCODE_PATH",
    credential: { defaultBaseUrl: "", baseUrlEditable: true, keyRequired: false, keyOptionalOnLocalhost: true },
    setup: { install: NPM_INSTALL("opencode-ai"), signIn: "opencode auth login", docsUrl: "https://opencode.ai" },
  },
  opencode2: {
    label: "OpenCode 2",
    kind: "cli",
    trustNote: true,
    pathVariable: "BRANCHBOARD_OPENCODE2_PATH",
    setup: { install: NPM_INSTALL("@opencode/cli"), signIn: "opencode2 auth login", docsUrl: "https://opencode.ai/v2/docs" },
  },
  claude: {
    label: "Claude subscription",
    kind: "cli",
    pathVariable: "BRANCHBOARD_CLAUDE_PATH",
    setup: { install: NPM_INSTALL("@anthropic-ai/claude-code"), signIn: "claude", docsUrl: "https://code.claude.com" },
  },
  codex: {
    label: "ChatGPT subscription",
    kind: "cli",
    pathVariable: "BRANCHBOARD_CODEX_PATH",
    setup: { install: NPM_INSTALL("@openai/codex"), signIn: "codex login", signInNote: "Run it in a terminal. Choose Sign in with ChatGPT to use your plan, or use an API key.", docsUrl: "https://developers.openai.com/codex" },
  },
  anthropic: {
    label: "Anthropic API",
    kind: "api",
    trustNote: true,
    credential: { defaultBaseUrl: "https://api.anthropic.com", baseUrlEditable: true, keyRequired: true, keyOptionalOnLocalhost: false },
    setup: { keyUrl: "https://console.anthropic.com/settings/keys", docsUrl: "https://docs.anthropic.com/en/api/getting-started" },
  },
  openai: {
    label: "OpenAI-compatible API",
    kind: "api",
    trustNote: true,
    credential: { defaultBaseUrl: "https://api.openai.com/v1", baseUrlEditable: true, keyRequired: true, keyOptionalOnLocalhost: true },
    setup: { keyUrl: "https://platform.openai.com/api-keys", docsUrl: "https://platform.openai.com/docs/api-reference" },
  },
} as const satisfies Record<string, RuntimeInfo>;

export type RuntimeId = keyof typeof RUNTIMES;

export type ApiRuntimeId = { [Id in RuntimeId]: (typeof RUNTIMES)[Id] extends { kind: "api" } ? Id : never }[RuntimeId];

export const RUNTIME_IDS = Object.keys(RUNTIMES) as RuntimeId[];

export const isRuntimeId = (value: unknown): value is RuntimeId => typeof value === "string" && Object.hasOwn(RUNTIMES, value);

export const runtimeInfo = (id: RuntimeId): RuntimeInfo => RUNTIMES[id];

export const isApiRuntime = (id: RuntimeId): id is ApiRuntimeId => runtimeInfo(id).kind === "api";

export type CredentialRuntimeId = { [Id in RuntimeId]: (typeof RUNTIMES)[Id] extends { credential: unknown } ? Id : never }[RuntimeId];

export const hasCredential = (id: RuntimeId): id is CredentialRuntimeId => runtimeInfo(id).credential !== undefined;


export interface CredentialStatus {
  saved: boolean;
  baseUrl: string;
  updatedAt?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const isLocalBaseUrl = (baseUrl: string): boolean => {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
};

export const needsKey = (id: RuntimeId, baseUrl: string): boolean => {
  const credential = runtimeInfo(id).credential;
  return Boolean(credential?.keyRequired) && !(credential?.keyOptionalOnLocalhost && isLocalBaseUrl(baseUrl));
};

export const installCommandFor = (id: RuntimeId, platform: string): string | undefined => {
  const install = runtimeInfo(id).setup?.install;
  return install?.[platform === "win32" || platform === "darwin" ? platform : "linux"];
};
