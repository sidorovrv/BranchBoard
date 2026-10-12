import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Instance } from "./fixtures";

test.beforeEach(async ({ appPage }) => {
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
});

const git = (folder: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: folder, stdio: "pipe" });

const sendFrom = (page: import("@playwright/test").Page, instance: Instance) => async (command: Record<string, unknown>) => {
  const response = await page.request.post(`${instance.baseUrl}/api/commands`, { data: command, headers: { origin: instance.baseUrl } });
  expect(response.ok()).toBe(true);
  return response.json();
};

test("an HTML file is previewed in a sandbox that cannot reach the app", async ({ appPage, instance, demo }) => {
  mkdirSync(join(instance.dataDirectory, "site"), { recursive: true });
  writeFileSync(
    join(instance.dataDirectory, "site", "index.html"),
    "<body></body><script>try { parent.document.title; document.body.textContent = 'allowed'; } catch (error) { document.body.textContent = 'blocked:' + error.name; }</script>",
  );
  await sendFrom(appPage, instance)({ type: "extractFile", boardId: demo.boardId, path: "site/index.html" });
  const preview = appPage.frameLocator("iframe.html-preview");
  await expect(preview.locator("body")).toContainText("blocked:SecurityError", { timeout: 15000 });
});

test("removed lines show in a popover on the marker and in the diff view", async ({ appPage, instance, demo }) => {
  const folder = instance.dataDirectory;
  writeFileSync(join(folder, "notes.ts"), "const a = 1;\nconst removedLine = 2;\nconst c = 3;\n");
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", "notes.ts");
  git(folder, "commit", "-q", "-m", "first");
  writeFileSync(join(folder, "notes.ts"), "const a = 1;\nconst c = 3;\n");
  await sendFrom(appPage, instance)({ type: "extractFile", boardId: demo.boardId, path: "notes.ts" });
  const marker = appPage.locator(".removed-hit").first();
  await expect(marker).toBeVisible({ timeout: 15000 });
  await marker.hover();
  await expect(appPage.locator(".removed-popover").first()).toContainText("const removedLine = 2;");
  await appPage.getByRole("tab", { name: "Diff" }).click();
  await expect(appPage.locator(".diff-row-remove")).toContainText("const removedLine = 2;");
});

test("the agent's file edits can be reverted from the summary", async ({ appPage, instance, demo }) => {
  const created = join(instance.dataDirectory, "made.txt");
  rmSync(created, { force: true });
  await sendFrom(appPage, instance)({ type: "reply", boardId: demo.boardId, prompt: "/write made.txt :: hello", run: true });
  await expect(appPage.locator(".edits-head")).toContainText("Edited 1 file", { timeout: 15000 });
  expect(existsSync(created)).toBe(true);
  await appPage.locator(".edits-head").getByRole("button", { name: "Revert options" }).click();
  await appPage.locator(".edits-actions").getByRole("button", { name: "Revert all" }).click();
  await expect(appPage.locator(".revert-dialog")).toContainText("made.txt");
  appPage.once("dialog", (dialog) => void dialog.accept());
  await appPage.locator(".revert-dialog").getByRole("button", { name: /^Revert 1 file$/ }).click();
  await expect(appPage.locator(".revert-dialog")).toBeHidden();
  expect(existsSync(created)).toBe(false);
  await appPage.locator(".edits-actions").getByRole("button", { name: "Redo revert" }).click();
  appPage.once("dialog", (dialog) => void dialog.accept());
  await appPage.locator(".revert-dialog").getByRole("button", { name: /^Redo 1 file$/ }).click();
  await expect(appPage.locator(".revert-dialog")).toBeHidden();
  expect(existsSync(created)).toBe(true);
});
