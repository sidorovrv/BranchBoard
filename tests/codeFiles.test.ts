import { describe, expect, it } from "vitest";
import { fileNameOf, languageOfPath, looksLikeFilePath, renderTurns, toolFilePathOf } from "@branchboard/core";
import { fileManagerLaunchOf } from "../packages/server/src/fileManager";

describe("code file helpers", () => {
  it("recognises mentioned file paths by known extensions", () => {
    expect(looksLikeFilePath("src/app.ts")).toBe(true);
    expect(looksLikeFilePath("C:\\repo\\notes.md")).toBe(true);
    expect(looksLikeFilePath("package.json")).toBe(true);
    expect(looksLikeFilePath("v1.2")).toBe(false);
    expect(looksLikeFilePath("two words.ts")).toBe(false);
    expect(looksLikeFilePath("archive.zip")).toBe(false);
    expect(looksLikeFilePath("npm run build")).toBe(false);
  });

  it("names a file and its language", () => {
    expect(fileNameOf("src\\deep/app.tsx")).toBe("app.tsx");
    expect(languageOfPath("src/app.tsx")).toBe("typescript");
    expect(languageOfPath("Makefile")).toBeUndefined();
  });

  it("reads the path of a tool input", () => {
    expect(toolFilePathOf({ file_path: "/repo/src/a.ts", old_string: "x" })).toBe("/repo/src/a.ts");
    expect(toolFilePathOf({ command: "ls" })).toBeUndefined();
    expect(toolFilePathOf("text")).toBeUndefined();
  });

  it("renders a code node as a fenced file in the context", () => {
    const text = renderTurns([{ nodeId: "n", kind: "code", title: "a.ts", input: "const a = 1;", output: "", attachments: [] }]);
    expect(text).toContain("[file: a.ts]");
    expect(text).toContain("const a = 1;");
  });
});

describe("file manager launch", () => {
  it("selects the file in Explorer and Finder, opens the folder elsewhere", () => {
    expect(fileManagerLaunchOf("C:\\repo\\a.ts", "win32")).toEqual({ command: "explorer.exe", args: ["/select,C:\\repo\\a.ts"] });
    const finder = fileManagerLaunchOf("/repo/a.ts", "darwin");
    expect(finder.command).toBe("osascript");
    expect(finder.args.at(-1)).toBe("/repo/a.ts");
    expect(finder.args.join(" ")).toContain("reveal POSIX file (item 1 of argv)");
    expect(finder.args.join(" ")).toContain("activate");
    expect(fileManagerLaunchOf("/repo/a.ts", "linux")).toEqual({ command: "xdg-open", args: ["/repo"] });
  });
});
