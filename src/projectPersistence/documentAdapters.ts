import {useDatasetFilterStore} from "../stores/useDatasetFilterStore";
import {useTableViewportStore} from "../stores/useTableViewportStore";
import {prepareProjectSettingProjection} from "./settingsProjection";
import {assertProjectMutable} from "../utils/saveReadOnly";
import {useProjectStore} from "../stores/useProjectStore";
import {useDataStore} from "../stores/useDataStore";
import { extractReportDependencies } from "../utils/reportParser";
import { useHistoryStore } from "../stores/useHistoryStore";
import { DIRECTORY_MAP_KEYS, installProjectRecordMutationSink, type ProjectRecordMutation } from "./recordMutations";
import type { ProjectPersistenceCoordinator, ProjectCommitSource } from "./coordinator";
import type { ProjectCommit, ProjectDocumentBody, ProjectDocumentKind, ProjectDocumentSummary, ProjectRecordPatch, SettingRevision, ProjectSettingRecord } from "../types/projectPersistence";
import { installDocumentNameInventory, createNamedDocumentHelpers, installDocumentMutationSink, withoutDocumentPersistence, type PersistedDocumentKind, type PersistedNamedDocument } from "../stores/documentStore";
import { useReportStore } from "../stores/useReportStore";
import { useGraphBuilderStore, normalizeStoredGraphBuilderItem } from "../stores/useGraphBuilderStore";
import { useGraphBuilderNewStore, normalizeGraphNewDocument } from "../stores/useGraphBuilderNewStore";
import { useAnalysisStore, normalizePersistedAnalysisDocument } from "../stores/useAnalysisStore";
import { useTabulateStore } from "../stores/useTabulateStore";
import { useWorkflowStore } from "../stores/useWorkflowStore";
import { useTableTransformStore } from "../stores/useTableTransformStore";
import {folderAncestors} from "../stores/useFolderStore";
import { useFolderStore } from "../stores/useFolderStore";
import type { ReportItem } from "../types/report";
import type { GraphBuilderItem } from "../types/graphBuilder";
import type { PersistedGraphBuilderNewDocument } from "../types/graphBuilderNew";
import type { AnalysisDocument } from "../types/analysis";
import type { TabulateItem } from "../types/tabulate";
import type { WorkflowDefinition } from "../types/workflow";
import type { TableTransformDefinition } from "../types/tableTransform";

function pick(item: PersistedNamedDocument, keys: readonly string[]): Record<string, unknown> {
  const source = item as unknown as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}
function bodyFor(kind: PersistedDocumentKind, item: PersistedNamedDocument): Record<string, unknown> {
  switch (kind) {
    case "report": return pick(item, ["schemaVersion", "id", "name", "markdown", "createdAt", "updatedAt"]);
    case "graphNew": return pick(item, ["version", "id", "name", "datasetId", "layers", "overlayColumnId", "hiddenOverlayGroupIds", "xColumnId", "yColumnId", "xMode", "camera"]);
    case "graph": return pick(item, ["id", "name", "sourceDatasetId", "mode", "modeStates", "sampling", "groupThemeSlots", "createdAt"]);
    case "analysis": return pick(item, ["documentType", "schemaVersion", "id", "name", "analysisKind", "source", "configRevision", "definition", "presentation", "createdAt", "updatedAt"]);
    case "tabulate": return pick(item, ["id", "name", "sourceDatasetId", "rowFields", "columnFields", "statistics", "includeRowTotals", "includeColumnTotals", "createdAt"]);
    case "workflow": return pick(item, ["id", "name", "description", "formatVersion", "revision", "inputSlots", "operations", "edges", "outputDeclarations", "layout"]);
    case "transform": return pick(item, ["id", "name", "formatVersion", "revision", "operation", "inputSlots", "output"]);
  }
}
function dependencies(kind: PersistedDocumentKind, body: Record<string, unknown>): string[] {
  if (kind === "report") return [...new Set(extractReportDependencies(String(body.markdown ?? "")).map((dependency) => dependency.documentId))].sort();
  const source = body.source as { datasetId?: string; tableDocumentId?: string } | undefined;
  const id = body.datasetId ?? body.sourceDatasetId ?? source?.datasetId ?? source?.tableDocumentId;
  return typeof id === "string" ? [id] : [];
}
function folderFor(kind: PersistedDocumentKind, id: string, fallback: string): string {
  const folders = useFolderStore.getState();
  const mapping = kind === "report" ? folders.reportFolders : kind === "graphNew" ? folders.graphNewFolders
    : kind === "graph" ? folders.graphFolders : kind === "analysis" ? folders.analysisFolders
    : kind === "tabulate" ? folders.tabulateFolders : undefined;
  return mapping?.[id] ?? fallback;
}
function replaceById<T extends { id: string }>(items: readonly T[], item: T): T[] {
  return items.some((existing) => existing.id === item.id) ? items.map((existing) => existing.id === item.id ? item : existing) : [...items, item];
}
function currentDocument(kind: ProjectDocumentKind, id: string): PersistedNamedDocument | undefined {
  switch (kind) {
    case "report": return useReportStore.getState().items.find((item) => item.id === id);
    case "graph": return useGraphBuilderStore.getState().items.find((item) => item.id === id);
    case "graphNew": return useGraphBuilderNewStore.getState().items.find((item) => item.id === id);
    case "analysis": return useAnalysisStore.getState().items.find((item) => item.id === id);
    case "tabulate": return useTabulateStore.getState().items.find((item) => item.id === id);
    case "workflow": return useWorkflowStore.getState().workflows.find((item) => item.id === id);
    case "transform": return useTableTransformStore.getState().definitions.find((item) => item.id === id);
    default: return undefined;
  }
}

