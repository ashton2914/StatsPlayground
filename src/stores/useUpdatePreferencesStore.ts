import { create } from "zustand";

import { resolveStoredUpdatePreference } from "./updatePreferences";

interface UpdatePreferencesState {
  automaticCheck: boolean;
  includePrerelease: boolean;
  setAutomaticCheck: (enabled: boolean) => void;
  setIncludePrerelease: (enabled: boolean) => void;
}

const AUTOMATIC_CHECK_KEY = "sp-update-automatic-check";
const INCLUDE_PRERELEASE_KEY = "sp-update-include-prerelease";

export const useUpdatePreferencesStore = create<UpdatePreferencesState>((set) => ({
  automaticCheck: resolveStoredUpdatePreference(localStorage.getItem(AUTOMATIC_CHECK_KEY)),
  includePrerelease: resolveStoredUpdatePreference(localStorage.getItem(INCLUDE_PRERELEASE_KEY)),
  setAutomaticCheck: (automaticCheck) => {
    localStorage.setItem(AUTOMATIC_CHECK_KEY, String(automaticCheck));
    set({ automaticCheck });
  },
  setIncludePrerelease: (includePrerelease) => {
    localStorage.setItem(INCLUDE_PRERELEASE_KEY, String(includePrerelease));
    set({ includePrerelease });
  },
}));