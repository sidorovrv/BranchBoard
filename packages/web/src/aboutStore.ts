import { create } from "zustand";
import { updateNoticeOf, type AboutInfo, type UpdateNotice } from "@branchboard/core";
import { fetchAbout } from "./api";

const LAST_SEEN_VERSION_KEY = "branchboard.lastSeenVersion";
const DISMISSED_NOTICE_KEY = "branchboard.dismissedNotice";

const readStored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    return;
  }
};

export const noticeKeyOf = (notice: UpdateNotice): string => `${notice.kind}:${notice.version}`;

interface AboutStore {
  about?: AboutInfo;
  isChecking: boolean;
  lastSeenVersion: string | null;
  dismissedNotice: string | null;
  load: (isFresh?: boolean) => Promise<void>;
  dismiss: (notice: UpdateNotice) => void;
}

export const useAbout = create<AboutStore>((set, get) => ({
  isChecking: false,
  lastSeenVersion: readStored(LAST_SEEN_VERSION_KEY),
  dismissedNotice: readStored(DISMISSED_NOTICE_KEY),
  load: async (isFresh = false) => {
    set({ isChecking: true });
    try {
      const about = await fetchAbout(isFresh);
      if (get().lastSeenVersion === null) writeStored(LAST_SEEN_VERSION_KEY, about.version);
      set({ about, lastSeenVersion: get().lastSeenVersion ?? about.version });
    } catch {
      return;
    } finally {
      set({ isChecking: false });
    }
  },
  dismiss: (notice) => {
    if (notice.kind === "whatsNew") {
      writeStored(LAST_SEEN_VERSION_KEY, notice.version);
      return set({ lastSeenVersion: notice.version });
    }
    writeStored(DISMISSED_NOTICE_KEY, noticeKeyOf(notice));
    set({ dismissedNotice: noticeKeyOf(notice) });
  },
}));

export const useUpdateNotice = (): UpdateNotice | null => {
  const { about, lastSeenVersion, dismissedNotice } = useAbout();
  const notice = about ? updateNoticeOf(about, lastSeenVersion) : null;
  return notice && noticeKeyOf(notice) !== dismissedNotice ? notice : null;
};