function projectDirectoryName(kind:ProjectDocumentKind,id:string,name:string) {
  withoutDocumentPersistence(()=>{
    const rename=<T extends {id:string;name?:string}>(items:readonly T[])=>items.map(item=>item.id===id?{...item,name}:item);
    switch(kind) {
      case "table":useDataStore.setState(state=>({datasets:rename(state.datasets)}));break;
      case "report":useReportStore.setState(state=>({items:rename(state.items),counter:Math.max(state.counter,createNamedDocumentHelpers("Report").maxSuffix([{name}]))}));break;
      case "graph":useGraphBuilderStore.setState(state=>({items:rename(state.items)}));break;
      case "graphNew":useGraphBuilderNewStore.setState(state=>({items:rename(state.items),sessions:rename(state.sessions)}));break;
      case "analysis":useAnalysisStore.setState(state=>({items:rename(state.items),counter:Math.max(state.counter,createNamedDocumentHelpers("Analysis").maxSuffix([{name}]))}));break;
      case "tabulate":useTabulateStore.setState(state=>({items:rename(state.items),counter:Math.max(state.counter,createNamedDocumentHelpers("Tabulate").maxSuffix([{name}]))}));break;
      case "workflow":useWorkflowStore.setState(state=>({workflows:rename(state.workflows)}));break;
      case "transform":useTableTransformStore.setState(state=>({definitions:rename(state.definitions)}));break;
    }
  });
}
function projectDirectoryDeletion(kind:ProjectDocumentKind,id:string,preserveHistory=false) {
  withoutDocumentPersistence(()=>{
    const remove=<T extends {id:string}>(items:readonly T[])=>items.filter(item=>item.id!==id);
    const revisions=(values:Record<string,number>)=>Object.fromEntries(Object.entries(values).filter(([key])=>key!==id));
    switch(kind) {
      case "table": {
        useDataStore.setState(state=>({datasets:remove(state.datasets),activeDatasetId:state.activeDatasetId===id?null:state.activeDatasetId}));
        useDatasetFilterStore.setState(state=>({byDataset:Object.fromEntries(Object.entries(state.byDataset).filter(([key])=>key!==id))}));
        useTableViewportStore.getState().removeDataset(id);
        if(!preserveHistory) useHistoryStore.setState(state=>{
          const retained=(entry:typeof state.history[number])=>entry.action?.datasetId!==id;
          const history=state.history.filter(retained);
          return {history,currentIdx:history.length?state.history.slice(0,Math.max(0,state.currentIdx)).filter(retained).length:-1,pendingAction:state.pendingAction?.action.datasetId===id?null:state.pendingAction,historyRevision:state.historyRevision+1,dataRevision:state.dataRevision+1};
        });break;
      }
      case "report":useReportStore.setState(state=>({items:remove(state.items),documentRevisions:revisions(state.documentRevisions)}));break;
      case "graph":useGraphBuilderStore.setState(state=>({items:remove(state.items),documentRevisions:revisions(state.documentRevisions)}));break;
      case "graphNew":useGraphBuilderNewStore.setState(state=>({items:remove(state.items),sessions:remove(state.sessions)}));break;
      case "analysis":useAnalysisStore.setState(state=>({items:remove(state.items)}));break;
      case "tabulate":useTabulateStore.setState(state=>({items:remove(state.items)}));break;
    }
    const folders=useFolderStore.getState();
    const changes:Partial<Record<typeof DIRECTORY_MAP_KEYS[number],Record<string,string>>>={};
    for(const key of DIRECTORY_MAP_KEYS) if(id in folders[key]) {const next={...folders[key]};delete next[id];changes[key]=next;}
    useFolderStore.setState(changes);
  });
}

