import { arch, platform } from "@tauri-apps/plugin-os";

import { APP_VERSION } from "@/appVersion";
import { checkForUpdate, resolvePlatformAssetSuffix } from "@/services/updateService";

import { useUpdatePreferencesStore } from "./useUpdatePreferencesStore";
import { createUpdateStore } from "./updateStoreCore";

export const useUpdateStore = createUpdateStore(async (includePrerelease) => {
  const platformAssetSuffix = resolvePlatformAssetSuffix(platform(), arch());
  return checkForUpdate({
    currentVersion: APP_VERSION,
    includePrerelease,
    platformAssetSuffix,
  });
}, () => useUpdatePreferencesStore.getState().includePrerelease);