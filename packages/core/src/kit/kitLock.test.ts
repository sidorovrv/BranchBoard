import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const LOCK_FILE = "kit.lock.json";

const hashOf = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

describe("kit lock", () => {
  it("matches every file copied from the kit", () => {
    const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { files: Record<string, string> };
    const changed = Object.entries(lock.files)
      .filter(([path, hash]) => !existsSync(path) || hashOf(readFileSync(path, "utf8")) !== hash)
      .map(([path]) => path);
    expect(changed).toEqual([]);
  });
});
