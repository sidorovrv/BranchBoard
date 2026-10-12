import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanSelection, pickerCommands } from "../packages/server/src/folderPicker";
import { browseFolder, insideWorkspace } from "../packages/server/src/pathBrowser";
import { locateOpencode, type LocatorEnvironment } from "../packages/server/src/runtimes/opencodeLocator";
import { withoutCurrentDirectorySearch } from "../packages/server/src/runtimes/spawnProcess";

const environment = (overrides: Partial<LocatorEnvironment>, files: string[]): LocatorEnvironment => ({
  platform: "win32",
  env: { PATH: "C:\\Windows" },
  home: "C:\\Users\\Tester",
  isFile: (path) => files.includes(path),
  ...overrides,
});

describe("locateOpencode", () => {
  it("finds the npm global shim even when it is not on PATH", () => {
    const shim = join("C:\\Users\\Tester\\AppData\\Roaming", "npm", "opencode.cmd");
    const located = locateOpencode(environment({ env: { PATH: "C:\\Windows", APPDATA: "C:\\Users\\Tester\\AppData\\Roaming" } }, [shim]));
    expect(located.path).toBe(shim);
  });

  it.runIf(process.platform === "win32")("prefers a PATH entry over the known directories", () => {
    const onPath = join("C:\\tools", "opencode.cmd");
    const located = locateOpencode(environment({ env: { PATH: "C:\\tools", APPDATA: "C:\\A" } }, [onPath, join("C:\\A", "npm", "opencode.cmd")]));
    expect(located.path).toBe(onPath);
  });

  it("honours the explicit override and reports a bad one", () => {
    expect(locateOpencode(environment({ env: { BRANCHBOARD_OPENCODE_PATH: "D:\\oc.cmd" } }, ["D:\\oc.cmd"])).path).toBe("D:\\oc.cmd");
    expect(locateOpencode(environment({ env: { BRANCHBOARD_OPENCODE_PATH: "D:\\gone.cmd" } }, [])).path).toBeUndefined();
  });

  it("lists what it searched when nothing is found", () => {
    const located = locateOpencode(environment({}, []));
    expect(located.path).toBeUndefined();
    expect(located.searched.length).toBeGreaterThan(1);
  });
});

describe("folder picker", () => {
  it("picks a native dialog command per platform", () => {
    expect(pickerCommands("win32")[0].command).toBe("powershell.exe");
    expect(pickerCommands("darwin")[0].command).toBe("osascript");
    expect(pickerCommands("linux").map((candidate) => candidate.command)).toEqual(["zenity", "kdialog"]);
  });

  it("asks for a file or a folder and starts in the given folder", () => {
    const fileDialog = pickerCommands("linux", "file", "/repo");
    expect(fileDialog[0].args).not.toContain("--directory");
    expect(fileDialog[0].args).toContain("--filename=/repo/");
    expect(fileDialog[1].args).toEqual(["--getopenfilename", "/repo", "--title", "Choose a file"]);
    expect(pickerCommands("darwin", "file", "/repo")[0].args[1]).toBe('POSIX path of (choose file with prompt "Choose a file" default location (POSIX file "/repo"))');
  });

  it("cleans the selected path", () => {
    expect(cleanSelection("/Users/me/project/\n")).toBe("/Users/me/project");
    expect(cleanSelection("C:\\Users\\me\\project\\\n")).toBe("C:\\Users\\me\\project");
    expect(cleanSelection("C:\\")).toBe("C:\\");
    expect(cleanSelection("  \n")).toBeUndefined();
  });
});

describe("child process environment", () => {
  it("stops the Windows command shell from running programs found in the working folder", () => {
    const hardened = withoutCurrentDirectorySearch({ PATH: "x", KEEP: "1" });
    expect(hardened.NoDefaultCurrentDirectoryInExePath).toBe("1");
    expect(hardened.KEEP).toBe("1");
  });
});

describe("path browser", () => {
  it("lists folders first, hides secret files and reports the parent", () => {
    const root = mkdtempSync(join(tmpdir(), "browse-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "a.ts"), "");
    writeFileSync(join(root, ".env"), "");
    const folders = browseFolder(root, false);
    expect(folders.entries).toEqual([{ name: "src", isFolder: true }]);
    expect(browseFolder(root, true).entries.map((entry) => entry.name)).toEqual(["src", "a.ts"]);
    expect(folders.parent).toBe(dirname(root));
    expect(() => browseFolder(join(root, "missing"), false)).toThrow();
  });

  it("only accepts files inside the workspace", () => {
    expect(insideWorkspace("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(() => insideWorkspace("/repo", "/other/a.ts")).toThrow();
  });
});
