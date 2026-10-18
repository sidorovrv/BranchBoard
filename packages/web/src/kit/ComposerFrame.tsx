import type { ReactNode } from "react";
import { Icon } from "./Icons";

interface ComposerAction {
  label: string;
  onClick: () => void;
}

interface ComposerFrameProps {
  className?: string;
  picker?: ReactNode;
  editor: ReactNode;
  attachments?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  send: ComposerAction & { disabled: boolean; countdown?: string };
  sendOptions?: ComposerAction & { disabled: boolean };
  overlay?: ReactNode;
  stop?: ComposerAction;
}

export const ComposerFrame = ({ className, picker, editor, attachments, leading, trailing, send, sendOptions, overlay, stop }: ComposerFrameProps) => (
  <div className={`composer nodrag nowheel ${className ?? ""}`}>
    {picker}
    {editor}
    {attachments}
    <div className="composer-row">
      <div className="composer-chips">{leading}</div>
      <div className="composer-send">
        {trailing}
        {stop && (
          <button className="send-button stop-button" onClick={stop.onClick} title={stop.label} aria-label={stop.label}>
            <Icon name="stop" />
          </button>
        )}
        <div className="send-split">
          <button className={`send-button primary send-main${send.countdown === undefined ? "" : " countdown"}`} disabled={send.disabled} onClick={send.onClick} title={send.label} aria-label={send.label}>
            {send.countdown ?? <Icon name="send" />}
          </button>
          {sendOptions && (
            <button className="send-button primary send-options" disabled={sendOptions.disabled} onClick={sendOptions.onClick} title={sendOptions.label} aria-label={sendOptions.label}>
              <Icon name="chevronDown" />
            </button>
          )}
        </div>
      </div>
    </div>
    {overlay}
  </div>
);
