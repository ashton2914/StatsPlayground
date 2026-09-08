export type ReportEmbedKind = "table" | "graph" | "fitYByX" | "tabulate" | "distribution";

export interface ReportDependency {
  kind: ReportEmbedKind;
  documentId: string;
}

export interface ReportItem {
  schemaVersion: 1;
  id: string;
  name: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}

export type ReportToken =
  | {
      type: "markdown";
      markdown: string;
    }
  | {
      type: "embed";
      dependency: ReportDependency;
    };