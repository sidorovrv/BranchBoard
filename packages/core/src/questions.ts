import type { QuestionSpec } from "./types";

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

export const parseQuestionSpec = (raw: any): QuestionSpec => ({
  question: String(raw?.question ?? ""),
  header: raw?.header ? String(raw.header) : undefined,
  options: (raw?.options ?? []).map((option: any) => ({
    label: String(option?.label ?? option),
    description: option?.description ? String(option.description) : undefined,
  })),
  multiple: Boolean(raw?.multiple ?? raw?.multiSelect),
});
