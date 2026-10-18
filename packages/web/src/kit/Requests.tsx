import { useState } from "react";
import { activeQuestionFlags, answerValueOf, encodeAnswers, LINK_DONE_LABEL, NO_LABEL, REJECTED_ANSWER, YES_LABEL, type QuestionOption, type QuestionSpec } from "@branchboard/core";

export interface RequestData {
  id: string;
  kind: "approval" | "question";
  title: string;
  detail?: string;
  options: string[];
  questions?: QuestionSpec[];
}

export type AnswerRequest = (requestId: string, answer: string, message?: string) => unknown;

type Reply = (answer: string, message?: string) => void;

const toggled = (chosen: string[], label: string, multiple: boolean): string[] => {
  if (chosen.includes(label)) return chosen.filter((entry) => entry !== label);
  return multiple ? [...chosen, label] : [label];
};

const CHOICE_ONLY_KINDS: Array<QuestionSpec["kind"]> = ["boolean", "link"];

const placeholderOf = (spec: QuestionSpec): string => {
  if (spec.kind === "number" || spec.kind === "integer") return "Type a number";
  return spec.options.length > 0 ? "Or type your own answer" : "Type your answer";
};

const optionsOf = (spec: QuestionSpec): QuestionOption[] => {
  if (spec.options.length > 0) return spec.options;
  if (spec.kind === "boolean") return [{ label: YES_LABEL }, { label: NO_LABEL }];
  return spec.kind === "link" ? [{ label: LINK_DONE_LABEL }] : [];
};

const invalidAnswerMessage = (questions: QuestionSpec[], answers: string[][]): string | undefined => {
  try {
    questions.forEach((spec, index) => answerValueOf(spec, answers[index] ?? []));
    return undefined;
  } catch (failure) {
    return (failure as Error).message;
  }
};

const QuestionField = ({ spec, chosen, custom, onChoose, onCustom }: { spec: QuestionSpec; chosen: string[]; custom: string; onChoose: (labels: string[]) => void; onCustom: (text: string) => void }) => (
  <div className="question-field">
    {spec.header && <div className="question-header">{spec.header}</div>}
    <div className="request-title">{spec.question}</div>
    {spec.url && <a href={spec.url} target="_blank" rel="noreferrer">{spec.url}</a>}
    <div className="request-actions">
      {optionsOf(spec).map((option) => (
        <button key={option.label} className={chosen.includes(option.label) ? "primary" : ""} title={option.description} onClick={() => onChoose(toggled(chosen, option.label, Boolean(spec.multiple)))}>
          {option.label}
        </button>
      ))}
    </div>
    {!CHOICE_ONLY_KINDS.includes(spec.kind) && <input type={spec.secret ? "password" : "text"} autoComplete={spec.secret ? "off" : undefined} value={custom} onChange={(event) => onCustom(event.target.value)} placeholder={placeholderOf(spec)} />}
  </div>
);

const QuestionForm = ({ questions, reply }: { questions: QuestionSpec[]; reply: Reply }) => {
  const [chosen, setChosen] = useState<string[][]>(questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(questions.map(() => ""));
  const replace = <T,>(list: T[], index: number, value: T) => list.map((entry, position) => (position === index ? value : entry));
  const finalAnswers = questions.map((_spec, index) => (custom[index]?.trim() ? [...(chosen[index] ?? []), custom[index].trim()] : (chosen[index] ?? [])));
  const active = activeQuestionFlags(questions, finalAnswers);
  const submitted = finalAnswers.map((entry, index) => (active[index] ? entry : []));
  const isComplete = finalAnswers.every((entry, index) => !active[index] || questions[index]?.optional || entry.length > 0);
  const [error, setError] = useState<string>();
  const answer = () => {
    const message = invalidAnswerMessage(questions, submitted);
    setError(message);
    if (!message) reply(encodeAnswers(submitted));
  };
  return (
    <>
      {questions.map((spec, index) => active[index] && (
        <QuestionField key={index} spec={spec} chosen={chosen[index] ?? []} custom={custom[index] ?? ""} onChoose={(labels) => setChosen(replace(chosen, index, labels))} onCustom={(text) => setCustom(replace(custom, index, text))} />
      ))}
      {error && <div className="question-error" role="alert">{error}</div>}
      <div className="request-actions">
        <button className="primary" disabled={!isComplete} onClick={answer}>Answer</button>
        <button className="danger" onClick={() => reply(REJECTED_ANSWER)}>Dismiss</button>
      </div>
    </>
  );
};

const QuestionInput = ({ reply }: { reply: Reply }) => {
  const [text, setText] = useState("");
  return (
    <div className="request-actions">
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Your answer" />
      <button className="primary" disabled={!text.trim()} onClick={() => reply(text)}>Answer</button>
    </div>
  );
};

const ApprovalActions = ({ options, reply }: { options: string[]; reply: Reply }) => {
  const [reason, setReason] = useState("");
  return (
    <div className="request-actions">
      {options.map((option) => (
        <button key={option} className={option === "reject" ? "danger" : "primary"} onClick={() => reply(option, option === "reject" ? reason.trim() : undefined)}>{option === "once" ? "Allow once" : option === "always" ? "Always allow" : "Reject"}</button>
      ))}
      {options.includes("reject") && <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for rejecting (optional)" />}
    </div>
  );
};

const RequestBody = ({ request, reply }: { request: RequestData; reply: Reply }) => {
  if (request.kind === "approval") return <ApprovalActions options={request.options} reply={reply} />;
  if (request.questions?.length) return <QuestionForm questions={request.questions} reply={reply} />;
  return <QuestionInput reply={reply} />;
};

const RequestCard = ({ request, onAnswer }: { request: RequestData; onAnswer: AnswerRequest }) => {
  const hasQuestionForm = request.kind === "question" && Boolean(request.questions?.length);
  return (
    <div className="request-card">
      {!hasQuestionForm && <div className="request-title">{request.title}</div>}
      {request.detail && <code>{request.detail}</code>}
      <RequestBody request={request} reply={(answer, message) => void onAnswer(request.id, answer, message)} />
    </div>
  );
};

export const Requests = ({ requests, onAnswer }: { requests: RequestData[]; onAnswer: AnswerRequest }) => {
  if (requests.length === 0) return null;
  return (
    <div className="node-requests nodrag nowheel">
      {requests.map((request) => <RequestCard key={request.id} request={request} onAnswer={onAnswer} />)}
    </div>
  );
};
