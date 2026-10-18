import type { QuestionCondition, QuestionKind, QuestionSpec } from "./types";

export const REJECTED_ANSWER = "reject";

export const encodeAnswers = (answers: string[][]): string => JSON.stringify(answers);

const parseAnswerGrid = (raw: string): string[][] | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    const isAnswerGrid = Array.isArray(parsed) && parsed.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"));
    return isAnswerGrid ? (parsed as string[][]) : undefined;
  } catch {
    return undefined;
  }
};

export const decodeAnswers = (questionCount: number, raw: string): string[][] =>
  parseAnswerGrid(raw) ?? Array.from({ length: Math.max(1, questionCount) }, (_unused, index) => (index === 0 ? [raw] : []));

export const describeAnswers = (questionCount: number, raw: string): string =>
  decodeAnswers(questionCount, raw)
    .map((row) => row.join(", "))
    .filter(Boolean)
    .join(" | ");

export const YES_LABEL = "Yes";
export const NO_LABEL = "No";
export const LINK_DONE_LABEL = "Done";

const QUESTION_KINDS: QuestionKind[] = ["text", "number", "integer", "boolean", "link"];
const WEB_URL = /^https?:\/\//i;

const isCondition = (raw: any): raw is QuestionCondition =>
  typeof raw?.key === "string" && (raw.op === "eq" || raw.op === "neq") && ["string", "number", "boolean"].includes(typeof raw.value);

export const parseQuestionSpec = (raw: any): QuestionSpec => ({
  question: String(raw?.question ?? ""),
  header: raw?.header ? String(raw.header) : undefined,
  options: (raw?.options ?? []).map((option: any) => ({
    label: String(option?.label ?? option),
    description: option?.description ? String(option.description) : undefined,
  })),
  multiple: Boolean(raw?.multiple ?? raw?.multiSelect),
  ...(QUESTION_KINDS.includes(raw?.kind) ? { kind: raw.kind } : {}),
  ...(raw?.optional ? { optional: true } : {}),
  ...(typeof raw?.url === "string" && WEB_URL.test(raw.url) ? { url: raw.url } : {}),
  ...(typeof raw?.key === "string" ? { key: raw.key } : {}),
  ...(Array.isArray(raw?.when) && raw.when.length > 0 ? { when: raw.when.filter(isCondition) } : {}),
  ...(raw?.secret || raw?.isSecret ? { secret: true } : {}),
});

export const SECRET_MASK = "••••••";

export const withoutSecretAnswers = (questions: QuestionSpec[] | undefined, raw: string): string => {
  if (!questions?.some((spec) => spec.secret) || raw === REJECTED_ANSWER) return raw;
  const grid = decodeAnswers(questions.length, raw);
  return encodeAnswers(grid.map((cell, index) => (questions[index]?.secret && cell.length > 0 ? [SECRET_MASK] : cell)));
};

export type AnswerValue = string | number | boolean | string[];

const NUMERIC_KINDS: Array<QuestionKind | undefined> = ["number", "integer"];

export const answerValueOf = (spec: QuestionSpec, cell: string[]): AnswerValue | undefined => {
  const picked = cell.map((entry) => entry.trim()).filter(Boolean);
  if (spec.multiple) return picked;
  const [first] = picked;
  if (first === undefined) return undefined;
  if (spec.kind === "link") return true;
  if (spec.kind === "boolean") return /^(yes|true)$/i.test(first);
  if (NUMERIC_KINDS.includes(spec.kind)) {
    const value = Number(first);
    if (!Number.isFinite(value)) throw new Error(`"${first}" is not a number.`);
    return value;
  }
  return first;
};

const valueOrUndefined = (spec: QuestionSpec, cell: string[]): AnswerValue | undefined => {
  try {
    return answerValueOf(spec, cell);
  } catch {
    return undefined;
  }
};

const conditionHolds = (condition: QuestionCondition, questions: QuestionSpec[], grid: string[][]): boolean => {
  const index = questions.findIndex((spec) => spec.key === condition.key);
  const question = questions[index];
  if (!question) return true;
  const current = valueOrUndefined(question, grid[index] ?? []);
  const isEqual = Array.isArray(current) ? current.includes(String(condition.value)) : current === condition.value;
  return condition.op === "eq" ? isEqual : !isEqual;
};

export const activeQuestionFlags = (questions: QuestionSpec[], grid: string[][]): boolean[] =>
  questions.map((spec) => (spec.when ?? []).every((condition) => conditionHolds(condition, questions, grid)));
