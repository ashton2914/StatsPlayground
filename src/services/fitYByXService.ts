import { invoke } from "@tauri-apps/api/core";

import type { FitYByXRequest, FitYByXResponse, FitYByXResult } from "@/types/fitYByX";

export const fitYByXService = {
  compute: (request: FitYByXRequest) =>
    invoke<FitYByXResponse>("fit_y_by_x", { request }),
  run: async (request: FitYByXRequest): Promise<FitYByXResult> =>
    (await fitYByXService.compute(request)).result,
};