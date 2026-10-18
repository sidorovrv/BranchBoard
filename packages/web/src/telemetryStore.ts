import { create } from "zustand";
import type { TelemetryOverview } from "@branchboard/core";
import { fetchTelemetry, sendCommand } from "./api";
import { useBoard } from "./store";

interface TelemetryStore {
  overview?: TelemetryOverview;
  isDialogOpen: boolean;
  isAskDismissed: boolean;
  setDialogOpen: (isOpen: boolean) => void;
  dismissDialog: () => void;
  load: () => Promise<void>;
  setConsent: (isGranted: boolean) => Promise<void>;
}

export const useTelemetry = create<TelemetryStore>((set, get) => ({
  isDialogOpen: false,
  isAskDismissed: false,
  setDialogOpen: (isOpen) => set({ isDialogOpen: isOpen }),
  dismissDialog: () => set({ isDialogOpen: false, isAskDismissed: true }),
  load: async () => {
    try {
      set({ overview: await fetchTelemetry() });
    } catch {
      return;
    }
  },
  setConsent: async (isGranted) => {
    try {
      await sendCommand({ type: "setTelemetryConsent", granted: isGranted });
      await get().load();
    } catch (error) {
      useBoard.getState().notify(error instanceof Error ? error.message : String(error));
    }
  },
}));
