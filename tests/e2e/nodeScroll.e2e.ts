import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "./fixtures";

const LINE_COUNT = 300;
const SCROLLED_TOP = 400;
const longText = (word: string) => Array.from({ length: LINE_COUNT }, (_, index) => `${word} line ${index}`).join("\n\n");

const scroller = (page: Page, nodeId: string, selector: string) => page.locator(`.react-flow__node[data-id="${nodeId}"] ${selector}`);

const expectScrolledTop = async (page: Page, nodeId: string, selector: string) => {
  const element = scroller(page, nodeId, selector);
  await expect(element).toBeVisible({ timeout: 15000 });
  await expect.poll(() => element.evaluate((node) => node.scrollTop)).toBe(SCROLLED_TOP);
};

test("chat and code nodes keep their scroll position across board switches and reloads", async ({ appPage, instance, demo }) => {
  const send = async (data: Record<string, unknown>) => (await appPage.request.post(`${instance.baseUrl}/api/commands`, { data, headers: { origin: instance.baseUrl } })).json();
  writeFileSync(join(instance.dataDirectory, "long.ts"), Array.from({ length: LINE_COUNT }, (_, index) => `const value${index} = ${index};`).join("\n"));
  await send({ type: "createBoard", projectId: demo.projectId, title: "Second board" });
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).first().click();
  const { nodeId: chatId } = await send({ type: "reply", boardId: demo.boardId, parentIds: [], prompt: longText("answer") });
  const { nodeId: codeId } = await send({ type: "extractFile", boardId: demo.boardId, path: "long.ts" });
  await expect(appPage.locator(`.react-flow__node[data-id="${chatId}"] .node-card.status-done`)).toHaveCount(1, { timeout: 15000 });
  const targets: [string, string][] = [[chatId, ".answer"], [codeId, ".code-node pre"]];
  for (const [nodeId, selector] of targets) {
    await expect(scroller(appPage, nodeId, selector)).toBeVisible({ timeout: 15000 });
    await scroller(appPage, nodeId, selector).evaluate((node, top) => (node.scrollTop = top), SCROLLED_TOP);
  }
  await appPage.locator(".sidebar-board-open", { hasText: "Second board" }).first().click();
  await expect(appPage.locator(`.react-flow__node[data-id="${chatId}"]`)).toHaveCount(0);
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).first().click();
  for (const [nodeId, selector] of targets) await expectScrolledTop(appPage, nodeId, selector);
  await appPage.reload();
  for (const [nodeId, selector] of targets) await expectScrolledTop(appPage, nodeId, selector);
});
