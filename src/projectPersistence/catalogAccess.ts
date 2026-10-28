import {useProjectCatalogStore} from "../stores/useProjectCatalogStore";
import {useProjectStore} from "../stores/useProjectStore";
import {getProjectDirectorySummaries,hasProjectDocumentBody} from "./documentAdapters";
import type {ProjectDocumentSummary} from "../types/projectPersistence";

export interface NativeProjectDirectory {
  epoch:number;
  committedRevision:number;
  items:ProjectDocumentSummary[];
}

/** Complete metadata inventories without fetching any document or table body. */
export async function readNativeProjectDirectory():Promise<NativeProjectDirectory|null> {
  const owner=useProjectStore.getState().persistence;
  if(!owner) return null;
  const epoch=owner.snapshot().epoch;
  const assertCurrent=()=>{
    if(useProjectStore.getState().persistence!==owner||useProjectCatalogStore.getState().epoch!==epoch) throw new Error("project_catalog_session_stale");
  };
  assertCurrent();
  while(useProjectCatalogStore.getState().nextCursor!==null) {
    const before=useProjectCatalogStore.getState();
    await before.loadNextPage();assertCurrent();
    const after=useProjectCatalogStore.getState();
    if(after.nextCursor!==null&&after.nextCursor===before.nextCursor&&after.committedRevision===before.committedRevision&&Object.keys(after.summaries).length===Object.keys(before.summaries).length) throw new Error("project_catalog_no_progress");
  }
  const catalog=useProjectCatalogStore.getState();
  return {epoch,committedRevision:catalog.committedRevision,items:getProjectDirectorySummaries(epoch)??Object.values(catalog.summaries)};
}

export async function hydrateNativeProjectDocument(id:string,epoch:number):Promise<void> {
  const owner=useProjectStore.getState().persistence;
  if(!owner||owner.snapshot().epoch!==epoch||useProjectCatalogStore.getState().epoch!==epoch) throw new Error("project_catalog_session_stale");
  if(!hasProjectDocumentBody(id,epoch)) await useProjectCatalogStore.getState().ensureDocument(id);
  if(useProjectStore.getState().persistence!==owner) throw new Error("project_catalog_session_stale");
}

/** Explicit document actions finish the metadata inventory before allocating names.
 * Only requested bodies and missing source-table metadata are hydrated. */
export async function prepareNativeDocumentAccess(input: {documentIds?: readonly string[]; datasetIds?: readonly string[]} = {}): Promise<void> {
  const owner = useProjectStore.getState().persistence;
  if (!owner) return;
  const directory = await readNativeProjectDirectory();
  const assertCurrent = () => {
    if (!directory || useProjectStore.getState().persistence !== owner || owner.snapshot().epoch !== directory.epoch) throw new Error("project_catalog_session_stale");
  };
  assertCurrent();
  const {useDataStore} = await import("../stores/useDataStore");
  const selected = new Set(input.documentIds ?? []);
  const tableIds = new Set(directory!.items.filter(item => item.kind === "table").map(item => item.id));
  const sourceIds = [...(input.datasetIds ?? []), ...directory!.items.filter(item => selected.has(item.id)).flatMap(item => item.dependencies.filter(id => tableIds.has(id)))];
  const missing = sourceIds.some(id => !useDataStore.getState().datasets.some(dataset => dataset.id === id));
  if (missing) {
    const {dataService} = await import("../services/dataService");
    const datasets = await dataService.listDatasets();
    assertCurrent();
    useDataStore.setState({datasets});
  }
  for (const id of new Set(input.documentIds ?? [])) {
    if (!directory!.items.some(item => item.id === id)) throw new Error("project_document_not_found");
    await hydrateNativeProjectDocument(id,directory!.epoch);
    assertCurrent();
  }
}
