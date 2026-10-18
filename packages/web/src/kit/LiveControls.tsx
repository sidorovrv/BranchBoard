import { useState } from "react";

interface LiveControlsProps {
  controls: string[];
  onFollowUp: (text: string) => void;
  onBackground: () => void;
}

export const LiveControls = ({ controls, onFollowUp, onBackground }: LiveControlsProps) => {
  const [text, setText] = useState("");
  if (controls.length === 0) return null;
  const sendFollowUp = () => {
    const message = text.trim();
    if (!message) return;
    setText("");
    onFollowUp(message);
  };
  return (
    <div className="live-controls nodrag">
      {controls.includes("followUp") && (
        <>
          <input value={text} placeholder="Follow-up message" title="Sent to the running agent as an extra instruction" aria-label="Follow-up message" onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && sendFollowUp()} />
          <button onClick={sendFollowUp} disabled={!text.trim()}>Send</button>
        </>
      )}
      {controls.includes("background") && <button title="Run the current tool in the background and continue" onClick={onBackground}>Move to background</button>}
    </div>
  );
};
