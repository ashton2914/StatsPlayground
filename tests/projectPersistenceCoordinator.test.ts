import assert from "node:assert/strict";
import {
  createProjectPersistenceCoordinator,
  type PersistenceDependencies,
  type ProjectOperation,
} from "../src/projectPersistence/coordinator.ts";
import type { DocumentWrite, ProjectCommit, ProjectWriteContext, ProjectRecordPatch } from "../src/types/projectPersistence.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function document(text: string, expectedRevision: number | null = 1): DocumentWrite {
  return { expectedRevision, document: { schemaVersion: 1,
    summary: { id: "report", kind: "report", name: "Report", folder: "", revision: (expectedRevision ?? 0) + 1, dependencies: [] },
    body: { id: "report", name: "Report", schemaVersion: 1, markdown: text },
  } };
}
function fixture(overrides: Partial<PersistenceDependencies> = {}) {
  let now = 0;
  let identity = 0;
  let timerId = 0;
  let listener: ((commit: ProjectCommit<unknown>) => void) | undefined;
  const timers = new Map<number, { at: number; run: () => void }>();
  const sent: Array<{ operation: ProjectOperation<unknown>; context: ProjectWriteContext; reply: ReturnType<typeof deferred<ProjectCommit<unknown>>> }> = [];
  const deps: PersistenceDependencies = {
    projectId: "project", epoch: 7, committedRevision: 10,
    now: () => now, newOperationId: () => `operation-${++identity}`,
    setTimer: (run, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, run }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    transport: <T>(operation: ProjectOperation<T>, context: ProjectWriteContext) => {
      const reply = deferred<ProjectCommit<unknown>>();
      sent.push({ operation, context: structuredClone(context), reply });
      return reply.promise as Promise<ProjectCommit<T>>;
    },
    subscribeCommits: (receive) => { listener = receive; return () => { listener = undefined; }; },
    ...overrides,
  };
  const queue = createProjectPersistenceCoordinator(deps);
  function acknowledgement(index: number, revision = sent[index].context.expectedRevision + 1): ProjectCommit<unknown> {
    return { operationId: sent[index].context.operationId, epoch: 7, committedRevision: revision,
      value: null, changedDatasetGenerations: [], changedDocumentRevisions: [{ id: "report", revision: 2 }] };
  }
  return { queue, sent, timers, acknowledgement,
    emit: (commit: ProjectCommit<unknown>) => listener?.(commit),
    async tick(milliseconds: number) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
      await settle();
    },
    async ack(index: number, revision?: number) { sent[index].reply.resolve(acknowledgement(index, revision)); await settle(); },
  };
}

