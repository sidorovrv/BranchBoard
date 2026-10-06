import type { TodoItem, TodoStatus } from "./types";

const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: "pending",
  todo: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  active: "in_progress",
  completed: "completed",
  done: "completed",
  cancelled: "completed",
};

const textOfTodo = (raw: any): string => String(raw?.content ?? raw?.activeForm ?? raw?.text ?? raw?.title ?? "").trim();

export const parseTodoItems = (raw: unknown): TodoItem[] =>
  (Array.isArray(raw) ? raw : [])
    .map((entry): TodoItem => ({ content: textOfTodo(entry), status: STATUS_ALIASES[String(entry?.status ?? "pending")] ?? "pending" }))
    .filter((item) => item.content !== "");

export const todoProgress = (items: TodoItem[]): { done: number; total: number } => ({
  done: items.filter((item) => item.status === "completed").length,
  total: items.length,
});
