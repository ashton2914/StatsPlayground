/** 项目元数据 */
export interface ProjectInfo {
  name: string;
  filePath: string;
  createdAt: string;
}

/** open_project 返回结果，包含历史/快照数据 */
export interface OpenProjectResult {
  project: ProjectInfo;
  history: unknown[];
  snapshots: unknown[];
}
