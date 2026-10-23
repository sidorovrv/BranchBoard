import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describeUpdateStatus, updateNoticeOf, type AboutInfo } from "@branchboard/core";
import { parseArguments } from "../packages/cli/src/args";
import { installKindOf, runUpdate, shouldAutoUpdate, type UpdateDependencies } from "../packages/cli/src/update";
import { createApp } from "../packages/server/src/app";
import { TAGS_URL } from "../packages/server/src/channel";
import { installedVersionOf } from "../packages/server/src/version";

const directory = mkdtempSync(join(tmpdir(), "branchboard-updates-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const about = (overrides: Partial<AboutInfo> = {}): AboutInfo => ({
  version: "0.2.0",
  installedVersion: null,
  platform: "linux",
  dataDirectory: "/data",
  update: null,
  channelVersion: "0.2.0",
  isUnsupported: false,
  minimumVersion: null,
  isOffline: false,
  checkedAt: null,
  checkError: null,
  ...overrides,
});

describe("update notices", () => {
  it("ranks unsupported, restart, available, then what's new", () => {
    const update = { version: "0.3.0", notesUrl: "https://github.com/sidorovrv/BranchBoard/releases/tag/v0.3.0" };
    expect(updateNoticeOf(about({ isUnsupported: true, minimumVersion: "0.2.5", update }), null)?.kind).toBe("unsupported");
    expect(updateNoticeOf(about({ installedVersion: "0.3.0", update }), null)).toMatchObject({ kind: "restart", version: "0.3.0" });
    expect(updateNoticeOf(about({ update }), "0.1.0")).toMatchObject({ kind: "available", version: "0.3.0" });
    expect(updateNoticeOf(about(), "0.1.0")).toMatchObject({ kind: "whatsNew", version: "0.2.0" });
    expect(updateNoticeOf(about(), "0.2.0")).toBeNull();
    expect(updateNoticeOf(about(), null)).toBeNull();
  });

  it("describes the state in one line", () => {
    expect(describeUpdateStatus(about())).toBe("Up to date (latest: v0.2.0).");
    expect(describeUpdateStatus(about({ channelVersion: null }))).toContain("No published release");
    expect(describeUpdateStatus(about({ isOffline: true }))).toContain("turned off");
  });
});

describe("the about route", () => {
  const request = async (version: string, query: string, channelFile?: object) => {
    const dataDirectory = mkdtempSync(join(directory, "about-"));
    if (channelFile) {
      process.env.BRANCHBOARD_CHANNEL_FILE = join(dataDirectory, "dev-channel.json");
      writeFileSync(process.env.BRANCHBOARD_CHANNEL_FILE, JSON.stringify(channelFile));
    }
    const server = createApp({ databasePath: join(dataDirectory, "t.db"), security: { port: 47303, extraOrigins: [] }, version });
    try {
      const headers = { host: "127.0.0.1:47303", origin: "http://127.0.0.1:47303" };
      return await (await server.app.request(`http://127.0.0.1:47303/api/about${query}`, { headers })).json();
    } finally {
      server.close();
      delete process.env.BRANCHBOARD_CHANNEL_FILE;
    }
  };

  const channelFile = { tags: { latest: "9.9.9" }, minimumVersion: "0.1.5" };

  it("offers the latest version after a forced check", async () => {
    expect(await request("0.2.0", "?fresh=1", channelFile)).toMatchObject({ update: { version: "9.9.9", notesUrl: expect.stringContaining("v9.9.9") }, channelVersion: "9.9.9", isUnsupported: false, checkError: null });
  });

  it("marks a version below the minimum as unsupported", async () => {
    expect(await request("0.1.0", "?fresh=1", channelFile)).toMatchObject({ isUnsupported: true, minimumVersion: "0.1.5" });
  });

  it("reports no update before anything was fetched", async () => {
    expect(await request("0.2.0", "")).toMatchObject({ update: null, channelVersion: null, checkedAt: null });
  });
});

describe("installed version", () => {
  const packageAt = (name: string, version: string) => {
    const root = mkdtempSync(join(directory, "package-"));
    mkdirSync(join(root, "dist", "web"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
    return join(root, "dist", "web");
  };

  it("reads the branchboard package next to the bundle only", () => {
    expect(installedVersionOf(packageAt("branchboard", "0.3.0"))).toBe("0.3.0");
    expect(installedVersionOf(packageAt("something-else", "0.3.0"))).toBeUndefined();
    expect(installedVersionOf(undefined)).toBeUndefined();
    expect(installedVersionOf(join(directory, "missing", "dist", "web"))).toBeUndefined();
  });
});

describe("branchboard update", () => {
  it("parses the sub-command and its options", () => {
    expect(parseArguments(["update"])).toEqual({ kind: "update", isCheckOnly: false });
    expect(parseArguments(["update", "--check"])).toEqual({ kind: "update", isCheckOnly: true });
    expect(parseArguments(["update", "--channel", "next"]).kind).toBe("error");
    expect(parseArguments(["update", "--bogus"]).kind).toBe("error");
  });

  it("updates in the background only for npm installs that are online and opted in", () => {
    const run = { shouldAutoUpdate: true };
    expect(shouldAutoUpdate({ shouldAutoUpdate: false }, "npm")).toBe(false);
    expect(shouldAutoUpdate({ ...run, offline: true }, "npm")).toBe(false);
    expect(shouldAutoUpdate(run, "npx")).toBe(false);
    expect(shouldAutoUpdate(run, "source")).toBe(false);
  });

  it("tells npm, npx and source copies apart", () => {
    expect(installKindOf("/usr/lib/node_modules/branchboard/dist/branchboard.mjs")).toBe("npm");
    expect(installKindOf("C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\1234\\node_modules\\branchboard\\dist\\branchboard.mjs")).toBe("npx");
    expect(installKindOf("/home/me/branchboard/packages/cli/dist/branchboard.mjs")).toBe("source");
  });

  const run = async (options: { isCheckOnly?: boolean; tags?: object; current?: string; installKind?: UpdateDependencies["installKind"]; installCode?: number }) => {
    const printed: string[] = [];
    const installed: string[] = [];
    const code = await runUpdate(
      { kind: "update", isCheckOnly: options.isCheckOnly ?? false },
      {
        fetchText: async (url) => (url === TAGS_URL ? JSON.stringify(options.tags ?? { latest: "0.3.0" }) : "{}"),
        install: async (version) => (installed.push(version), options.installCode ?? 0),
        installKind: options.installKind ?? "npm",
        print: (line) => printed.push(line),
      },
      options.current ?? "0.2.0",
    );
    return { code, printed: printed.join("\n"), installed };
  };

  it("installs the exact newer version through npm", async () => {
    const result = await run({});
    expect(result).toMatchObject({ code: 0, installed: ["0.3.0"] });
    expect(result.printed).toContain("npm install -g branchboard@0.3.0");
  });

  it("only reports with --check, and does nothing when up to date", async () => {
    expect(await run({ isCheckOnly: true })).toMatchObject({ code: 0, installed: [] });
    expect((await run({ current: "0.3.0" })).printed).toContain("up to date");
  });

  it("explains copies it cannot update and failed installs", async () => {
    expect((await run({ installKind: "npx" })).printed).toContain("npx branchboard@0.3.0");
    expect(await run({ installKind: "source" })).toMatchObject({ code: 1, installed: [] });
    expect(await run({ installCode: 1 })).toMatchObject({ code: 1 });
    expect(await run({ tags: {} })).toMatchObject({ code: 1, installed: [] });
  });
});
