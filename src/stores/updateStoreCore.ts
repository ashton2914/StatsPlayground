import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";

import type { ReleaseUpdate } from "@/services/updateCheckCore";

export type UpdateCheckSource = "manual" | "automatic";
export type UpdateCheckStatus = "idle" | "checking" | "upToDate" | "error" | "updateAvailable";

export interface UpdateState {
  status: UpdateCheckStatus;
  update: ReleaseUpdate | null;
  check: (source: UpdateCheckSource) => Promise<void>;
  dismiss: () => void;
}

type UpdateChecker = (includePrerelease: boolean) => Promise<ReleaseUpdate | null>;

export function createUpdateStore(
  checker: UpdateChecker,
  getIncludePrerelease: () => boolean = () => true,
): UseBoundStore<StoreApi<UpdateState>> {
  let requestId = 0;

  return create<UpdateState>((set) => ({
    status: "idle",
    update: null,
    check: async (source) => {
      const currentRequest = ++requestId;
      set({ status: "checking", update: null });
      try {
        const update = await checker(getIncludePrerelease());
        if (currentRequest !== requestId) {
          return;
        }
        if (update) {
          set({ status: "updateAvailable", update });
        } else {
          set({ status: source === "manual" ? "upToDate" : "idle", update: null });
        }
      } catch {
        if (currentRequest === requestId) {
          set({ status: source === "manual" ? "error" : "idle", update: null });
        }
      }
    },
    dismiss: () => {
      requestId += 1;
      set({ status: "idle", update: null });
    },
  }));
}