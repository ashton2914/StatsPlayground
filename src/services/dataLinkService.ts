import {useProjectStore} from "@/stores/useProjectStore";
import type {DatasetMeta} from "@/types/data";
import { invoke } from "@tauri-apps/api/core";

import type {
  ConnectionCredentials,
  ConnectionDefinition,
  ImportSummary,
  PreviewResult,
  SourceColumn,
  SourceObject,
  SourceObjectRef,
  SqliteImportSelection,
} from "@/types/dataLink";

export const dataLinkService = {
  testServerConnection: (definition: ConnectionDefinition, credentials: ConnectionCredentials) =>
    invoke<void>("test_server_connection", { definition, credentials }),

  listServerObjects: (definition: ConnectionDefinition, credentials: ConnectionCredentials) =>
    invoke<SourceObjectRef[]>("list_server_source_objects", { definition, credentials }),

  getServerSchema: (definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef) =>
    invoke<SourceColumn[]>("get_server_source_schema", { definition, credentials, object }),

  previewServerObject: (definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef, limit = 100) =>
    invoke<PreviewResult>("preview_server_source_object", { definition, credentials, object, limit }),

  importServerSnapshot: async (definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef, targetName: string) => {
    const owner=useProjectStore.getState().persistence;
    const payload={definition,credentials,object,targetName};
    return owner?(await owner.submit<ImportSummary>({command:"import_server_snapshot",payload})).value:invoke<ImportSummary>("import_server_snapshot",payload);
  },

  testPostgresConnection: (
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
  ) => invoke<void>("test_postgres_connection", { definition, credentials }),

  listPostgresObjects: (
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
  ) => invoke<SourceObjectRef[]>("list_postgres_source_objects", { definition, credentials }),

  getPostgresSchema: (
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
    object: SourceObjectRef,
  ) => invoke<SourceColumn[]>("get_postgres_source_schema", { definition, credentials, object }),

  previewPostgresObject: (
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
    object: SourceObjectRef,
    limit = 100,
  ) => invoke<PreviewResult>("preview_postgres_source_object", {
    definition,
    credentials,
    object,
    limit,
  }),

  importPostgresSnapshot: (
    definition: ConnectionDefinition,
    credentials: ConnectionCredentials,
    object: SourceObjectRef,
    targetName: string,
  ) => {
    const owner=useProjectStore.getState().persistence;
    const payload={definition,credentials,object,targetName};
    return owner?owner.submit<ImportSummary>({command:"import_postgres_snapshot",payload}).then(commit=>commit.value):invoke<ImportSummary>("import_postgres_snapshot",payload);
  },

  listSqliteObjects: (filePath: string) =>
    invoke<SourceObject[]>("list_sqlite_source_objects", { filePath }),

  previewSqliteObject: (filePath: string, objectName: string, limit = 100) =>
    invoke<PreviewResult>("preview_sqlite_source_object", { filePath, objectName, limit }),

  importSelectedSqlite: async (filePath: string, requestId: string, selections: SqliteImportSelection[]) => {
    const persistence=useProjectStore.getState().persistence;
    if(!persistence) return invoke<ImportSummary>("import_selected_sqlite",{filePath,requestId,selections});
    const appends=selections.filter(selection=>selection.action==="append");
    const datasets=appends.length?await invoke<DatasetMeta[]>("list_datasets"):[];
    if(useProjectStore.getState().persistence!==persistence) throw new Error("Project changed before import");
    const datasetGenerations=appends.map(selection=>{
      const target=datasets.find(dataset=>dataset.name.toLowerCase()===selection.targetName.toLowerCase());
      if(!target) throw new Error(`Append target dataset not found: ${selection.targetName}`);
      return {id:target.id,generation:target.generation};
    });
    return (await persistence.submit<ImportSummary>({command:"import_selected_sqlite",payload:{filePath,requestId,selections},datasetGenerations})).value;
  },

  cancelSqliteImport: (requestId: string) =>
    invoke<void>("cancel_sqlite_import", { requestId }),
};