export interface ProjectDocumentAdapters {
  activate(): () => void;
  getSummary(id: string): ProjectDocumentSummary | undefined;
  directorySummaries(): ProjectDocumentSummary[];
  hasSelectableBody(id:string):boolean;
  renameDirectoryDocument(id:string,name:string):Promise<void>;
  deleteDirectoryDocument(id:string):Promise<void>;
  registerSummary(summary: ProjectDocumentSummary, committedRevision?: number): void;
  projectFolders():void;
  reconcileDirectory(items:readonly ProjectDocumentSummary[],committedRevision:number):void;
  hydrate(document: ProjectDocumentBody): boolean;
  hydrateSetting(key:string,record:ProjectSettingRecord|null):boolean;
  applyCommit(commit: ProjectCommit<unknown>, source?: ProjectCommitSource): void;
  persist(kind: ProjectDocumentKind, id: string, expectedRevision: number): Promise<void>;
}
let activeAdapters: { epoch: number; adapter: ProjectDocumentAdapters } | null = null;

export function createProjectDocumentAdapters(input: { coordinator: ProjectPersistenceCoordinator; summaries: readonly ProjectDocumentSummary[]; settings?: readonly SettingRevision[] }): ProjectDocumentAdapters {
  const summaries = new Map(input.summaries.map((summary) => [summary.id, structuredClone(summary)]));
  const bodyRevisions = new Map(input.summaries.filter(summary=>currentDocument(summary.kind,summary.id)).map(summary=>[summary.id,summary.revision]));
  const metadataRevisions = new Map(input.summaries.map(summary=>[summary.id,input.coordinator.snapshot().committedRevision]));
  const settingRevisions = new Map(input.settings?.map((setting) => [setting.key, setting.revision]));
  const pendingSettings=new Map<string,number>();
  const pendingFolders=new Map<string,{sequence:number;present:boolean}>();
  const pending = new Map<string, { sequence: number; summary: ProjectDocumentSummary }>();
  const deletes = new Map<string, number>();
  const deleted = new Set<string>();
  const committedDeletes=new Map<string,number>();
  const epoch = input.coordinator.snapshot().epoch;
  let tableHistoryFloor=input.coordinator.snapshot().committedRevision;
  function enqueue(kind: PersistedDocumentKind, item: PersistedNamedDocument, expectedRevision?: number | null) {
    const old = summaries.get(item.id);
    if((deleted.has(item.id)||committedDeletes.has(item.id))&&expectedRevision!==null) throw new Error("project_document_deleted");
    if(expectedRevision===null) bodyRevisions.delete(item.id);
    const body = bodyFor(kind, item);
    if(expectedRevision===undefined&&old&&!bodyRevisions.has(item.id)) throw new Error("Document body is not loaded at an acknowledged revision");
    const expected = expectedRevision === undefined ? bodyRevisions.get(item.id) ?? null : expectedRevision;
    const summary: ProjectDocumentSummary = { id: item.id, name: item.name, kind,
      ...(kind==="analysis"?{analysisKind:(item as AnalysisDocument).analysisKind}:{}),
      folder: folderFor(kind, item.id, old?.folder ?? ""), revision: (expected ?? 0) + 1, dependencies: dependencies(kind, body) };
    deleted.delete(item.id);
    const sequence = input.coordinator.enqueueDocument({ expectedRevision: expected, document: { summary, body, schemaVersion: 1 } });
    pending.set(item.id, { sequence, summary });
    return sequence;
  }
  function renameMetadata(summary: ProjectDocumentSummary,name: string) {
    const nextSummary={...summary,name};
    const promise=input.coordinator.submit({command:"commit_project_records",payload:{directoryMoves:[{id:summary.id,expectedRevision:summary.revision,folder:summary.folder,name}]} satisfies ProjectRecordPatch,
      documentRevisions:[{id:summary.id,revision:summary.revision}]});
    pending.set(summary.id,{sequence:input.coordinator.snapshot().pendingSequence,summary:nextSummary});
    return promise.then(()=>undefined);
  }

  function persistRecords(mutation: ProjectRecordMutation) {
    const patch: ProjectRecordPatch = {};
    if (mutation.kind === "settings") {
      patch.settings = mutation.settings.map((setting) => ({ ...setting, expectedRevision: settingRevisions.get(setting.key) ?? null }));
    } else if (mutation.kind === "removeTransform") {
      patch.deletedDocumentIds = [mutation.id];
      patch.settings = [{ key: "lineage", expectedRevision: settingRevisions.get("lineage") ?? null, value: mutation.lineage },
        { key: `transformBinding:${mutation.id}`, expectedRevision: settingRevisions.get(`transformBinding:${mutation.id}`) ?? null, value: null }];
    } else {
      const { before, after } = mutation;
      patch.createdFolders = after.folders.filter((folder) => !before.folders.includes(folder));
      patch.deletedFolders = before.folders.filter((folder) => !after.folders.includes(folder)).sort((a, b) => b.split("/").length - a.split("/").length);
      patch.directoryMoves = [];
      for (const key of DIRECTORY_MAP_KEYS) {
        if (before[key] === after[key]) continue;
        for (const id of new Set([...Object.keys(before[key]), ...Object.keys(after[key])])) {
          const folder = after[key][id] ?? "";
          if ((before[key][id] ?? "") === folder) continue;
          const summary = pending.get(id)?.summary ?? summaries.get(id);
          if (!summary || deleted.has(id)) continue;
          patch.directoryMoves.push({ id, expectedRevision: summary.revision, folder });
        }
      }
      if (!patch.createdFolders.length && !patch.deletedFolders.length && !patch.directoryMoves.length) return;
    }
    const promise = input.coordinator.submit({ command: "commit_project_records", payload: patch,
      documentRevisions: [
        ...(patch.directoryMoves ?? []).map((movement) => ({ id: movement.id, revision: movement.expectedRevision })),
        ...(patch.deletedDocumentIds ?? []).flatMap((id) => {
          const summary = pending.get(id)?.summary ?? summaries.get(id);
          return summary ? [{ id, revision: summary.revision }] : [];
        }),
      ] });
    const sequence = input.coordinator.snapshot().pendingSequence;
    if(mutation.kind==="directory") {
      const before=new Set(mutation.before.folders),after=new Set(mutation.after.folders);
      for(const path of new Set([...before,...after])) if(before.has(path)!==after.has(path)) pendingFolders.set(path,{sequence,present:after.has(path)});
    }
    for(const setting of patch.settings??[]) pendingSettings.set(setting.key,sequence);
    for (const id of patch.deletedDocumentIds ?? []) { deleted.add(id); deletes.set(id, sequence); }
    for (const movement of patch.directoryMoves ?? []) {
      const summary = pending.get(movement.id)?.summary ?? summaries.get(movement.id)!;
      pending.set(movement.id, { sequence, summary: { ...summary, folder: movement.folder } });
    }
    void promise.catch(() => undefined);
  }
  const adapter: ProjectDocumentAdapters = {
    activate() {
      if (activeAdapters) throw new Error("A project document persistence session is already active");
      const release = installDocumentMutationSink((kind, before, after) => {
        const old = new Map(before.map((item) => [item.id, item]));
        const next = new Set(after.map((item) => item.id));
        for (const item of after) {
          const previous=old.get(item.id);
          if (previous===item) continue;
          if(previous&&deleted.has(item.id)) throw new Error("project_document_deleted");
          const beforeRecord=previous as unknown as Record<string,unknown>|undefined;
          const afterRecord=item as unknown as Record<string,unknown>;
          const changedKeys=previous?[...new Set([...Object.keys(beforeRecord!),...Object.keys(afterRecord)])].filter((key)=>!Object.is(beforeRecord![key],afterRecord[key])):null;
          if (changedKeys?.length===0) continue;
          const summary=pending.get(item.id)?.summary ?? summaries.get(item.id);
          if (summary && changedKeys?.length===1 && changedKeys[0]==="name") void renameMetadata(summary,item.name).catch(()=>undefined);
          else enqueue(kind,item,!previous&&deleted.has(item.id)?null:undefined);
        }
        const removed = before.filter((item) => !next.has(item.id));
        if (removed.length) {
          const promise = input.coordinator.submit({ command: "commit_project_records", payload: { deletedDocumentIds: removed.map((item) => item.id) },
            documentRevisions: removed.flatMap((item) => { const summary = summaries.get(item.id); return summary ? [{ id: item.id, revision: summary.revision }] : []; }) });
          const sequence = input.coordinator.snapshot().pendingSequence;
          for (const item of removed) { deleted.add(item.id); deletes.set(item.id, sequence); }
          void promise.catch(() => undefined);
        }
      });
      let releaseRecords: () => void;
      try { releaseRecords = installProjectRecordMutationSink(persistRecords); }
      catch (error) { release(); throw error; }
      let releaseNames: () => void;
      try { releaseNames = installDocumentNameInventory(kinds => adapter.directorySummaries().filter(item => kinds.includes(item.kind as PersistedDocumentKind)).map(item => item.name)); }
      catch(error) { release(); releaseRecords(); throw error; }
      activeAdapters = { epoch, adapter };
      adapter.projectFolders();
      return () => { releaseNames(); release(); releaseRecords(); if (activeAdapters?.adapter === adapter) activeAdapters = null; };
    },
    projectFolders() {
      if(activeAdapters?.adapter!==adapter) return;
      const records=adapter.directorySummaries();
      const maps=Object.fromEntries(DIRECTORY_MAP_KEYS.map(key=>[key,{}])) as Record<typeof DIRECTORY_MAP_KEYS[number],Record<string,string>>;
      const paths=new Set(records.filter(item=>item.kind==="folder").map(item=>item.id.slice("folder:".length)));
      for(const item of records) {
        const key=item.kind==="table"?"tableFolders":item.kind==="graph"?"graphFolders":item.kind==="graphNew"?"graphNewFolders":item.kind==="report"?"reportFolders":item.kind==="analysis"?"analysisFolders":item.kind==="tabulate"?"tabulateFolders":null;
        if(key&&item.folder) {maps[key][item.id]=item.folder;for(const path of folderAncestors(item.folder)) paths.add(path);}
      }
      for(const [path,change] of pendingFolders) if(change.sequence>input.coordinator.snapshot().acknowledgedSequence) {if(change.present) paths.add(path);else paths.delete(path);}
      withoutDocumentPersistence(()=>useFolderStore.setState({...maps,folders:[...paths].sort((a,b)=>a.localeCompare(b))}));
    },
    getSummary(id) { return deleted.has(id) ? undefined : summaries.get(id); },
    hasSelectableBody(id) {
      const change=pending.get(id);const summary=change?.summary??summaries.get(id);
      return !!summary&&!deleted.has(id)&&!!currentDocument(summary.kind,id)
        &&((change?.sequence??0)>input.coordinator.snapshot().acknowledgedSequence||bodyRevisions.get(id)===summary.revision);
    },
    directorySummaries() {
      const result=new Map(summaries);
      for(const [id,change] of pending) result.set(id,change.summary);
      for(const id of deleted) result.delete(id);
      return [...result.values()];
    },
    async renameDirectoryDocument(id,name) {
      if(activeAdapters?.adapter!==adapter) throw new Error("project_session_stale");
      assertProjectMutable(useProjectStore.getState().readOnly);
      const summary=pending.get(id)?.summary??summaries.get(id);
      if(!summary||deleted.has(id)) throw new Error("project_document_deleted");
      if(summary.kind==="folder"||summary.kind==="snapshot") throw new Error("project_record_requires_typed_operation");
      projectDirectoryName(summary.kind,id,name);
      await renameMetadata(summary,name);
    },
    async deleteDirectoryDocument(id) {
      if(activeAdapters?.adapter!==adapter) throw new Error("project_session_stale");
      assertProjectMutable(useProjectStore.getState().readOnly);
      const summary=pending.get(id)?.summary??summaries.get(id);
      if(!summary||deleted.has(id)) throw new Error("project_document_deleted");
      if(!["graph","graphNew","report","analysis","tabulate"].includes(summary.kind)) throw new Error("project_record_requires_typed_operation");
      const result=input.coordinator.submit({command:"commit_project_records",payload:{deletedDocumentIds:[id]} satisfies ProjectRecordPatch,documentRevisions:[{id,revision:summary.revision}]});
      deleted.add(id);deletes.set(id,input.coordinator.snapshot().pendingSequence);
      await result;
      if(activeAdapters?.adapter===adapter&&(pending.get(id)?.sequence??0)<=input.coordinator.snapshot().acknowledgedSequence) projectDirectoryDeletion(summary.kind,id);
    },
    reconcileDirectory(items,committedRevision) {
      const present=new Set(items.map(item=>item.id));
      const acknowledged=input.coordinator.snapshot().acknowledgedSequence;
      for(const id of summaries.keys()) {
        if(present.has(id)||(metadataRevisions.get(id)??0)>committedRevision) continue;
        summaries.delete(id);metadataRevisions.set(id,committedRevision);committedDeletes.set(id,committedRevision);
        if((pending.get(id)?.sequence??0)<=acknowledged) {pending.delete(id);deleted.add(id);}
      }
    },
    registerSummary(summary, committedRevision) {
      if(committedRevision!==undefined&&(metadataRevisions.get(summary.id)??0)>committedRevision) return;
      if(summary.revision<(summaries.get(summary.id)?.revision??0)) return;
      if(committedRevision!==undefined&&committedRevision>(committedDeletes.get(summary.id)??Infinity)) {committedDeletes.delete(summary.id);bodyRevisions.delete(summary.id);}
      summaries.set(summary.id,structuredClone(summary));
      if(committedRevision!==undefined) metadataRevisions.set(summary.id,committedRevision);
      if((deletes.get(summary.id)??0)<=input.coordinator.snapshot().acknowledgedSequence) deleted.delete(summary.id);
    },
    hydrate(document) {
      const id = document.summary.id;
      if (deleted.has(id) || (pending.get(id)?.sequence ?? 0) > input.coordinator.snapshot().acknowledgedSequence) return false;
      const existing = summaries.get(id);
      if (existing && existing.revision !== document.summary.revision) return false;
      summaries.set(id, structuredClone(document.summary));
      bodyRevisions.set(id,document.summary.revision);
      withoutDocumentPersistence(() => {
        switch (document.summary.kind) {
          case "report": useReportStore.setState((state) => ({
            items: replaceById(state.items, document.body as ReportItem),
            documentRevisions: { ...state.documentRevisions, [id]: document.summary.revision },
            counter: Math.max(state.counter, createNamedDocumentHelpers("Report").maxSuffix([document.summary])),
          })); break;
          case "graph": useGraphBuilderStore.setState((state) => ({
            items: replaceById(state.items, normalizeStoredGraphBuilderItem(document.body as GraphBuilderItem)),
            documentRevisions: { ...state.documentRevisions, [id]: document.summary.revision },
            counter: Math.max(state.counter, Number(/^图表(\d+)$/.exec(document.summary.name)?.[1] ?? 0)),
          })); break;
          case "graphNew": useGraphBuilderNewStore.setState((state) => ({
            items: replaceById(state.items, normalizeGraphNewDocument(document.body as PersistedGraphBuilderNewDocument)),
          })); break;
          case "analysis": useAnalysisStore.setState((state) => ({
            items: replaceById(state.items, normalizePersistedAnalysisDocument(document.body as AnalysisDocument)),
            counter: Math.max(state.counter, createNamedDocumentHelpers("Analysis").maxSuffix([document.summary])),
          })); break;
          case "tabulate": useTabulateStore.setState((state) => ({
            items: replaceById(state.items, document.body as TabulateItem),
            counter: Math.max(state.counter, createNamedDocumentHelpers("Tabulate").maxSuffix([document.summary])),
          })); break;
          case "workflow": useWorkflowStore.setState({ workflows: replaceById(useWorkflowStore.getState().workflows, document.body as WorkflowDefinition) }); break;
          case "transform": useTableTransformStore.setState({ definitions: replaceById(useTableTransformStore.getState().definitions, document.body as TableTransformDefinition) }); break;
          default: throw new Error("This record requires its typed loader");
        }
      });
      return true;
    },
    hydrateSetting(key,record) {
      if((pendingSettings.get(key)??0)>input.coordinator.snapshot().acknowledgedSequence) return false;
      if(record&&record.key!==key) throw new Error("project_setting_invalid");
      if((record?.revision??0)<(settingRevisions.get(key)??0)) return false;
      const apply=prepareProjectSettingProjection(key,record?.value??null);
      withoutDocumentPersistence(apply);
      if(record) settingRevisions.set(key,record.revision);else settingRevisions.delete(key);
      return true;
    },
    applyCommit(commit, source) {
      if (commit.epoch !== epoch) return;
      const acknowledged = input.coordinator.snapshot().acknowledgedSequence;
      if (commit.changedDatasetGenerations.length||commit.changedDatasetMetadata?.length) {
        const generations = new Map(commit.changedDatasetGenerations.filter(item => Number.isSafeInteger(item.generation) && item.generation >= 0).map(item => [item.id,item.generation]));
        const headers=new Map((commit.changedDatasetMetadata??[]).filter(item=>typeof item.id==="string"&&item.id.length>0&&typeof item.name==="string"&&Number.isSafeInteger(item.generation)&&item.generation>=0&&Number.isSafeInteger(item.rowCount)&&item.rowCount>=0&&Number.isSafeInteger(item.colCount)&&item.colCount>=0).map(item=>[item.id,item]));
        const projected=new Set<string>();
        withoutDocumentPersistence(() => useDataStore.setState(state => ({datasets:[...state.datasets.map(dataset => {
          if((metadataRevisions.get(dataset.id)??0)>commit.committedRevision) return dataset;
          const header=headers.get(dataset.id);
          if(header&&header.generation>=dataset.generation) {
            projected.add(dataset.id);const draft=pending.get(dataset.id);
            const next={...dataset,...header,...(draft&&draft.sequence>acknowledged?{name:draft.summary.name}:{})};
            return (Object.keys(header) as Array<keyof typeof header>).every(key=>Object.is(dataset[key],next[key]))?dataset:next;
          }
          const generation = generations.get(dataset.id);
          return generation !== undefined && generation > dataset.generation ? {...dataset,generation} : dataset;
        }),...([...headers.values()].filter(header=>commit.changedDirectoryEntries?.some(entry=>entry.id===header.id&&entry.kind==="table")
          &&!state.datasets.some(dataset=>dataset.id===header.id)
          &&(metadataRevisions.get(header.id)??0)<=commit.committedRevision
          &&(committedDeletes.get(header.id)??-1)<commit.committedRevision).map(header=>{
            projected.add(header.id);const draft=pending.get(header.id);
            return {...header,...(draft&&draft.sequence>acknowledged?{name:draft.summary.name}:{})};
          }))]})));
        for(const id of projected) metadataRevisions.set(id,commit.committedRevision);
      }
      const snapshotRestore=commit.value as {kind?:unknown;snapshotId?:unknown;tableHistoryReset?:unknown}|null;
      if(snapshotRestore?.kind==="dataSnapshotRestored"&&snapshotRestore.tableHistoryReset===true
        &&typeof snapshotRestore.snapshotId==="string"&&commit.committedRevision>tableHistoryFloor) {
        tableHistoryFloor=commit.committedRevision;
        useHistoryStore.getState().reset();useHistoryStore.getState().invalidateData();
      }
      if(commit.committedRevision>tableHistoryFloor)for (const entry of commit.changedHistoryEntries ?? []) useHistoryStore.getState().recordCommittedTableMutation(entry);
      const lifecycleRemovals=new Set(commit.committedRevision>tableHistoryFloor
        ? (commit.changedHistoryEntries??[]).filter(entry=>(entry.operation==="delete_table"&&entry.applied)||(entry.operation==="create_table"&&!entry.applied)).map(entry=>entry.datasetId) : []);
      for (const id of commit.deletedDirectoryIds ?? []) {
        if((metadataRevisions.get(id)??0)>commit.committedRevision) continue;
        metadataRevisions.set(id,commit.committedRevision);committedDeletes.set(id,commit.committedRevision);
        const removed=summaries.get(id);
        summaries.delete(id);
        if((pending.get(id)?.sequence??0)<=acknowledged) {
          deleted.add(id);bodyRevisions.delete(id);
          if(removed) projectDirectoryDeletion(removed.kind,id,lifecycleRemovals.has(id));
        }
      }
      for (const summary of commit.changedDirectoryEntries ?? []) {
        if((metadataRevisions.get(summary.id)??0)>commit.committedRevision||summary.revision<(summaries.get(summary.id)?.revision??0)) continue;
        metadataRevisions.set(summary.id,commit.committedRevision);
        if(commit.committedRevision>(committedDeletes.get(summary.id)??Infinity)) {committedDeletes.delete(summary.id);bodyRevisions.delete(summary.id);}
        summaries.set(summary.id,structuredClone(summary));deleted.delete(summary.id);
      }
      if(source?.own) for (const setting of commit.changedSettingRevisions ?? []) settingRevisions.set(setting.key,Math.max(setting.revision,settingRevisions.get(setting.key)??0));
      for (const record of commit.changedFilterSettings ?? []) {
        if(record.key.startsWith("filter:") && commit.changedSettingRevisions?.some(setting=>setting.key===record.key&&setting.revision===record.revision)) adapter.hydrateSetting(record.key,record);
      }
      for (const changed of commit.changedDocumentRevisions) {
        if(commit.committedRevision<=(committedDeletes.get(changed.id)??-1)) continue;
        let current = summaries.get(changed.id) ?? pending.get(changed.id)?.summary;
        const written=source?.own&&source.operation?.command==="commit_project_records"
          ? (source.operation.payload as ProjectRecordPatch).documents?.find(write=>write.document.summary.id===changed.id)?.document.summary : undefined;
        if(written&&(!current||current.revision<=changed.revision)&&!commit.changedDirectoryEntries?.some(summary=>summary.id===changed.id)) current=written;
        if (current&&!deleted.has(changed.id)) {
          summaries.set(changed.id, { ...current, revision: Math.max(current.revision,changed.revision) });
          if(source?.own&&(bodyRevisions.has(changed.id)||written||["create_table_transform","run_workflow"].includes(source.operation?.command??""))&&changed.revision>=(bodyRevisions.get(changed.id)??0)) {
            bodyRevisions.set(changed.id,changed.revision);
            if (current.kind === "report") useReportStore.getState().setDocumentRevision(changed.id, changed.revision);
            if (current.kind === "graph") useGraphBuilderStore.getState().setDocumentRevision(changed.id, changed.revision);
          }
        }
      }
      for (const [id, change] of pending) if (change.sequence <= acknowledged) pending.delete(id);
      for(const [key,sequence] of pendingSettings) if(sequence<=acknowledged) pendingSettings.delete(key);
      for (const [id, sequence] of deletes) if (sequence <= acknowledged) { summaries.delete(id);bodyRevisions.delete(id);deletes.delete(id); }
      for(const [path,change] of pendingFolders) if(change.sequence<=acknowledged) pendingFolders.delete(path);
      adapter.projectFolders();
    },
    async persist(kind, id, expectedRevision) {
      const item = currentDocument(kind, id);
      if (!item || kind === "table" || kind === "folder" || kind === "snapshot") throw new Error("Document body is not loaded");
      await input.coordinator.flushThrough(enqueue(kind, item, expectedRevision === 0 ? null : expectedRevision));
    },
  };
  return adapter;
}

