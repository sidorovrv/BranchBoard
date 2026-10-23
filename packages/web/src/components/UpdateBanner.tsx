import { useEffect } from "react";
import { updateCommand, type UpdateNotice, type UpdateNoticeKind } from "@branchboard/core";
import { useAbout, useUpdateNotice } from "../aboutStore";
import { copyText } from "../store";

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

const NOTICE_TEXT: Record<UpdateNoticeKind, (version: string) => string> = {
  unsupported: (version) => `This version is out of date, v${version} is needed`,
  restart: (version) => `v${version} is installed, restart Branchboard`,
  available: (version) => `v${version} is available`,
  whatsNew: (version) => `Updated to v${version}, what's new`,
};

const COPYABLE_KINDS: UpdateNoticeKind[] = ["unsupported", "available"];

export const copyUpdateCommand = (version: string) => {
  const command = updateCommand(version);
  void copyText(command, `Copied: ${command}`);
};

const NoticeBanner = ({ notice }: { notice: UpdateNotice }) => {
  const dismiss = useAbout((state) => state.dismiss);
  return (
    <span className={`update-banner ${notice.kind}`}>
      <a href={notice.notesUrl} target="_blank" rel="noreferrer">{NOTICE_TEXT[notice.kind](notice.version)}</a>
      {COPYABLE_KINDS.includes(notice.kind) && <button onClick={() => copyUpdateCommand(notice.version)} title={`Copy: ${updateCommand(notice.version)}`}>Copy update command</button>}
      <button onClick={() => dismiss(notice)} aria-label="Dismiss this notice">×</button>
    </span>
  );
};

export const UpdateBanner = () => {
  const load = useAbout((state) => state.load);
  const notice = useUpdateNotice();
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return notice ? <NoticeBanner notice={notice} /> : null;
};
