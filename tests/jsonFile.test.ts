import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({ codes: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    const code = failures.codes.shift();
    if (code) throw Object.assign(new Error(`${code}: rename`), { code });
    return actual.renameSync(from, to);
  };
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

const { writeJsonFile } = await import("../packages/server/src/jsonFile");

describe("writeJsonFile", () => {
  const directory = mkdtempSync(join(tmpdir(), "branchboard-json-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("retries a rename that Windows refuses while another process holds the file", () => {
    failures.codes = ["EPERM", "EBUSY"];
    writeJsonFile(join(directory, "held.json"), { a: 1 });
    expect(JSON.parse(readFileSync(join(directory, "held.json"), "utf8"))).toEqual({ a: 1 });
  });

  it("throws other rename errors at once", () => {
    failures.codes = ["ENOENT"];
    expect(() => writeJsonFile(join(directory, "other.json"), {})).toThrow("ENOENT");
  });
});
