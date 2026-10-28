import type {
  DatasetGeneration, DocumentRevision, DocumentWrite, ProjectCommit,
  ProjectRecordPatch, ProjectWriteContext, ProjectOperationResolution,
} from "../types/projectPersistence";

export type ProjectMutationCommand =
  | "capture_project_data_snapshot" | "restore_project_data_snapshot" | "delete_project_data_snapshot"
  | "commit_project_records" | "update_cells" | "clear_cells" | "add_rows"
  | "delete_rows_with_change_set" | "add_columns_with_change_set"
  | "delete_columns_with_change_set" | "alter_column_with_change_set"
  | "alter_columns_type_with_change_set" | "paste_at_position_with_change_set"
  | "apply_project_table_lifecycle"
  | "apply_table_change_set" | "drop_table_change_set" | "rename_dataset"
  | "reorder_column_if_generation" | "set_column_display_props"
  | "create_managed_table" | "create_table_from_rows" | "create_table_from_sql_query"
  | "import_file" | "import_table" | "import_selected_sqlite" | "import_server_snapshot" | "import_postgres_snapshot"
  | "create_table_transform" | "run_table_transform" | "rebind_table_transform"
  | "run_workflow" | "upsert_calculated_column" | "convert_calculated_column_to_values"
  | "materialize_tabulate_table" | "save_fit_model_columns" | "delete_dataset";

