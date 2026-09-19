import { invoke } from "@tauri-apps/api/core";
import type { DatasetMeta } from "@/types/data";
import type {
  TabulateMaterializeRequest,
  TabulateSessionRequest,
  TabulateSessionStatus,
  TabulateTotalsRequest,
  TabulateTotalsResult,
  TabulateWindowRequest,
  TabulateWindowResult,
} from "@/types/tabulate";

export const tabulateService = {
  prepare: (request: TabulateSessionRequest) =>
    invoke<TabulateSessionStatus>("prepare_tabulate_session", { request }),
  getStatus: (sessionId: string) =>
    invoke<TabulateSessionStatus>("get_tabulate_session_status", { sessionId }),
  queryWindow: (request: TabulateWindowRequest) =>
    invoke<TabulateWindowResult>("query_tabulate_window", { request }),
  queryTotals: (request: TabulateTotalsRequest) =>
    invoke<TabulateTotalsResult>("query_tabulate_totals", { request }),
  cancelRequest: (requestId: string) =>
    invoke<void>("cancel_tabulate_request", { requestId }),
  release: (sessionId: string) =>
    invoke<void>("release_tabulate_session", { sessionId }),
  materializeTable: (request: TabulateMaterializeRequest) =>
    invoke<DatasetMeta>("materialize_tabulate_table", { request }),
};