import { useMemo, useState } from "react";
import { encodeAnswers, REJECTED_ANSWER, type PendingRequest, type QuestionSpec } from "@branchboard/core";
import { sendBoardCommand, useBoard } from "../store";

const answer = (request: PendingRequest, value: string) => sendBoardCommand({ type: "answerRequest", requestId: request.id, answer: value });

const toggled = (chosen: string[], label: string, multiple: boolean): string[] => {
  if (chosen.includes(label)) return chosen.filter((entry) => entry !== label);
  return multiple ? [...chosen, label] : [label];
};

const QuestionField = ({ spec, chosen, custom, onChoose, onCustom }: { spec: QuestionSpec; chosen: string[]; custom: string; onChoose: (labels: string[]) => void; onCustom: (text: string) => void }) => (
  <div className="question-field">
    {spec.header && <div className="question-header">{spec.header}</div>}
    <div className="request-title">{spec.question}</div>
    <div className="request-actions">
      {spec.options.map((option) => (
        <button key={option.label} className={chosen.includes(option.label) ? "primary" : ""} title={option.description} onClick={() => onChoose(toggled(chosen, option.label, Boolean(spec.multiple)))}>
          {option.label}
        </button>
      ))}
    </div>
    <input value={custom} onChange={(event) => onCustom(event.target.value)} placeholder="Or type your own answer" />
  </div>
);

const QuestionForm = ({ request, questions }: { request: PendingRequest; questions: QuestionSpec[] }) => {
  const [chosen, setChosen] = useState<string[][]>(questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(questions.map(() => ""));
  const replace = <T,>(list: T[], index: number, value: T) => list.map((entry, position) => (position === index ? value : entry));
  const finalAnswers = questions.map((_spec, index) => (custom[index].trim() ? [...chosen[index], custom[index].trim()] : chosen[index]));
  const isComplete = finalAnswers.every((entry) => entry.length > 0);
  return (
    <>
      {questions.map((spec, index) => (
        <QuestionField key={index} spec={spec} chosen={chosen[index]} custom={custom[index]} onChoose={(labels) => setChosen(replace(chosen, index, labels))} onCustom={(text) => setCustom(replace(custom, index, text))} />
      ))}
      <div className="request-actions">
        <button className="primary" disabled={!isComplete} onClick={() => void answer(request, encodeAnswers(finalAnswers))}>Answer</button>
        <button className="danger" onClick={() => void answer(request, REJECTED_ANSWER)}>Dismiss</button>
      </div>
    </>
  );
};

const QuestionInput = ({ request }: { request: PendingRequest }) => {
  const [text, setText] = useState("");
  return (
    <div className="request-actions">
      <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Your answer" />
      <button className="primary" disabled={!text.trim()} onClick={() => void answer(request, text)}>Answer</button>
    </div>
  );
};

const ApprovalActions = ({ request }: { request: PendingRequest }) => (
  <div className="request-actions">
    {request.options.map((option) => (
      <button key={option} className={option === "reject" ? "danger" : "primary"} onClick={() => void answer(request, option)}>{option === "once" ? "Allow once" : option === "always" ? "Always allow" : "Reject"}</button>
    ))}
  </div>
);

const RequestBody = ({ request }: { request: PendingRequest }) => {
  if (request.kind === "approval") return <ApprovalActions request={request} />;
  if (request.questions?.length) return <QuestionForm request={request} questions={request.questions} />;
  return <QuestionInput request={request} />;
};

const RequestCard = ({ request }: { request: PendingRequest }) => {
  const hasQuestionForm = request.kind === "question" && Boolean(request.questions?.length);
  return (
    <div className="request-card">
      {!hasQuestionForm && <div className="request-title">{request.title}</div>}
      {request.detail && <code>{request.detail}</code>}
      <RequestBody request={request} />
    </div>
  );
};

export const NodeRequests = ({ nodeId }: { nodeId: string }) => {
  const requests = useBoard((state) => state.view.requests);
  const open = useMemo(() => Object.values(requests).filter((request) => request.status === "open" && request.nodeId === nodeId), [requests, nodeId]);
  if (open.length === 0) return null;
  return (
    <div className="node-requests nodrag nowheel">
      {open.map((request) => <RequestCard key={request.id} request={request} />)}
    </div>
  );
};
