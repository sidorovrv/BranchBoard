import { expect, test, type Instance } from "./fixtures";

type Page = import("@playwright/test").Page;

const ANSWER_PROMPT = "First paragraph alpha one\n\nSecond paragraph beta two\n\n| name | value |\n|---|---|\n| cellone | 1 |\n| celltwo | 2 |";

test.beforeEach(async ({ appPage }) => {
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  await expect(appPage.locator(".react-flow")).toBeVisible();
});

const sendFrom = (page: Page, instance: Instance) => async (command: Record<string, unknown>) => {
  const response = await page.request.post(`${instance.baseUrl}/api/commands`, { data: command, headers: { origin: instance.baseUrl } });
  expect(response.ok()).toBe(true);
  return response.json();
};

const serverNode = async (page: Page, instance: Instance, boardId: string, nodeId: string) => {
  const response = await page.request.get(`${instance.baseUrl}/api/boards/${boardId}/graph`);
  return (await response.json()).graph.nodes[nodeId];
};

const highlightedTexts = (page: Page) =>
  page.evaluate(() => {
    const highlight = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("node-comment");
    return highlight ? [...highlight].map((range) => range.toString()) : [];
  });

const centreOfHighlight = (page: Page, index = 0) =>
  page.evaluate((at) => {
    const range = [...(CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get("node-comment")!][at];
    const answer = range.startContainer.parentElement!.closest(".answer")!;
    answer.scrollTop += range.getBoundingClientRect().top - answer.getBoundingClientRect().top - answer.clientHeight / 2;
    const rect = range.getClientRects()[0];
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, index);

const selectBetween = (page: Page, nodeId: string, from: string, to: string) =>
  page.evaluate(
    ([id, start, end]) => {
      const root = document.querySelector(`.react-flow__node[data-id="${id}"] .answer`)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let first: [Text, number] | undefined;
      let last: [Text, number] | undefined;
      for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
        if (!first && text.data.includes(start)) first = [text, text.data.indexOf(start)];
        if (first && !last && text.data.includes(end) && (text !== first[0] || text.data.indexOf(end, first[1]) >= 0)) last = [text, text.data.indexOf(end, text === first[0] ? first[1] : 0) + end.length];
      }
      const range = document.createRange();
      range.setStart(first![0], first![1]);
      range.setEnd(last![0], last![1]);
      root.scrollTop += range.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientHeight / 2;
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      const rect = range.getClientRects()[0];
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    [nodeId, from, to],
  );

const comment = async (page: Page, nodeId: string, from: string, to: string, text: string) => {
  const point = await selectBetween(page, nodeId, from, to);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const field = page.locator(".selection-menu .comment-field textarea");
  await expect(field).toBeVisible();
  await field.fill(text);
  await field.press("Enter");
  await expect(page.locator(".selection-menu")).toHaveCount(0);
};

const answeredNode = async (page: Page, instance: Instance, boardId: string, prompt = ANSWER_PROMPT) => {
  const { nodeId } = await sendFrom(page, instance)({ type: "reply", boardId, parentIds: [], prompt });
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"] .node-card.status-done`)).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator(`.react-flow__node[data-id="${nodeId}"] .answer`)).toContainText("cellone");
  return nodeId;
};

test("a comment across paragraphs is highlighted, editable and deletable", async ({ appPage, instance, demo }) => {
  const nodeId = await answeredNode(appPage, instance, demo.boardId);
  await comment(appPage, nodeId, "alpha", "beta", "Compare these");
  await expect.poll(async () => (await highlightedTexts(appPage))[0]).toContain("alpha");
  expect((await highlightedTexts(appPage))[0]).toContain("beta");

  const menu = appPage.locator(".comment-menu");
  const point = await centreOfHighlight(appPage);
  await appPage.mouse.click(point.x, point.y);
  await expect(menu.locator("textarea")).toHaveValue("Compare these");
  await menu.locator("textarea").fill("Compare these two");
  await menu.locator("textarea").press("Enter");
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await serverNode(appPage, instance, demo.boardId, nodeId)).comments[0].text).toBe("Compare these two");

  await expect(async () => {
    const again = await centreOfHighlight(appPage);
    await appPage.mouse.click(again.x, again.y);
    await expect(menu.locator("textarea")).toHaveValue("Compare these two", { timeout: 500 });
  }).toPass();
  await menu.getByRole("button", { name: "Delete comment" }).click();
  await expect.poll(() => highlightedTexts(appPage)).toEqual([]);
  expect((await serverNode(appPage, instance, demo.boardId, nodeId)).comments).toEqual([]);
});