export function applyCommittedProjectEffects(commit: ProjectCommit<unknown>, source?: ProjectCommitSource): void { activeAdapters?.adapter.applyCommit(commit,source); }
export function persistDocumentChange(kind: ProjectDocumentKind, id: string, expectedRevision: number): Promise<void> {
  if (!activeAdapters) return Promise.reject(new Error("No persistent project is active"));
  return activeAdapters.adapter.persist(kind, id, expectedRevision);
}
export function hydrateProjectDocument(document: ProjectDocumentBody, expectedEpoch?: number): boolean {
  if (!activeAdapters || (expectedEpoch !== undefined && activeAdapters.epoch !== expectedEpoch)) return false;
  return activeAdapters.adapter.hydrate(document);
}
export function registerProjectDocumentSummaries(summaries: readonly ProjectDocumentSummary[], expectedEpoch: number, committedRevision?: number, complete=false): void {
  if(!activeAdapters||activeAdapters.epoch!==expectedEpoch) return;
  if(complete) {
    if(committedRevision===undefined) throw new Error("project_catalog_revision_required");
    activeAdapters.adapter.reconcileDirectory(summaries,committedRevision);
  }
  for(const summary of summaries) activeAdapters.adapter.registerSummary(summary,committedRevision);
  activeAdapters.adapter.projectFolders();
}

