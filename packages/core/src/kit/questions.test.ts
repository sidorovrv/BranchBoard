import { describe, expect, it } from "vitest";
import { activeQuestionFlags, answerValueOf, decodeAnswers, describeAnswers, encodeAnswers, parseQuestionSpec, REJECTED_ANSWER, SECRET_MASK, withoutSecretAnswers } from "./questions";

describe("question answers", () => {
  it("parses question specs from both runtimes' shapes", () => {
    expect(parseQuestionSpec({ question: "Pick", header: "H", options: [{ label: "a", description: "d" }, "b"], multiSelect: true })).toEqual({
      question: "Pick",
      header: "H",
      options: [{ label: "a", description: "d" }, { label: "b", description: undefined }],
      multiple: true,
    });
    expect(parseQuestionSpec({ question: "Solo", options: [] }).multiple).toBe(false);
  });

  it("round-trips an answer grid", () => {
    const grid = [["apple"], ["cream", "nuts"]];
    expect(decodeAnswers(2, encodeAnswers(grid))).toEqual(grid);
  });

  it("wraps a plain text answer as the first answer", () => {
    expect(decodeAnswers(2, "just text")).toEqual([["just text"], []]);
    expect(decodeAnswers(1, "42")).toEqual([["42"]]);
  });

  it("describes answers for display", () => {
    expect(describeAnswers(2, encodeAnswers([["apple"], ["cream", "nuts"]]))).toBe("apple | cream, nuts");
  });

  it("keeps typed field details and only web addresses", () => {
    expect(parseQuestionSpec({ question: "Size", kind: "integer", optional: true, url: "https://example.com" })).toMatchObject({ kind: "integer", optional: true, url: "https://example.com" });
    expect(parseQuestionSpec({ question: "Open", kind: "link", url: "javascript:alert(1)" }).url).toBeUndefined();
    expect(parseQuestionSpec({ question: "Odd", kind: "other" }).kind).toBeUndefined();
  });

  it("shows a conditional question only while its condition holds", () => {
    const questions = [
      parseQuestionSpec({ question: "Agree?", key: "agree", kind: "boolean" }),
      parseQuestionSpec({ question: "Why?", key: "why", when: [{ key: "agree", op: "eq", value: true }] }),
      parseQuestionSpec({ question: "Why not?", key: "whyNot", when: [{ key: "agree", op: "neq", value: true }, { op: "bad" }] }),
    ];
    expect(activeQuestionFlags(questions, [[], [], []])).toEqual([true, false, true]);
    expect(activeQuestionFlags(questions, [["Yes"], [], []])).toEqual([true, true, false]);
    expect(activeQuestionFlags(questions, [["No"], [], []])).toEqual([true, false, true]);
  });

  it("turns an answer cell into the typed value of its field", () => {
    const spec = (extra: object) => parseQuestionSpec({ question: "Q", options: [], ...extra });
    expect(answerValueOf(spec({}), ["  text "])).toBe("text");
    expect(answerValueOf(spec({}), [""])).toBeUndefined();
    expect(answerValueOf(spec({ kind: "number" }), ["2.5"])).toBe(2.5);
    expect(() => answerValueOf(spec({ kind: "integer" }), ["abc"])).toThrow('"abc" is not a number.');
    expect(answerValueOf(spec({ kind: "boolean" }), ["Yes"])).toBe(true);
    expect(answerValueOf(spec({ kind: "boolean" }), ["No"])).toBe(false);
    expect(answerValueOf(spec({ kind: "link" }), ["Done"])).toBe(true);
    expect(answerValueOf(spec({ multiple: true }), ["a", "b"])).toEqual(["a", "b"]);
  });

  it("masks the answers of secret questions", () => {
    const secret = parseQuestionSpec({ question: "Token?", isSecret: true });
    const plain = parseQuestionSpec({ question: "Name?" });
    expect(secret.secret).toBe(true);
    expect(plain.secret).toBeUndefined();
    const questions = [secret, plain];
    expect(decodeAnswers(2, withoutSecretAnswers(questions, encodeAnswers([["hunter2"], ["Ada"]])))).toEqual([[SECRET_MASK], ["Ada"]]);
    expect(withoutSecretAnswers([plain], "plain")).toBe("plain");
    expect(withoutSecretAnswers(questions, REJECTED_ANSWER)).toBe(REJECTED_ANSWER);
  });
});