export interface ProjectOperation<T = unknown> {
  command: ProjectMutationCommand;
  payload: unknown;
  datasetGenerations?: DatasetGeneration[];
  documentRevisions?: DocumentRevision[];
  requestDigest?: string;
  /** Compile-time result association; never serialized. */
  readonly resultType?: T;
}
export interface PersistenceSnapshot {
  epoch: number;
  pendingSequence: number;
  acknowledgedSequence: number;
  committedRevision: number;
  status: "pending" | "saving" | "saved" | "error";
  error: string | null;
  canResolveFailedOperation?:boolean;
}
export interface ProjectCommitSource { own: boolean; sequence?: number; operation?: ProjectOperation<unknown> }
export interface PersistenceDependencies {
  projectId: string;
  epoch: number;
  committedRevision: number;
  writable?: boolean;
  now: () => number;
  newOperationId: () => string;
  setTimer: (run: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  transport: <T>(operation: ProjectOperation<T>, context: ProjectWriteContext) => Promise<ProjectCommit<T>>;
  subscribeCommits?: (receive: (commit: ProjectCommit<unknown>) => void) => () => void;
  checkpoint?: (epoch:number,revision:number)=>Promise<void>;
  resolveOperation?:(context:ProjectWriteContext)=>Promise<ProjectOperationResolution>;
  onCheckpointError?: (error:unknown)=>void;
  onChange?: (snapshot: PersistenceSnapshot) => void;
  onCommit?: (commit: ProjectCommit<unknown>, source: ProjectCommitSource) => void;
}
export interface ProjectPersistenceCoordinator {
  enqueueDocument(write: DocumentWrite): number;
  submit<T>(operation: ProjectOperation<T>): Promise<ProjectCommit<T>>;
  captureBarrier(): number;
  flushThrough(sequence: number): Promise<void>;
  snapshot(): PersistenceSnapshot;
  suspendWrites(): () => void;
  resolveFailedOperation():Promise<void>;
  close(): Promise<void>;
}
interface Entry {
  first: number;
  last: number;
  readyAt: number;
  operation: ProjectOperation<unknown>;
  documents?: Map<string, DocumentWrite>;
  context?: ProjectWriteContext;
  resolve?: (commit: ProjectCommit<unknown>) => void;
  reject?: (error: Error) => void;
}
const COALESCE_MS = 250;

export function createProjectPersistenceCoordinator(deps: PersistenceDependencies): ProjectPersistenceCoordinator {
  if (!deps.projectId || !Number.isSafeInteger(deps.epoch) || !Number.isSafeInteger(deps.committedRevision)) {
    throw new Error("invalid persistence session");
  }
  const entries: Entry[] = [];
  const waiters: Array<{ sequence: number; resolve: () => void; reject: (error: Error) => void }> = [];
  const ownDocuments = new Map<string, number>();
  const ownDeletedDocuments = new Set<string>();
  const ownSettings = new Map<string, number>();
  const ownDatasets = new Map<string, number>();
  let sequence = 0;
  let acknowledged = 0;
  let revision = deps.committedRevision;
  let receivedThrough=deps.committedRevision;
  const receivedRanges:Array<[number,number]>=[];
  function markReceived(revision:number):boolean {
    if(revision<=receivedThrough) return false;
    let index=0;
    while(index<receivedRanges.length&&receivedRanges[index][1]<revision-1) index++;
    if(index<receivedRanges.length&&receivedRanges[index][0]<=revision&&receivedRanges[index][1]>=revision) return false;
    let start=revision,end=revision;
    while(index<receivedRanges.length&&receivedRanges[index][0]<=end+1) {
      const range=receivedRanges.splice(index,1)[0];start=Math.min(start,range[0]);end=Math.max(end,range[1]);
    }
    receivedRanges.splice(index,0,[start,end]);
    while(receivedRanges[0]?.[0]===receivedThrough+1) receivedThrough=receivedRanges.shift()![1];
    return true;
  }
  let error: Error | null = null;
  let externalProjectionError:Error|null=null;
  const externalProjections:ProjectCommit<unknown>[]=[];
  let active: Entry | null = null;
  let recordRecovery: Promise<void> | null = null;
  let unsealed: Entry | null = null;
  let timer: { id: unknown } | null = null;
  let idleTimer:{id:unknown}|null=null;
  let checkpointInFlight:Promise<void>|null=null;
  let checkpointDirty=false;
  let closed = false;
  let closing = false;
  let writeSuspensions=0;

  function snapshot(): PersistenceSnapshot {
    return { epoch: deps.epoch, pendingSequence: sequence, acknowledgedSequence: acknowledged,
      committedRevision: revision, status: error||externalProjectionError ? "error" : active ? "saving" : entries.length ? "pending" : "saved",
      error: (error??externalProjectionError)?.message ?? null,canResolveFailedOperation:!externalProjectionError&&!!error&&!active&&!!deps.resolveOperation&&!!entries[0]?.context&&entries[0].operation.command!=="commit_project_records" };
  }
  function notify() { deps.onChange?.(snapshot()); }
  function clearTimer() { if (timer) { deps.clearTimer(timer.id); timer = null; } }
  function clearIdleTimer() {if(idleTimer) {deps.clearTimer(idleTimer.id);idleTimer=null;}}
  function scheduleCheckpoint() {
    clearIdleTimer();
    if(!deps.checkpoint||!checkpointDirty||closed||closing||writeSuspensions>0||deps.writable===false||entries.length||error||externalProjectionError) return;
    idleTimer={id:deps.setTimer(()=>{
      idleTimer=null;
      if(closed||closing||writeSuspensions>0||entries.length||error||externalProjectionError||checkpointInFlight) return;
      const target=revision;let completed=false;
      checkpointInFlight=Promise.resolve().then(()=>deps.checkpoint!(deps.epoch,target)).then(()=>{
        completed=true;if(revision===target) checkpointDirty=false;
      }).catch(reason=>{deps.onCheckpointError?.(reason);}).finally(()=>{
        checkpointInFlight=null;
        if(completed&&checkpointDirty) scheduleCheckpoint();
      });
    },5000)};
  }
  function assertOpen(requireWritable = false) {
    if (closed || closing) throw new Error("persistence coordinator is closed");
    if (requireWritable && deps.writable === false) throw new Error("project is read only");
    if(requireWritable&&writeSuspensions>0) throw new Error("project transition in progress");
  }
  function seal() {
    if (unsealed) { unsealed.readyAt = 0; unsealed = null; }
    clearTimer();
  }
  function fail(entry: Entry, reason: unknown) {
    if (entries[0] !== entry) return;
    active = null;
    error = reason instanceof Error ? reason : new Error(String(reason));
    entry.reject?.(error);
    entry.reject = undefined;
    entry.resolve = undefined;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
    notify();
  }
  function accept(entry: Entry, commit: ProjectCommit<unknown>) {
    if (entries[0] !== entry || !entry.context) return;
    if (commit.epoch !== deps.epoch || commit.operationId !== entry.context.operationId
      || !Number.isSafeInteger(commit.committedRevision)
      || commit.committedRevision <= entry.context.expectedRevision) {
      fail(entry, new Error("stale or invalid persistence acknowledgement"));
      return;
    }
    const previousAcknowledged=acknowledged;
    acknowledged = entry.last;
    checkpointDirty=true;
    revision = Math.max(revision, commit.committedRevision);
    error = null;
    if (entry.operation.command === "commit_project_records") {
      const patch = entry.operation.payload as ProjectRecordPatch;
      for (const id of patch.deletedDocumentIds ?? []) { ownDocuments.delete(id); ownDeletedDocuments.add(id); }
    }
    for (const document of commit.changedDocumentRevisions) {
      ownDocuments.set(document.id, document.revision);
      ownDeletedDocuments.delete(document.id);
    }
    for (const setting of commit.changedSettingRevisions ?? []) ownSettings.set(setting.key, setting.revision);
    for (const dataset of commit.changedDatasetGenerations) ownDatasets.set(dataset.id, dataset.generation);
    try { deps.onCommit?.(commit, { own: true, sequence: entry.last, operation: entry.operation }); }
    catch(reason) {
      acknowledged=previousAcknowledged;
      fail(entry,reason);
      return;
    }
    markReceived(commit.committedRevision);
    entries.shift();
    if(active===entry) active=null;
    if(unsealed===entry) unsealed=null;
    entry.resolve?.(commit);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].sequence <= acknowledged) { waiters.splice(i, 1)[0].resolve(); }
    }
    notify();
    scheduleCheckpoint();
    void Promise.resolve().then(() => pump());
  }
  function drainExternalProjections():boolean {
    while(externalProjections.length) {
      try {deps.onCommit?.(externalProjections[0],{own:false});}
      catch(reason) {externalProjectionError=reason instanceof Error?reason:new Error(String(reason));return false;}
      externalProjections.shift();
    }
    externalProjectionError=null;
    return true;
  }
  function receive(commit: ProjectCommit<unknown>) {
    if (closed || commit.epoch !== deps.epoch || !Number.isSafeInteger(commit.committedRevision)) return;
    const head = entries[0];
    if (head?.context?.operationId === commit.operationId) { accept(head, commit); return; }
    if (!markReceived(commit.committedRevision)) return;
    if(commit.committedRevision>revision) checkpointDirty=true;
    revision = Math.max(revision, commit.committedRevision);
    clearIdleTimer();externalProjections.push(commit);
    const projected=drainExternalProjections();notify();
    if(projected) {scheduleCheckpoint();pump();}
  }
  function pump() {
    if (closed || active || error || externalProjectionError) return;
    clearTimer();
    const entry = entries[0];
    if (!entry) return;
    if (entry.readyAt > deps.now()) {
      timer = { id: deps.setTimer(() => { timer = null; pump(); }, entry.readyAt - deps.now()) };
      return;
    }
    if (unsealed === entry) unsealed = null;
    if (!entry.context) {
      if (entry.documents) {
        const documents = [...entry.documents.values()].map((write) => {
          const previous = ownDocuments.get(write.document.summary.id);
          const expectedRevision = ownDeletedDocuments.has(write.document.summary.id) ? null
            : previous === undefined ? write.expectedRevision : Math.max(previous, write.expectedRevision ?? 0);
          return { ...write, expectedRevision, document: { ...write.document,
            summary: { ...write.document.summary, revision: (expectedRevision ?? 0) + 1 } } };
        });
        entry.operation = { command: "commit_project_records", payload: { documents } satisfies ProjectRecordPatch,
          documentRevisions: documents.flatMap((write) => write.expectedRevision === null ? [] : [{ id: write.document.summary.id, revision: write.expectedRevision }]) };
      }
      if (entry.operation.command === "commit_project_records") {
        const patch = entry.operation.payload as ProjectRecordPatch;
        entry.operation = { ...entry.operation, payload: {
          ...patch,
          settings: patch.settings?.map((setting) => ({ ...setting,
            expectedRevision: ownSettings.has(setting.key) ? Math.max(setting.expectedRevision ?? 0, ownSettings.get(setting.key)!) : setting.expectedRevision })),
          directoryMoves: patch.directoryMoves?.map((movement) => ({ ...movement,
            expectedRevision: Math.max(movement.expectedRevision, ownDocuments.get(movement.id) ?? movement.expectedRevision) })),
        } satisfies ProjectRecordPatch };
      }
      if (entry.operation.payload && typeof entry.operation.payload === "object" && !Array.isArray(entry.operation.payload)) {
        const payload = entry.operation.payload as Record<string, unknown>;
        if (typeof payload.datasetId === "string" && typeof payload.expectedGeneration === "number") {
          const acknowledgedGeneration = ownDatasets.get(payload.datasetId);
          if (acknowledgedGeneration !== undefined) entry.operation = { ...entry.operation, payload: {
            ...payload, expectedGeneration: Math.max(payload.expectedGeneration, acknowledgedGeneration),
          } };
        }
        if(entry.operation.command==="upsert_calculated_column" && payload.request && typeof payload.request==="object" && !Array.isArray(payload.request)) {
          const request=payload.request as Record<string,unknown>;
          const acknowledgedGeneration=typeof request.datasetId==="string"?ownDatasets.get(request.datasetId):undefined;
          if(acknowledgedGeneration!==undefined) entry.operation={...entry.operation,payload:{...payload,request:{...request,expectedGeneration:Math.max(typeof request.expectedGeneration==="number"?request.expectedGeneration:0,acknowledgedGeneration)}}};
        }
      }
      entry.context = {
        operationId: deps.newOperationId(), expectedProjectId: deps.projectId,
        expectedEpoch: deps.epoch, expectedRevision: revision,
        requestDigest: entry.operation.requestDigest ?? "",
        documentRevisions: entry.operation.documentRevisions?.map((document) => ({ ...document,
          revision: Math.max(document.revision, ownDocuments.get(document.id) ?? document.revision) })),
        datasetGenerations: entry.operation.datasetGenerations?.map((dataset) => ({ ...dataset,
          generation: Math.max(dataset.generation, ownDatasets.get(dataset.id) ?? dataset.generation) })),
      };
    }
    active = entry;
    notify();
    try {
      void deps.transport(entry.operation, entry.context).then((commit) => accept(entry, commit), (reason) => fail(entry, reason));
    } catch (reason) { fail(entry, reason); }
  }
  function flushPending(through:number):Promise<void> {
      if (!Number.isSafeInteger(through) || through < 0 || through > sequence) return Promise.reject(new Error("invalid persistence barrier"));
      if(externalProjections.length) {
        const projected=drainExternalProjections();notify();
        if(!projected) return Promise.reject(externalProjectionError);
        scheduleCheckpoint();
      }
      if (through <= acknowledged) return Promise.resolve();
      if (unsealed && unsealed.first <= through) seal();
      for (const entry of entries) if (entry.first <= through) entry.readyAt = 0;
      error = null;
      const promise = new Promise<void>((resolve, reject) => waiters.push({ sequence: through, resolve, reject }));
      pump();
      return promise;
  }

  async function recoverFailedRecord(entry:Entry):Promise<void> {
    const context=entry.context!;
    active=entry;notify();
    try {
      let resolution:ProjectOperationResolution;
      try { resolution=await deps.resolveOperation!(structuredClone(context)); }
      catch {
        // An unavailable resolver permits only replay of the unchanged identity.
        if(entries[0]===entry) {active=null;error=null;notify();}
        return;
      }
      if(entries[0]!==entry)return;
      if(resolution.status==="committed") {
        accept(entry,resolution.commit);
        if(error)throw error;
        return;
      }
      if(resolution.status!=="cancelled"||resolution.operationId!==context.operationId||resolution.epoch!==deps.epoch
        ||!Number.isSafeInteger(resolution.committedRevision)||resolution.committedRevision<context.expectedRevision) {
        throw new Error("Invalid operation resolution");
      }
      // The backend has fenced the old identity. Retain every draft and its
      // document/setting revision; only the project-wide precondition refreshes.
      revision=Math.max(revision,resolution.committedRevision);
      entry.context=undefined;entry.readyAt=0;active=null;error=null;notify();
    } catch(reason) {
      if(entries[0]===entry)fail(entry,reason);
      throw reason;
    }
  }
  const unsubscribe = deps.subscribeCommits?.(receive);
  const coordinator: ProjectPersistenceCoordinator = {
    enqueueDocument(write) {
      assertOpen(true);
      clearIdleTimer();
      const next = ++sequence;
      if (!unsealed) {
        unsealed = { first: next, last: next, readyAt: deps.now() + COALESCE_MS,
          operation: { command: "commit_project_records", payload: {} }, documents: new Map() };
        entries.push(unsealed);
      }
      const copied = structuredClone(write);
      const first = unsealed.documents!.get(copied.document.summary.id);
      if (first) copied.expectedRevision = first.expectedRevision;
      unsealed.documents!.set(copied.document.summary.id, copied);
      unsealed.last = next;
      notify();
      pump();
      return next;
    },
    submit<T>(operation: ProjectOperation<T>) {
      assertOpen(true);
      clearIdleTimer();
      seal();
      const next = ++sequence;
      const promise = new Promise<ProjectCommit<T>>((resolve, reject) => {
        entries.push({ first: next, last: next, readyAt: 0, operation: structuredClone(operation),
          resolve: (commit) => resolve(commit as ProjectCommit<T>), reject });
      });
      notify();
      pump();
      return promise;
    },
    captureBarrier() { assertOpen(); seal(); return sequence; },
    flushThrough(through) {
      if (!Number.isSafeInteger(through) || through < 0 || through > sequence) return Promise.reject(new Error("invalid persistence barrier"));
      const entry=entries[0];
      if(!recordRecovery&&error&&!externalProjectionError&&!active&&deps.resolveOperation&&entry?.context&&entry.first<=through&&entry.operation.command==="commit_project_records") {
        recordRecovery=recoverFailedRecord(entry).finally(()=>{recordRecovery=null;});
      }
      return recordRecovery?recordRecovery.then(()=>flushPending(through)):flushPending(through);
    },
    snapshot,
    async resolveFailedOperation() {
      assertOpen(true);
      const entry=entries[0];
      if(!error||active||!entry?.context||!deps.resolveOperation) throw new Error("No failed operation can be resolved");
      if(entry.operation.command==="commit_project_records") throw new Error("Document conflicts require repairing the retained draft");
      active=entry;notify();
      try {
        const resolution=await deps.resolveOperation(structuredClone(entry.context));
        if(entries[0]!==entry) return;
        if(resolution.status==="committed") {
          accept(entry,resolution.commit);
          if(error) throw error;
          return;
        }
        if(resolution.status!=="cancelled"||resolution.operationId!==entry.context.operationId||resolution.epoch!==deps.epoch||!Number.isSafeInteger(resolution.committedRevision)||resolution.committedRevision<entry.context.expectedRevision) throw new Error("Invalid operation resolution");
        entries.shift();active=null;acknowledged=entry.last;revision=Math.max(revision,resolution.committedRevision);error=null;checkpointDirty=true;
        for(let index=waiters.length-1;index>=0;index--) if(waiters[index].sequence<=acknowledged) waiters.splice(index,1)[0].resolve();
        notify();scheduleCheckpoint();void Promise.resolve().then(()=>pump());
      } catch(reason) {
        if(entries[0]===entry) fail(entry,reason);
        throw reason;
      }
    },
    suspendWrites() {
      assertOpen();writeSuspensions++;clearIdleTimer();
      let released=false;
      return ()=>{if(!released) {released=true;writeSuspensions--;if(writeSuspensions===0) scheduleCheckpoint();}};
    },
    async close() {
      if (closed) return;
      clearIdleTimer();
      const through = coordinator.captureBarrier();
      closing = true;
      try { await coordinator.flushThrough(through);if(checkpointInFlight) await checkpointInFlight;closed = true;clearTimer();clearIdleTimer();unsubscribe?.(); }
      finally { closing = false; }
    },
  };
  return coordinator;
}
