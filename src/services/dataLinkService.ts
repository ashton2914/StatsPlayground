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

  importServerSnapshot: (definition: ConnectionDefinition, credentials: ConnectionCredentials, object: SourceObjectRef, targetName: string) =>
    invoke<ImportSummary>("import_server_snapshot", { definition, credentials, object, targetName }),

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
  ) => invoke<ImportSummary>("import_postgres_snapshot", {
    definition,
    credentials,
    object,
    targetName,
  }),

  listSqliteObjects: (filePath: string) =>
    invoke<SourceObject[]>("list_sqlite_source_objects", { filePath }),

  previewSqliteObject: (filePath: string, objectName: string, limit = 100) =>
    invoke<PreviewResult>("preview_sqlite_source_object", { filePath, objectName, limit }),

  importSelectedSqlite: (filePath: string, requestId: string, selections: SqliteImportSelection[]) =>
    invoke<ImportSummary>("import_selected_sqlite", { filePath, requestId, selections }),

  cancelSqliteImport: (requestId: string) =>
    invoke<void>("cancel_sqlite_import", { requestId }),
};
