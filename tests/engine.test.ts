import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { engineVersionOf } from "../packages/server/src/channel";
import { createCredentialStore } from "../packages/server/src/credentials";
import { buildProviderConfig, connectKeyWhenReady, credentialIdsFor, CUSTOM_PROVIDER_ID, homeEnvironment, integrationOf, scrubbedEnvironment } from "../packages/server/src/engine/flavor";
import { engineRuntime } from "../packages/server/src/engine/runtime";
import { classifyInstallFailure, createEngineInstaller, npmArguments, type RunCommand } from "../packages/server/src/engine/install";
import { engineFolder, engineRoot, packageBinaryPath, platformPackages, type EnginePlatform } from "../packages/server/src/engine/locator";

const directory = mkdtempSync(join(tmpdir(), "branchboard-engine-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const LINUX: EnginePlatform = { os: "linux", arch: "x64", isMusl: false };
const VERSION = "2.0.27";
const freshFolder = () => mkdtempSync(join(directory, "data-"));

const scriptedNpm = (platform: EnginePlatform, options: { name?: string; version?: string; binaryVersion?: string; failInstall?: string } = {}) => {
  const calls: { command: string; args: string[] }[] = [];
  const run: RunCommand = async (command, args, cwd) => {
    calls.push({ command, args });
    if (command.startsWith("npm")) {
      if (options.failInstall) return { code: 1, stdout: "", stderr: options.failInstall };
      const prefix = args[args.indexOf("--prefix") + 1];
      const main = join(prefix, "node_modules", "@opencode", "cli");
      mkdirSync(main, { recursive: true });
      writeFileSync(join(main, "package.json"), JSON.stringify({ name: options.name ?? "@opencode/cli", version: options.version ?? VERSION }));
      const binary = packageBinaryPath(prefix, platformPackages(platform)[0], platform.os);
      mkdirSync(join(binary, ".."), { recursive: true });
      writeFileSync(binary, "binary");
      return { code: 0, stdout: "", stderr: "" };
    }
    expect(cwd).toBeTruthy();
    return { code: 0, stdout: `opencode ${options.binaryVersion ?? VERSION}`, stderr: "" };
  };
  return { run, calls };
};

describe("engine install", () => {
  it("installs one platform package with scripts disabled and runs the binary version check", async () => {
    const dataDirectory = freshFolder();
    const { run, calls } = scriptedNpm(LINUX);
    const installer = createEngineInstaller({ dataDirectory, run, platform: LINUX });
    const binary = await installer.ensure(VERSION);
    expect(binary).toContain(engineFolder(dataDirectory, VERSION));
    const install = calls[0];
    expect(install.command).toBe("npm");
    expect(install.args).toEqual(expect.arrayContaining(["install", "--ignore-scripts", "--os=linux", "--cpu=x64", "--libc=glibc", `@opencode/cli@${VERSION}`]));
    expect(calls[1].args).toEqual(["--version"]);
    expect(installer.state()).toEqual({ phase: "ready", version: VERSION });
    expect(installer.locate(VERSION)).toBe(binary);
  });

  it("uses npm.cmd and no libc flag on Windows", () => {
    const windows: EnginePlatform = { os: "win32", arch: "arm64", isMusl: false };
    const args = npmArguments("prefix", VERSION, windows);
    expect(args).toContain("--os=win32");
    expect(args.some((argument) => argument.startsWith("--libc"))).toBe(false);
    expect(platformPackages(windows)).toEqual(["@opencode/cli-windows-arm64"]);
  });

  it("runs one install for concurrent requests and none once installed", async () => {
    const { run, calls } = scriptedNpm(LINUX);
    const installer = createEngineInstaller({ dataDirectory: freshFolder(), run, platform: LINUX });
    await Promise.all([installer.ensure(VERSION), installer.ensure(VERSION)]);
    await installer.ensure(VERSION);
    expect(calls.filter((call) => call.command === "npm")).toHaveLength(1);
  });

  it.each([
    ["a different package name", { name: "opencode2" }],
    ["a different version", { version: "9.9.9" }],
    ["a binary that reports another version", { binaryVersion: "1.0.0" }],
    ["a failed npm run", { failInstall: "ENOTFOUND registry.npmjs.org" }],
  ])("leaves no folder behind after %s", async (_name, options) => {
    const dataDirectory = freshFolder();
    const { run } = scriptedNpm(LINUX, options);
    const installer = createEngineInstaller({ dataDirectory, run, platform: LINUX });
    await expect(installer.ensure(VERSION)).rejects.toMatchObject({ recovery: "setup" });
    expect(installer.state().phase).toBe("failed");
    expect(installer.locate(VERSION)).toBeUndefined();
    expect(readdirSync(engineRoot(dataDirectory))).toEqual([]);
  });

  it("names the cause of a failed download", () => {
    expect(classifyInstallFailure(Object.assign(new Error("spawn npm"), { code: "ENOENT" })).cause).toBe("npm-missing");
    expect(classifyInstallFailure(new Error("x"), "npm ERR! ENOSPC: no space left on device").cause).toBe("disk-full");
    expect(classifyInstallFailure(new Error("x"), "npm ERR! code EAI_AGAIN").cause).toBe("offline");
    expect(classifyInstallFailure(new Error("x"), "boom").cause).toBe("other");
  });

  it("removes other versions only when asked and keeps the pinned one", async () => {
    const dataDirectory = freshFolder();
    const { run } = scriptedNpm(LINUX);
    const installer = createEngineInstaller({ dataDirectory, run, platform: LINUX });
    await installer.ensure(VERSION);
    mkdirSync(engineFolder(dataDirectory, "2.0.1"));
    installer.pruneOtherVersions(VERSION);
    expect(existsSync(engineFolder(dataDirectory, "2.0.1"))).toBe(false);
    expect(installer.locate(VERSION)).toBeDefined();
  });
});

describe("engine runtime download trigger", () => {
  const setup = () => {
    const dataDirectory = freshFolder();
    const { run, calls } = scriptedNpm(LINUX);
    const installer = createEngineInstaller({ dataDirectory, run, platform: LINUX });
    const credentials = createCredentialStore(dataDirectory);
    const runtime = engineRuntime("anthropic", { engine: { pool: {} as never, version: () => VERSION }, installer, credentials });
    return { runtime, calls, installer, credentials };
  };

  it("reads the catalog without downloading and reports the pinned version", async () => {
    const { runtime, calls, credentials } = setup();
    credentials.set("anthropic", "sk-test-key", undefined);
    const catalog = await runtime.catalog("/tmp");
    expect(calls).toEqual([]);
    expect(catalog.engine).toEqual({ phase: "idle", version: VERSION });
    expect(catalog.health.ok).toBe(true);
  });

  it("downloads when set up and not twice", async () => {
    const { runtime, calls, installer } = setup();
    runtime.setUp?.();
    runtime.setUp?.();
    expect(installer.state().phase).toBe("installing");
    await installer.ensure(VERSION);
    expect(calls.filter((call) => call.command === "npm")).toHaveLength(1);
  });
});

describe("engine channel pin", () => {
  it("uses the pinned version, and the default when the pin is missing or below the minimum", () => {
    expect(engineVersionOf({ engine: { version: "2.1.0" } } as never, VERSION)).toBe("2.1.0");
    expect(engineVersionOf({} as never, VERSION)).toBe(VERSION);
    expect(engineVersionOf({ engine: { version: "2.0.5", minimumVersion: "2.0.9" } } as never, VERSION)).toBe(VERSION);
  });
});

describe("engine launch environment", () => {
  it("moves home and XDG folders under the engine home", () => {
    const environment = homeEnvironment("/data/engine-home", "linux");
    expect(environment.HOME).toBe("/data/engine-home");
    expect(environment.XDG_DATA_HOME).toBe(join("/data/engine-home", "data"));
    expect(environment.USERPROFILE).toBeUndefined();
    expect(homeEnvironment("C:\\home", "win32")).toMatchObject({ USERPROFILE: "C:\\home" });
  });

  it("clears provider keys and OpenCode variables except the server password and config", () => {
    const cleared = scrubbedEnvironment({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b", OPENCODE_CONFIG: "c", OPENCODE_DB: "d", OPENCODE_SERVER_PASSWORD: "e", OPENCODE_CONFIG_CONTENT: "f", PATH: "g" });
    expect(Object.keys(cleared).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_CONFIG", "OPENCODE_DB"]);
  });
});

describe("engine provider presets", () => {
  const storeWith = (settings: Record<string, { key?: string; baseUrl?: string }>) => {
    const store = createCredentialStore(freshFolder());
    Object.entries(settings).forEach(([id, { key, baseUrl }]) => store.set(id as never, key ?? null, baseUrl));
    return store;
  };
  const listModels = async () => ["gpt-x", "gpt-y"];

  it("adds no provider for default addresses", async () => {
    expect(await buildProviderConfig(storeWith({}), listModels)).toEqual({ providers: {} });
  });

  it("routes a changed Anthropic address through settings.baseURL", async () => {
    const config = await buildProviderConfig(storeWith({ anthropic: { key: "k", baseUrl: "https://proxy.example.com" } }), listModels);
    expect(config.providers.anthropic).toEqual({ settings: { baseURL: "https://proxy.example.com" } });
  });

  it("keeps an OpenAI-host address on the openai provider and other addresses on a custom provider with the endpoint's models", async () => {
    const proxy = await buildProviderConfig(storeWith({ openai: { key: "k", baseUrl: "https://api.openai.com/v2" } }), listModels);
    expect(proxy.providers.openai).toEqual({ settings: { baseURL: "https://api.openai.com/v2" } });
    const custom = await buildProviderConfig(storeWith({ openai: { key: "k", baseUrl: "http://localhost:11434/v1" } }), listModels);
    expect(custom.providers[CUSTOM_PROVIDER_ID]).toMatchObject({ settings: { baseURL: "http://localhost:11434/v1" }, models: { "gpt-x": { name: "gpt-x" }, "gpt-y": { name: "gpt-y" } } });
    expect(JSON.stringify(custom)).not.toContain('"k"');
  });

  it("repeats the key connect while a starting engine still answers 404", async () => {
    let calls = 0;
    await connectKeyWhenReady(async () => {
      if (++calls < 3) throw new Error("POST /api/integration/openai/connect/key failed with 404");
    }, 1);
    expect(calls).toBe(3);
  });

  it("does not repeat the key connect for other failures or without end", async () => {
    let calls = 0;
    const failWith = (message: string) => async () => {
      calls++;
      throw new Error(message);
    };
    await expect(connectKeyWhenReady(failWith("failed with 400"), 1)).rejects.toThrow("400");
    expect(calls).toBe(1);
    calls = 0;
    await expect(connectKeyWhenReady(failWith("failed with 404"), 1)).rejects.toThrow("404");
    expect(calls).toBe(10);
  });

  it("finds the credentials of one integration in the recorded engine list", () => {
    const recorded = {
      data: [
        { id: "cred_1353f996c001jZmke4xnxI0sPi", integrationID: "anthropic", label: "Anthropic", active: true, value: { type: "key", key: "sk-probe" } },
        { id: "cred_other", integrationID: "openai", label: "OpenAI", active: true, value: { type: "key", key: "sk-other" } },
      ],
    };
    expect(credentialIdsFor(recorded, "anthropic")).toEqual(["cred_1353f996c001jZmke4xnxI0sPi"]);
    expect(credentialIdsFor({}, "anthropic")).toEqual([]);
  });

  it("picks the integration that receives the key", () => {
    expect(integrationOf("anthropic", "https://api.anthropic.com")).toBe("anthropic");
    expect(integrationOf("openai", "https://api.openai.com/v1")).toBe("openai");
    expect(integrationOf("openai", "http://localhost:1234/v1")).toBe(CUSTOM_PROVIDER_ID);
  });
});