{
  const f = fixture();
  f.queue.enqueueDocument(document("first"));
  await f.tick(200);
  f.queue.enqueueDocument(document("last"));
  await f.tick(49);
  assert.equal(f.sent.length, 0);
  await f.tick(1);
  assert.equal(f.sent.length, 1, "continuous edits persist no later than 250 ms");
  const patch = f.sent[0].operation.payload as { documents: DocumentWrite[] };
  assert.equal((patch.documents[0].document.body as { markdown: string }).markdown, "last");
  assert.equal(patch.documents[0].expectedRevision, 1);
  assert.equal(f.sent[0].context.expectedProjectId, "project");
  await f.ack(0, 37);
  assert.equal(f.queue.snapshot().acknowledgedSequence, 2);
  assert.equal(f.queue.snapshot().committedRevision, 37, "revision is supplied by backend");
}
{
  const f = fixture();
  f.queue.enqueueDocument(document("before save"));
  const barrier = f.queue.captureBarrier();
  const save = f.queue.flushThrough(barrier);
  f.queue.enqueueDocument(document("after save"));
  await settle();
  assert.equal(f.sent.length, 1);
  await f.ack(0);
  await save;
  assert.equal(f.queue.snapshot().pendingSequence, 2);
  assert.equal(f.queue.snapshot().acknowledgedSequence, 1);
  assert.equal(f.sent.length, 1, "save must not wait for or merge later edits");
  await f.tick(250);
  const patch = f.sent[1].operation.payload as { documents: DocumentWrite[] };
  assert.equal(patch.documents[0].expectedRevision, 2, "own prior ack rebases a later edit");
  await f.ack(1);
}
{
  const f = fixture();
  f.queue.enqueueDocument(document("captured"));
  const barrier = f.queue.captureBarrier();
  f.queue.enqueueDocument(document("later"));
  const save = f.queue.flushThrough(barrier);
  await settle();
  await f.ack(0);
  await save;
  await settle();
  assert.equal(f.sent.length, 1, "flushing a captured barrier must not force a later batch");
  await f.tick(250);
  await f.ack(1);
}
{
  const f = fixture();
  f.queue.enqueueDocument(document("before command"));
  const command = f.queue.submit({ command: "apply_table_change_set", payload: { changeSetId: "history", undo: true } });
  f.queue.enqueueDocument(document("after command"));
  await settle();
  assert.equal(f.sent.length, 1);
  await f.ack(0);
  assert.equal(f.sent[1].operation.command, "apply_table_change_set");
  await f.ack(1);
  await command;
  await f.tick(250);
  assert.equal(f.sent[2].operation.command, "commit_project_records");
  await f.ack(2);
}
{
  const f = fixture();
  f.queue.enqueueDocument(document("keep on failure"));
  const sequence = f.queue.captureBarrier();
  const failed = f.queue.flushThrough(sequence);
  await settle();
  const first = structuredClone(f.sent[0].context);
  f.sent[0].reply.reject(new Error("connection lost after commit"));
  await assert.rejects(failed, /connection lost/);
  assert.equal(f.queue.snapshot().status, "error");
  assert.equal(f.queue.snapshot().acknowledgedSequence, 0);
  const retry = f.queue.flushThrough(sequence);
  await settle();
  assert.deepEqual(f.sent[1].context, first, "retry preserves operation identity and digest");
  assert.deepEqual(f.sent[1].operation, f.sent[0].operation);
  await f.ack(1);
  await retry;
  assert.equal(f.queue.snapshot().status, "saved");
}
{
  const f = fixture();
  f.queue.enqueueDocument(document("event"));
  const save = f.queue.flushThrough(f.queue.captureBarrier());
  await settle();
  const ack = f.acknowledgement(0, 50);
  f.emit({ ...ack, epoch: 6 });
  assert.equal(f.queue.snapshot().acknowledgedSequence, 0);
  assert.equal(f.queue.snapshot().committedRevision, 10);
  f.emit(ack);
  f.emit(ack);
  await settle();
  await save;
  await f.ack(0, 50);
  assert.equal(f.queue.snapshot().acknowledgedSequence, 1);
  assert.equal(f.queue.snapshot().committedRevision, 50);
  await f.queue.close();
  assert.equal(f.timers.size, 0);
  assert.throws(() => f.queue.enqueueDocument(document("closed")), /closed/);
}
{
  const f = fixture({ writable: false });
  assert.throws(() => f.queue.enqueueDocument(document("read only")), /read only/);
  await f.queue.flushThrough(0);
  await f.queue.close();
  assert.equal(f.sent.length, 0);
}
{
  const f = fixture();
  f.queue.enqueueDocument(document("edit before move/delete"));
  const firstSetting = f.queue.submit({ command: "commit_project_records", payload: { settings: [{ key: "filter:table", expectedRevision: null, value: [1] }] } });
  const secondSetting = f.queue.submit({ command: "commit_project_records", payload: { settings: [{ key: "filter:table", expectedRevision: null, value: [2] }], directoryMoves: [{ id: "report", expectedRevision: 1, folder: "Archive" }] }, documentRevisions: [{ id: "report", revision: 1 }] });
  await settle();
  await f.ack(0);
  f.sent[1].reply.resolve({ ...f.acknowledgement(1), changedDocumentRevisions: [], changedSettingRevisions: [{ key: "filter:table", revision: 1 }] });
  await firstSetting;
  await settle();
  const patch = f.sent[2].operation.payload as ProjectRecordPatch;
  assert.equal(patch.settings![0].expectedRevision, 1, "settings queued before an acknowledgement must use their own prior acknowledged version");
  assert.equal(patch.directoryMoves![0].expectedRevision, 2);
  assert.equal(f.sent[2].context.documentRevisions![0].revision, 2);
  await f.ack(2);
  await secondSetting;
}
{
  const revisions: number[] = [];
  const f = fixture({ onCommit: (commit) => revisions.push(commit.committedRevision) });
  f.queue.enqueueDocument(document("first"));
  const first = f.queue.flushThrough(f.queue.captureBarrier());
  await settle();
  const old = f.acknowledgement(0, 11);
  await f.ack(0, 11); await first;
  f.queue.enqueueDocument(document("second"));
  const second = f.queue.flushThrough(f.queue.captureBarrier());
  await settle(); await f.ack(1, 12); await second;
  f.emit(old);
  assert.deepEqual(revisions, [11, 12], "delayed duplicate events cannot regress projected document revisions");
}
{
  const f = fixture();
  const first = f.queue.submit({ command: "update_cells", payload: { datasetId: "table", updates: [], expectedGeneration: 0 }, datasetGenerations: [{ id: "table", generation: 0 }] });
  const second = f.queue.submit({ command: "update_cells", payload: { datasetId: "table", updates: [], expectedGeneration: 0 }, datasetGenerations: [{ id: "table", generation: 0 }] });
  await settle();
  f.sent[0].reply.resolve({ ...f.acknowledgement(0), changedDocumentRevisions: [], changedDatasetGenerations: [{ id: "table", generation: 1 }] });
  await first; await settle();
  assert.equal((f.sent[1].operation.payload as { expectedGeneration: number }).expectedGeneration, 1, "payload and context must share the same rebased generation");
  assert.equal(f.sent[1].context.datasetGenerations![0].generation, 1);
  await f.ack(1); await second;
}
{
  let projections=0;
  const f=fixture({onCommit:()=>{if(++projections===1) throw new Error("projection failed");}});
  const submitted=f.queue.submit({command:"update_cells",payload:{datasetId:"table",updates:[],expectedGeneration:0},datasetGenerations:[{id:"table",generation:0}]}).catch(error=>error);
  const barrier=f.queue.flushThrough(f.queue.captureBarrier()).catch(error=>error);
  await settle();await f.ack(0);
  assert.equal(f.queue.snapshot().status,"error","a committed receipt with failed projection must remain recoverable");
  assert.equal(f.queue.snapshot().acknowledgedSequence,0,"barriers cannot pass a failed projection");
  assert.match(String(await submitted),/projection failed/);assert.match(String(await barrier),/projection failed/);
  const recovered=f.queue.flushThrough(f.queue.captureBarrier());await settle();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1].context,f.sent[0].context,"projection recovery must replay the original immutable operation");
  await f.ack(1,11);await recovered;
  assert.equal(projections,2);assert.equal(f.queue.snapshot().status,"saved");assert.equal(f.queue.snapshot().acknowledgedSequence,1);await f.queue.close();
}
{
  const f=fixture();const request={datasetId:"table",outputName:"Formula",formulaText:"[A] * 2",expectedGeneration:0};
  const first=f.queue.submit({command:"upsert_calculated_column",payload:{request},datasetGenerations:[{id:"table",generation:0}]});
  const second=f.queue.submit({command:"upsert_calculated_column",payload:{request:{...request,outputName:"Next"}},datasetGenerations:[{id:"table",generation:0}]});
  await settle();f.sent[0].reply.resolve({...f.acknowledgement(0),changedDocumentRevisions:[],changedDatasetGenerations:[{id:"table",generation:1}]});await first;await settle();
  assert.equal((f.sent[1].operation.payload as any).request.expectedGeneration,1,"nested formula requests must share the acknowledged generation with their context");
  assert.equal(f.sent[1].context.datasetGenerations![0].generation,1);assert.equal(request.expectedGeneration,0,"rebasing cannot mutate the caller's request");
  await f.ack(1);await second;await f.queue.close();
}
{
  let resolvedContext:ProjectWriteContext|undefined;
  const f=fixture({resolveOperation:async(context:ProjectWriteContext)=>{resolvedContext=structuredClone(context);return {status:"cancelled",operationId:context.operationId,epoch:7,committedRevision:10};}} as Partial<PersistenceDependencies>);
  const failed=f.queue.submit({command:"update_cells",payload:{datasetId:"table",updates:[]},datasetGenerations:[{id:"table",generation:0}]}).catch(error=>error);
  const next=f.queue.submit({command:"add_rows",payload:{datasetId:"table",count:1},datasetGenerations:[{id:"table",generation:0}]});
  await settle();f.sent[0].reply.reject(new Error("invalid mutation"));await failed;await settle();
  assert.equal(f.queue.snapshot().canResolveFailedOperation,true);
  await f.queue.resolveFailedOperation();await settle();assert.deepEqual(resolvedContext,f.sent[0].context);
  assert.equal(f.queue.snapshot().acknowledgedSequence,1);assert.equal(f.sent.length,2);await f.ack(1);await next;await f.queue.close();
}
{
  let projections=0;
  const f=fixture({resolveOperation:async()=>({status:"committed",commit:f.acknowledgement(0,11)}),onCommit:()=>{projections++;}} as Partial<PersistenceDependencies>);
  const failed=f.queue.submit({command:"update_cells",payload:{datasetId:"table",updates:[]}}).catch(error=>error);
  await settle();f.sent[0].reply.reject(new Error("lost acknowledgement"));await failed;await settle();
  await f.queue.resolveFailedOperation();assert.equal(f.sent.length,1,"committed resolution must not write again");assert.equal(projections,1);assert.equal(f.queue.snapshot().status,"saved");await f.queue.close();
}
{
  let attempt=0;
  const f=fixture({resolveOperation:async(context:ProjectWriteContext)=>{attempt++;if(attempt===1)throw new Error("resolution unavailable");return {status:"cancelled",operationId:attempt===2?"wrong-operation":context.operationId,epoch:7,committedRevision:10};}} as Partial<PersistenceDependencies>);
  const failed=f.queue.submit({command:"update_cells",payload:{datasetId:"table",updates:[]}}).catch(error=>error);await settle();f.sent[0].reply.reject(new Error("failed"));await failed;await settle();
  await assert.rejects(f.queue.resolveFailedOperation(),/resolution unavailable/);assert.equal(f.queue.snapshot().acknowledgedSequence,0);
  await assert.rejects(f.queue.resolveFailedOperation(),/Invalid operation resolution/);assert.equal(f.queue.snapshot().acknowledgedSequence,0);
  await f.queue.resolveFailedOperation();assert.equal(f.queue.snapshot().acknowledgedSequence,1);assert.equal(f.sent.length,1);await f.queue.close();
}
{
  let resolutions=0;
  const f=fixture({resolveOperation:async()=>{resolutions++;throw new Error("must not discard a document draft");}} as Partial<PersistenceDependencies>);
  f.queue.enqueueDocument(document("retained draft"));const failed=f.queue.flushThrough(f.queue.captureBarrier()).catch(error=>error);await settle();f.sent[0].reply.reject(new Error("document conflict"));await failed;await settle();
  assert.equal(f.queue.snapshot().canResolveFailedOperation,false);await assert.rejects(f.queue.resolveFailedOperation(),/retained draft/);assert.equal(resolutions,0);assert.equal(f.queue.snapshot().acknowledgedSequence,0);
  const retry=f.queue.flushThrough(f.queue.captureBarrier());await settle();assert.equal(((f.sent[1].operation.payload as ProjectRecordPatch).documents![0].document.body as {markdown:string}).markdown,"retained draft");assert.deepEqual(f.sent[1].context,f.sent[0].context,"failed outcome resolution permits only immutable replay");await f.ack(1);await retry;await f.queue.close();
}
{
  let projections=0;
  const f=fixture({onCommit:()=>{if(++projections===1) throw new Error("external projection failed");}});
  const external:ProjectCommit<unknown>={operationId:"external",epoch:7,committedRevision:11,value:null,changedDocumentRevisions:[],changedDatasetGenerations:[]};
  assert.doesNotThrow(()=>f.emit(external),"external projection failure must enter recoverable state");
  assert.equal(f.queue.snapshot().status,"error");assert.equal(f.queue.snapshot().committedRevision,11);
  await f.queue.flushThrough(0);assert.equal(projections,2);assert.equal(f.queue.snapshot().status,"saved");assert.equal(f.sent.length,0,"retry only reprojects the already committed receipt");await f.queue.close();
}
{
  let attempts=0;const projected:number[]=[];
  const f=fixture({onCommit:commit=>{if(++attempts===1)throw new Error("external projection failed");projected.push(commit.committedRevision);}});
  const external:ProjectCommit<unknown>={operationId:"external-11",epoch:7,committedRevision:11,value:null,changedDocumentRevisions:[],changedDatasetGenerations:[]};
  f.emit(external);f.emit({...external,operationId:"external-12",committedRevision:12});assert.deepEqual(projected,[11,12],"a newer partial receipt cannot erase an unprojected earlier receipt");assert.equal(f.queue.snapshot().status,"saved");await f.queue.close();
}
{
  const projected:number[]=[];const f=fixture({onCommit:commit=>projected.push(commit.committedRevision)});
  const external:ProjectCommit<unknown>={operationId:"external-12",epoch:7,committedRevision:12,value:null,changedDocumentRevisions:[],changedDatasetGenerations:[]};
  f.emit(external);f.emit({...external,operationId:"external-11",committedRevision:11});
  assert.deepEqual(projected,[12,11],"out-of-order partial receipts for different records must both be projected");assert.equal(f.queue.snapshot().committedRevision,12);
  f.emit(external);f.emit({...external,operationId:"external-11",committedRevision:11});assert.deepEqual(projected,[12,11],"duplicate revisions must not project again");await f.queue.close();
}
console.log("project persistence coordinator: coalescing, barriers, retries, epochs and acknowledgements passed");
