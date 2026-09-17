export interface GraphBuilderNewSession {
  id: string;
  datasetId: string;
  datasetGeneration: number;
  xColumnId: string | null;
  yColumnId: string | null;
}