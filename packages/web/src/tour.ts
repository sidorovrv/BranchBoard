import { emptyView, importBoardDocument, SAMPLE_BOARD_TITLE, type Board, type BoardView } from "@branchboard/core";
import { useBoard } from "./store";
import sampleDocument from "./assets/sample.branchboard.json";

const sampleBoardOf = (): { board: Board; view: BoardView } => {
  const imported = importBoardDocument(JSON.stringify(sampleDocument));
  const now = Date.now();
  const board: Board = { id: imported.boardId, title: SAMPLE_BOARD_TITLE, workspacePath: "", mode: "fake", createdAt: now, updatedAt: now, deleted: false };
  return { board, view: { ...emptyView(), graph: imported.graph, parts: imported.parts } };
};

export const startTour = () => useBoard.getState().beginTour(sampleBoardOf());

export const endTour = () => useBoard.getState().endTour();
