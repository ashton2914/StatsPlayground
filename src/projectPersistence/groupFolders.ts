import type {ProjectDocumentSummary,ProjectRecordPatch} from '../types/projectPersistence';
import {assertProjectFolderPath} from '../utils/projectFileNaming';
import {readNativeProjectDirectory} from './catalogAccess';
import {readProjectTopology} from './tableGroups';
import {useProjectStore} from '../stores/useProjectStore';
/** Folder changes rewrite the complete native inventory in one guarded record transaction. */
export function groupFolderPatch(items:ProjectDocumentSummary[],source:string,destination:string|null):ProjectRecordPatch {
  assertProjectFolderPath(source);if(destination!==null)assertProjectFolderPath(destination);
  if(!source||destination===source||destination?.startsWith(source+'/'))throw new Error('project_folder_destination_invalid');
  const paths=items.filter(i=>i.kind==='folder').map(i=>[i.folder,i.name].filter(Boolean).join('/'));
  if(!paths.includes(source))throw new Error('project_folder_missing');
  if(destination!==null&&paths.includes(destination))throw new Error('project_folder_destination_exists');
  const parent=source.includes('/')?source.slice(0,source.lastIndexOf('/')):'';
  const replace=(path:string)=>{const remainder=path.slice(source.length).replace(/^\//,'');return [destination??parent,remainder].filter(Boolean).join('/');};
  const inside=(path:string)=>path===source||path.startsWith(source+'/');
  const affected=paths.filter(inside);const createdFolders=affected.map(replace).filter(Boolean).sort((a,b)=>a.split('/').length-b.split('/').length);
  return {directoryMoves:items.filter(i=>i.kind!=='folder'&&inside(i.folder)).map(i=>({id:i.id,expectedRevision:i.revision,folder:replace(i.folder)})),createdFolders,deletedFolders:affected.sort((a,b)=>b.split('/').length-a.split('/').length)};
}
export async function mutateGroupFolder(source:string,destination:string|null){
  const owner=useProjectStore.getState().persistence;if(!owner)throw new Error('project_session_required');
  const topology=await readProjectTopology();const directory=await readNativeProjectDirectory();
  if(useProjectStore.getState().persistence!==owner||directory?.epoch!==topology.epoch||directory.committedRevision!==topology.committedRevision)throw new Error('project_topology_session_stale');
  await owner.submit({command:'commit_project_records',payload:groupFolderPatch(directory.items,source,destination)});
  if(useProjectStore.getState().persistence!==owner)throw new Error('project_topology_session_stale');
}
