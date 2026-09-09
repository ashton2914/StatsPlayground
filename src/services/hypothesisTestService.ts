import { invoke } from "@tauri-apps/api/core";

import type { HypothesisTestRequest, HypothesisTestResponse } from "@/types/hypothesisTest";

export const hypothesisTestService = {
  run: (request: HypothesisTestRequest) =>
    invoke<HypothesisTestResponse>("run_hypothesis_test", { request }),
};