test("a table cell can be commented and the reply carries each comment once", async ({ appPage, instance, demo }) => {
  const nodeId = await answeredNode(appPage, instance, demo.boardId);
  await comment(appPage, nodeId, "cellone", "cellone", "Why one?");
  await comment(appPage, nodeId, "beta", "beta", "What is beta?");
  await expect.poll(() => highlightedTexts(appPage)).toEqual(expect.arrayContaining(["cellone", "beta"]));

  const reply = await sendFrom(appPage, instance)({ type: "reply", boardId: demo.boardId, parentIds: [nodeId] });
  const replyNode = await serverNode(appPage, instance, demo.boardId, reply.nodeId);
  expect(replyNode.prompt).toContain("> cellone\nWhy one?");
  expect(replyNode.prompt).toContain("> beta\nWhat is beta?");
  expect(replyNode.status).toBe("idle");
  await expect.poll(() => highlightedTexts(appPage)).toEqual([]);

  const second = await sendFrom(appPage, instance)({ type: "reply", boardId: demo.boardId, parentIds: [nodeId] });
  expect((await serverNode(appPage, instance, demo.boardId, second.nodeId)).prompt).toBe("");
});

test("a comment can be made while the answer streams and survives the end of the run", async ({ appPage, instance, demo }) => {
  const { nodeId } = await sendFrom(appPage, instance)({ type: "reply", boardId: demo.boardId, parentIds: [], prompt: "/slow stream this answer please" });
  const answer = appPage.locator(`.react-flow__node[data-id="${nodeId}"] .answer`);
  await expect(answer).toContainText("received");
  await comment(appPage, nodeId, "received", "received", "Early note");
  await expect.poll(() => highlightedTexts(appPage)).toEqual(["received"]);
  await expect(appPage.locator(`.react-flow__node[data-id="${nodeId}"] .node-card.status-done`)).toHaveCount(1, { timeout: 20000 });
  await expect.poll(() => highlightedTexts(appPage)).toEqual(["received"]);
});

test("a comment can be made inside a tool card and inside a grouped tool run", async ({ appPage, instance, demo }) => {
  await appPage.evaluate(() => localStorage.setItem("branchboard.settings", JSON.stringify({ groupToolCalls: true })));
  await appPage.reload();
  await appPage.locator(".sidebar-board-open", { hasText: "Demo board" }).click();
  const { nodeId } = await sendFrom(appPage, instance)({ type: "reply", boardId: demo.boardId, parentIds: [], prompt: "/write notes.txt :: tool body text" });
  const card = appPage.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(card.locator(".node-card.status-done")).toHaveCount(1, { timeout: 15000 });
  await card.locator(".tool-group > summary").click();
  await card.locator(".tool-card > summary").click();
  await expect(card.locator(".tool-card .diff-view")).toContainText("tool body text");
  await comment(appPage, nodeId, "body", "text", "Which text?");
  await expect.poll(() => highlightedTexts(appPage)).toEqual(["body text"]);
  const point = await centreOfHighlight(appPage);
  await appPage.mouse.click(point.x, point.y);
  await expect(appPage.locator(".comment-menu textarea")).toHaveValue("Which text?");
});
