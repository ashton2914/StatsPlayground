import { invoke } from "@tauri-apps/api/core";

import type {
  FitModelRequest,
  FitModelResult,
  SaveFitModelColumnsRequest,
  SaveFitModelColumnsResult,
} from "@/types/fitModel";

export const fitModelService = {
  run: (request: FitModelRequest) =>
    invoke<FitModelResult>("fit_model", { request }),
  saveColumns: (request: SaveFitModelColumnsRequest) =>
    invoke<SaveFitModelColumnsResult>("save_fit_model_columns", { request }),
};
