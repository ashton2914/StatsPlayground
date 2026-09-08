import { invoke } from "@tauri-apps/api/core";

import type {
  BlackBoxCaseV1,
  CapabilityDescriptorV1,
  DistributionReportResponse,
  DistributionRequest,
} from "@/types/distribution";

export const distributionService = {
  listCapabilities: () =>
    invoke<CapabilityDescriptorV1[]>("list_distribution_capabilities"),
  validateBlackBoxCase: (caseDefinition: BlackBoxCaseV1) =>
    invoke<void>("validate_black_box_case", { case: caseDefinition }),
  compute: (request: DistributionRequest) =>
    invoke<DistributionReportResponse>("compute_distribution_report", { request }),
};