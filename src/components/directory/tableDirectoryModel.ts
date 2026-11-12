import type {ProjectDocumentSummary,ProjectOwnedDocument,ProjectTableNode,ProjectTopology,ProjectTransformLink} from '../../types/projectPersistence';
export interface DirectoryChild extends ProjectOwnedDocument {name:string}
export interface DirectoryTable extends ProjectTableNode {children:DirectoryChild[];dataLink?:{name:string}}
export interface DirectoryGroup {id:string;folder:string;tables:DirectoryTable[];transforms:ProjectTransformLink[];needsNormalization:boolean}
export interface TableDirectoryModel {epoch:number;revision:number;groups:DirectoryGroup[];owner:Map<string,string>;diagnostics:ProjectTopology['diagnostics']}
/** Complete metadata owns membership; paged summaries only supplement presentation. */
export function buildTableDirectory(topology:ProjectTopology,summaries:ProjectDocumentSummary[]):TableDirectoryModel {
  const details=new Map(summaries.map(s=>[s.id,s]));const tables=new Map<string,DirectoryTable>(topology.tables.map(t=>[t.id,{...t,children:[] as DirectoryChild[]}]));
  for (const link of topology.dataLinks ?? []) {
    const table = tables.get(link.tableId);
    if (table) table.dataLink = { name: link.name };
  }
  const adjacency=new Map<string,Set<string>>();const children=new Map<string,Set<string>>();const degree=new Map(topology.tables.map(t=>[t.id,0]));const owner=new Map<string,string>();
  for(const t of tables.values()){adjacency.set(t.id,new Set());owner.set(t.id,t.id);}
  for(const link of topology.transforms){owner.set(link.id,link.outputTableId);for(const input of link.inputs){adjacency.get(input.tableId)?.add(link.outputTableId);adjacency.get(link.outputTableId)?.add(input.tableId);const next=children.get(input.tableId)??new Set<string>();if(!next.has(link.outputTableId)){next.add(link.outputTableId);degree.set(link.outputTableId,(degree.get(link.outputTableId)??0)+1);}children.set(input.tableId,next);}}
  for(const child of topology.ownedDocuments){owner.set(child.id,child.tableId);tables.get(child.tableId)?.children.push({...child,name:child.name??details.get(child.id)?.name??child.kind});}
  const rank=['graph','graphNew','analysis','tabulate'];for(const table of tables.values()) table.children.sort((a,b)=>rank.indexOf(a.kind)-rank.indexOf(b.kind)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const groups:DirectoryGroup[]=[];const visited=new Set<string>();
  const linksByTable=new Map<string,ProjectTransformLink[]>();for(const link of topology.transforms){const links=linksByTable.get(link.outputTableId)??[];links.push(link);linksByTable.set(link.outputTableId,links);}
  for(const start of topology.tables){if(visited.has(start.id))continue;const ids:string[]=[];const pending=[start.id];while(pending.length){const id=pending.pop()!;if(visited.has(id)||!tables.has(id))continue;visited.add(id);ids.push(id);pending.push(...adjacency.get(id)??[]);}
    const queue=ids.filter(id=>degree.get(id)===0).sort();const ordered:string[]=[];for(let index=0;index<queue.length;index++){const id=queue[index];ordered.push(id);for(const next of children.get(id)??[]){const n=degree.get(next)!-1;degree.set(next,n);if(n===0)queue.push(next);}}
    const seen=new Set(ordered);for(const id of ids)if(!seen.has(id))ordered.push(id);
    const members=ordered.map(id=>tables.get(id)!);const folder=members[0].folder;const transforms=ids.flatMap(id=>linksByTable.get(id)??[]);
    groups.push({id:[...ids].sort()[0],folder,tables:members,transforms,needsNormalization:members.some(t=>t.folder!==folder)||transforms.some(t=>t.folder!==undefined&&t.folder!==folder)||members.some(t=>t.children.some(c=>c.folder!==undefined&&c.folder!==folder))});
  }
  groups.sort((a,b)=>a.folder.localeCompare(b.folder)||a.tables[0].name.localeCompare(b.tables[0].name)||a.id.localeCompare(b.id));
  return {epoch:topology.epoch,revision:topology.committedRevision,groups,owner,diagnostics:topology.diagnostics};
}
export function groupDragPayload(model:TableDirectoryModel,id:string){const tableId=model.owner.get(id);return tableId?{kind:'tableGroup' as const,tableId,epoch:model.epoch,revision:model.revision}:null;}
