import {useProjectStore} from "../stores/useProjectStore";
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
  saveColumns: async (request: SaveFitModelColumnsRequest):Promise<SaveFitModelColumnsResult> => {
    const persistence=useProjectStore.getState().persistence;
    if(!persistence)return invoke<SaveFitModelColumnsResult>("save_fit_model_columns", { request });
    return (await persistence.submit<SaveFitModelColumnsResult>({command:"save_fit_model_columns",payload:{request},datasetGenerations:[{id:request.datasetId,generation:request.expectedGeneration}]})).value;
  },
};
