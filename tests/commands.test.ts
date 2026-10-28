import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ancestorFolders, commandOfMarkdown, commandsFromConfig, mergeCommands, readCommandFolder, readCommandSources } from "../packages/server/src/commandFiles";
import { expandCommandTemplate, expandShellInjections } from "../packages/server/src/run/commandExpansion";

describe("command files", () => {
  const withFolder = (files: Record<string, string>, run: (root: string) => void) => {
    const root = mkdtempSync(join(tmpdir(), "branchboard-command-files-"));
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("reads front matter overrides", () => {
    expect(commandOfMarkdown("x", "---\ndescription: \"Does x\"\nagent: plan\nmodel: p/m\nsubagent: true\n---\nBody $1")).toEqual({ name: "x", description: "Does x", agent: "plan", model: "p/m", subagent: true, template: "Body $1" });
    expect(commandOfMarkdown("y", "No front matter")).toEqual({ name: "y", template: "No front matter" });
  });

  it("names nested folders with the separator", () => {
    withFolder({ "commands/a.md": "A", "commands/team/b.md": "B", "commands/team/deep/c.md": "C", "commands/skip.txt": "no" }, (root) => {
      expect(readCommandFolder(join(root, "commands"), "/").map((command) => command.name).sort()).toEqual(["a", "team/b", "team/deep/c"]);
      expect(readCommandFolder(join(root, "commands"), ":").map((command) => command.name)).toContain("team:b");
      expect(readCommandFolder(join(root, "missing"), "/")).toEqual([]);
    });
  });

  it("reads commands from config entries", () => {
    expect(commandsFromConfig({ commands: { fix: { template: "Fix $1", description: "d", agent: "build" }, broken: { description: "no template" } } })).toEqual([{ name: "fix", template: "Fix $1", description: "d", agent: "build" }]);
    expect(commandsFromConfig(undefined)).toEqual([]);
  });

  it("lets the nearest folder and the later source win", () => {
    withFolder({ "outer/commands/same.md": "outer", "outer/inner/commands/same.md": "inner" }, (root) => {
      const folders = ancestorFolders(join(root, "outer", "inner"), "commands").filter((folder) => folder.startsWith(root)).reverse();
      expect(readCommandSources({ folders, separator: "/" })).toEqual([{ name: "same", template: "inner" }]);
    });
    expect(mergeCommands([{ name: "a", template: "1" }], [{ name: "a", template: "2" }])).toEqual([{ name: "a", template: "2" }]);
  });
});

describe("shell injection", () => {
  it("replaces each !`cmd` with its output after the arguments are filled", async () => {
    const run = async (command: string) => `<${command}>`;
    expect(await expandShellInjections("Status: !`git status` and !`ls`", "/work", run)).toBe("Status: <git status> and <ls>");
    expect(await expandShellInjections("nothing here", "/work", run)).toBe("nothing here");
  });

  it("runs only the commands of the template, never those typed as arguments", async () => {
    const run = async (command: string) => `<${command}>`;
    const command = { name: "check", template: "Status: !`git status`\n$ARGUMENTS", description: "" };
    expect(await expandCommandTemplate("/check !`rm -rf x`", command, "/work", run)).toBe("Status: <git status>\n!`rm -rf x`");
  });

  it("runs a real command in the workspace", async () => {
    expect(await expandShellInjections("v=!`node -p 1+1`", process.cwd())).toBe("v=2");
  });
});
