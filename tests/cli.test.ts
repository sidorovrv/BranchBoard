import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../packages/server/src/app";
import { defaultDataDirectory } from "../packages/server/src/dataDirectory";
import { parseArguments } from "../packages/cli/src/args";
import { browserLaunchOf } from "../packages/cli/src/browser";

describe("command line arguments", () => {
  it("runs with defaults and opens the browser", () => {
    expect(parseArguments([])).toEqual({ kind: "run", shouldOpenBrowser: true });
  });

  it("reads each option", () => {
    expect(parseArguments(["--port", "5000", "--data-dir", "D:\\boards", "--no-open"])).toEqual({
      kind: "run",
      port: 5000,
      dataDirectory: "D:\\boards",
      shouldOpenBrowser: false,
    });
    expect(parseArguments(["--enable-claude"]).kind).toBe("error");
  });

  it("answers help and version before anything else", () => {
    expect(parseArguments(["--port", "5000", "-h"])).toEqual({ kind: "help" });
    expect(parseArguments(["-v"])).toEqual({ kind: "version" });
  });

  it("explains a bad port, a missing folder and an unknown option", () => {
    ["0", "70000", "abc", "1.5"].forEach((port) => expect(parseArguments(["--port", port]).kind).toBe("error"));
    expect(parseArguments(["--port"]).kind).toBe("error");
    expect(parseArguments(["--data-dir"]).kind).toBe("error");
    expect(parseArguments(["--nope"])).toEqual({ kind: "error", message: "Unknown option --nope" });
  });
});

describe("opening the browser", () => {
  it("uses the system opener of each platform", () => {
    expect(browserLaunchOf("http://127.0.0.1:1/", "win32").command).toBe("cmd.exe");
    expect(browserLaunchOf("http://127.0.0.1:1/", "darwin")).toEqual({ command: "open", args: ["http://127.0.0.1:1/"] });
    expect(browserLaunchOf("http://127.0.0.1:1/", "linux")).toEqual({ command: "xdg-open", args: ["http://127.0.0.1:1/"] });
  });
});

describe("default data folder", () => {
  const nothingExists = () => false;

  it("follows the conventions of each system", () => {
    expect(defaultDataDirectory({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\H", exists: nothingExists })).toBe(join("C:\\L", "Branchboard"));
    expect(defaultDataDirectory({ platform: "darwin", env: {}, home: "/Users/a", exists: nothingExists })).toBe(join("/Users/a", "Library", "Application Support", "Branchboard"));
    expect(defaultDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/x" }, home: "/home/a", exists: nothingExists })).toBe(join("/x", "branchboard"));
    expect(defaultDataDirectory({ platform: "linux", env: {}, home: "/home/a", exists: nothingExists })).toBe(join("/home/a", ".local", "share", "branchboard"));
  });

  it("keeps using a folder from the previous product name when it exists", () => {
    const legacy = join("C:\\L", "WanderBoard");
    expect(defaultDataDirectory({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, home: "C:\\H", exists: (path) => path === legacy })).toBe(legacy);
  });

  it("lets BRANCHBOARD_DATA_DIR win", () => {
    expect(defaultDataDirectory({ platform: "linux", env: { BRANCHBOARD_DATA_DIR: "/custom" }, home: "/home/a", exists: nothingExists })).toBe("/custom");
  });
});

describe("serving the web app from a folder", () => {
  const directory = mkdtempSync(join(tmpdir(), "branchboard-web-"));
  const webRoot = join(directory, "web");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Branchboard</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
  const server = createApp({ databasePath: join(directory, "web.db"), webRoot, security: { port: 47124, extraOrigins: [] } });
  const get = (path: string) => server.app.request(`http://127.0.0.1:47124${path}`, { headers: { host: "127.0.0.1:47124" } });

  afterAll(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("serves the page, an asset and falls back to the page for a board address", async () => {
    expect(await (await get("/")).text()).toContain("Branchboard");
    const asset = await get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log(1)");
    expect(await (await get("/boards/abc")).text()).toContain("Branchboard");
  });

  it("does not serve files outside the folder", async () => {
    writeFileSync(join(directory, "outside.txt"), "private");
    const response = await get("/..%2foutside.txt");
    expect(await response.text()).not.toContain("private");
  });
});
