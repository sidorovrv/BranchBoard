import { liveNodes } from "./graph";
import type { BoardGraph, GraphNode, Usage } from "./types";

export const BUDGET_WARNING_SHARE = 0.8;

const tokensOf = (usage: Usage | undefined): number => (usage ? usage.inputTokens + usage.outputTokens : 0);

export const nodeTokenUsage = (node: GraphNode): number =>
  tokensOf(node.usage) + Object.values(node.rolls ?? {}).reduce((total, roll) => total + tokensOf(roll.usage), 0);

export const cacheReadShareOf = (usage: Usage | undefined): number | undefined =>
  usage?.cacheReadTokens !== undefined && usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : undefined;

export const boardTokenUsage = (graph: BoardGraph): number => liveNodes(graph).reduce((total, node) => total + nodeTokenUsage(node), 0);

export type BudgetState = "none" | "ok" | "warning" | "exhausted";

export const budgetStateOf = (used: number, budget: number | undefined): BudgetState => {
  if (!budget) return "none";
  if (used >= budget) return "exhausted";
  return used >= budget * BUDGET_WARNING_SHARE ? "warning" : "ok";
};
