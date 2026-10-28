import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCredentialStore } from "../packages/server/src/credentials";
import { isLocalBaseUrl, needsKey } from "@branchboard/core";

const KEY = ["sk-ant-", "api03-TESTKEYTESTKEYTESTKEY1234"].join("");
const OPENAI_KEY = "sk-openai-TESTKEYTESTKEYTESTKEY5678";
const directory = mkdtempSync(join(tmpdir(), "branchboard-credentials-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("credential store", () => {
  const folder = mkdtempSync(join(directory, "cred-"));

  it("saves a key without ever reporting it back, and removes it", () => {
    const store = createCredentialStore(folder);
    expect(store.status("anthropic")).toMatchObject({ saved: false, baseUrl: "https://api.anthropic.com" });
    const status = store.set("anthropic", KEY, undefined);
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(status.saved).toBe(true);
    expect(store.credentialOf("anthropic").key).toBe(KEY);
    expect(JSON.stringify(store.status("anthropic"))).not.toContain(KEY);
    if (process.platform !== "win32") expect(statSync(join(folder, "credentials.json")).mode & 0o777).toBe(0o600);
    store.set("anthropic", null, undefined);
    expect(store.status("anthropic").saved).toBe(false);
  });

  it("deletes the key when the base URL changes without a new key", () => {
    const store = createCredentialStore(mkdtempSync(join(directory, "cred-")));
    store.set("openai", OPENAI_KEY, "https://api.example.com/v1");
    expect(store.set("openai", undefined, "https://api.example.com/v1/").saved).toBe(true);
    expect(store.set("openai", undefined, "https://evil.example.com/v1").saved).toBe(false);
    expect(store.credentialOf("openai")).toEqual({ key: undefined, baseUrl: "https://evil.example.com/v1" });
    expect(store.set("openai", OPENAI_KEY, "https://other.example.com/v1").saved).toBe(true);
  });

  it("checks custom addresses", () => {
    const store = createCredentialStore(mkdtempSync(join(directory, "cred-")));
    expect(store.set("anthropic", KEY, "https://proxy.example.com/").baseUrl).toBe("https://proxy.example.com");
    expect(store.set("anthropic", KEY, "").baseUrl).toBe("https://api.anthropic.com");
    expect(() => store.set("anthropic", KEY, "http://example.com")).toThrow(/https/);
    expect(() => store.set("openai", KEY, "http://example.com/v1")).toThrow(/https/);
    expect(() => store.set("openai", KEY, "https://user:pass@example.com/v1")).toThrow();
    expect(() => store.set("openai", KEY, "not a url")).toThrow();
    expect(store.set("openai", undefined, "http://localhost:11434/v1").baseUrl).toBe("http://localhost:11434/v1");
    expect(() => store.set("claude" as never, KEY, undefined)).toThrow();
    expect(() => store.set("anthropic", "has space", undefined)).toThrow();
  });

  it("keeps the address and password of an OpenCode server and clears them with an empty address", () => {
    const store = createCredentialStore(mkdtempSync(join(directory, "cred-")));
    expect(store.serverAddress()).toBeUndefined();
    expect(store.set("opencode", "service-password", "http://127.0.0.1:4096/")).toEqual({ saved: true, baseUrl: "http://127.0.0.1:4096", updatedAt: expect.any(Number) });
    expect(store.serverAddress()).toEqual({ baseUrl: "http://127.0.0.1:4096", password: "service-password" });
    expect(() => store.set("opencode", undefined, "http://example.com")).toThrow(/https/);
    expect(store.set("opencode", null, "").saved).toBe(false);
    expect(store.serverAddress()).toBeUndefined();
  });

  it("does not need a key for a local server only when the runtime allows it", () => {
    expect(isLocalBaseUrl("http://localhost:1234/v1")).toBe(true);
    expect(needsKey("openai", "http://127.0.0.1:1234/v1")).toBe(false);
    expect(needsKey("openai", "https://api.openai.com/v1")).toBe(true);
    expect(needsKey("anthropic", "http://localhost:1234")).toBe(true);
  });
});

describe("where keys may be touched", () => {
  const sourcesUnder = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sourcesUnder(join(folder, entry.name)) : entry.name.endsWith(".ts") ? [join(folder, entry.name)] : []));
  const serverSources = sourcesUnder(join(__dirname, "..", "packages", "server", "src"));
  const named = (needle: string) => serverSources.filter((path) => readFileSync(path, "utf8").includes(needle)).map((path) => path.replace(/\\/g, "/").split("/").at(-1));

  it("keeps credentials.json in the store, lets only the engine and the store read a key, never reads keys from the environment and keeps CLI runtimes away from the store", () => {
    expect(named("credentials.json")).toEqual(["credentials.ts"]);
    expect(named("credentialOf(").sort()).toEqual(["credentials.ts", "flavor.ts"]);
    ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].forEach((needle) => expect(named(needle), needle).toEqual([]));
    expect(named("process.env")).not.toContain("credentials.ts");
    const cliRuntimes = serverSources.filter((path) => /runtimes[\\/](claude[A-Za-z]*|opencode)\.ts$/.test(path));
    cliRuntimes.forEach((path) => expect(readFileSync(path, "utf8")).not.toMatch(/credentials|CredentialStore/i));
  });
});
