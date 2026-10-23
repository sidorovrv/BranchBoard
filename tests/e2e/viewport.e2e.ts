import { expect, test } from "./fixtures";

const CAMERA_SETTLE_MS = 1500;

test("each board reopens at its own saved viewport", async ({ appPage, instance, demo }) => {
  const send = async (data: Record<string, unknown>) => (await appPage.request.post(`${instance.baseUrl}/api/commands`, { data, headers: { origin: instance.baseUrl } })).json();
  const second = await send({ type: "createBoard", projectId: demo.projectId, title: "Second board" });
  await send({ type: "reply", boardId: demo.boardId, prompt: "first" });
  await send({ type: "reply", boardId: second.id, prompt: "second" });
  const saved = { [demo.boardId]: { x: 111, y: 222, zoom: 0.5 }, [second.id]: { x: -333, y: 44, zoom: 1.5 } };
  await appPage.addInitScript((viewports) => {
    Object.entries(viewports).forEach(([boardId, viewport]) => localStorage.setItem(`branchboard.viewport.${boardId}`, JSON.stringify(viewport)));
  }, saved);
  await appPage.reload();
  const viewport = appPage.locator(".react-flow__viewport");
  for (const [title, boardId] of [["Second board", second.id], ["Demo board", demo.boardId], ["Second board", second.id], ["Demo board", demo.boardId]]) {
    await appPage.locator(".sidebar-board-open", { hasText: title }).first().click();
    const { x, y, zoom } = saved[boardId];
    const savedTransform = new RegExp(`translate\\(${x}px, ${y}px\\) scale\\(${zoom}\\)`);
    await expect(viewport).toHaveAttribute("style", savedTransform);
    await appPage.waitForTimeout(CAMERA_SETTLE_MS);
    await expect(viewport).toHaveAttribute("style", savedTransform);
  }
});
