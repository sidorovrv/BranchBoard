export type PartType = "text" | "reasoning" | "tool" | "error" | "todo" | "retry";

export interface ChatPart {
  id: string;
  seq: number;
  type: PartType;
  text: string;
  meta?: Record<string, unknown>;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export type QuestionKind = "text" | "number" | "integer" | "boolean" | "link";

export interface QuestionCondition {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
}

export interface QuestionSpec {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple?: boolean;
  kind?: QuestionKind;
  optional?: boolean;
  url?: string;
  key?: string;
  when?: QuestionCondition[];
  secret?: boolean;
}

export interface CatalogCommand {
  name: string;
  description?: string;
  template: string;
  passThrough?: boolean;
  agent?: string;
  model?: string;
  subagent?: boolean;
}

export interface RemovedBlock {
  after: number;
  lines: string[];
}

export interface GitChanges {
  added: number[];
  removed: number;
  removedBlocks: RemovedBlock[];
}
