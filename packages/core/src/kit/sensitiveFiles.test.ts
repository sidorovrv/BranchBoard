import { describe, expect, it } from "vitest";
import { isSensitivePath, sensitivePathsOf } from "./sensitiveFiles";

describe("sensitive files", () => {
  it("flags env files, keys and version control folders", () => {
    ["/work/app/.env", ".env.local", "keys/server.pem", "home/.ssh/id_ed25519", "repo/.git/config"].forEach((path) => expect(isSensitivePath(path)).toBe(true));
  });

  it("leaves env templates and ordinary files alone", () => {
    [".env.example", "src/environment.ts", "notes/key-ideas.md"].forEach((path) => expect(isSensitivePath(path)).toBe(false));
  });

  it("lists each sensitive path once", () => {
    expect(sensitivePathsOf([".env", "a.ts", ".env"])).toEqual([".env"]);
  });
});