export function getProjectDirectorySummaries(expectedEpoch:number):ProjectDocumentSummary[]|null {
  return activeAdapters?.epoch===expectedEpoch?activeAdapters.adapter.directorySummaries():null;
}

export function renameProjectDirectoryDocument(id:string,name:string,expectedEpoch?:number):Promise<void> {
  if(!activeAdapters) return Promise.reject(new Error("No persistent project is active"));
  if(expectedEpoch!==undefined&&activeAdapters.epoch!==expectedEpoch) return Promise.reject(new Error("project_session_stale"));
  return activeAdapters.adapter.renameDirectoryDocument(id,name);
}
export function deleteProjectDirectoryDocument(id:string,expectedEpoch?:number):Promise<void> {
  if(!activeAdapters) return Promise.reject(new Error("No persistent project is active"));
  if(expectedEpoch!==undefined&&activeAdapters.epoch!==expectedEpoch) return Promise.reject(new Error("project_session_stale"));
  return activeAdapters.adapter.deleteDirectoryDocument(id);
}

export function hasProjectDocumentBody(id:string,expectedEpoch:number):boolean {
  return activeAdapters?.epoch===expectedEpoch&&activeAdapters.adapter.hasSelectableBody(id);
}

export function hydrateProjectSetting(key:string,record:ProjectSettingRecord|null,expectedEpoch:number):boolean {
  return activeAdapters?.epoch===expectedEpoch&&activeAdapters.adapter.hydrateSetting(key,record);
}
