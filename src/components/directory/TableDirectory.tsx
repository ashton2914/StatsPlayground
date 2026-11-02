import {useEffect,useState} from 'react';
import type {DragEvent,MouseEvent} from 'react';
import type {ProjectDocumentKind} from '../../types/projectPersistence';
import type {DirectoryGroup,TableDirectoryModel} from './tableDirectoryModel';
import {groupDragPayload} from './tableDirectoryModel';
import './tableDirectory.css';
export interface TableDirectoryProps {
  model:TableDirectoryModel;folder:string;selectedIds:(string|null)[];readOnly:boolean;
  labels:{expand:string;collapse:string;more:string;transform:string;normalize:string};
  onActivate:(kind:ProjectDocumentKind,id:string)=>void;
  onContextMenu:(kind:ProjectDocumentKind,id:string,event:MouseEvent)=>void;
  onRename:(id:string,name:string)=>Promise<void>;
  onDragStart:(event:DragEvent,payload:NonNullable<ReturnType<typeof groupDragPayload>>)=>void;
}
const icons:Partial<Record<ProjectDocumentKind,string>>={table:'table',graph:'chart-pie',graphNew:'chart-line',analysis:'magnifying-glass-chart',tabulate:'table-cells-large'};
export function TableDirectory(props:TableDirectoryProps){
  const {model,folder,selectedIds,readOnly,labels}=props;const [expanded,setExpanded]=useState<Set<string>>(new Set());const [limits,setLimits]=useState<Record<string,number>>({});const [groupLimit,setGroupLimit]=useState(100);const [rename,setRename]=useState<{id:string;name:string}|null>(null);const [renaming,setRenaming]=useState(false);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{setExpanded(current=>{const next=new Set(current);for(const id of selectedIds){const table=id&&model.owner.get(id);if(table&&table!==id)next.add(table);}return next;});},[model,selectedIds.join('|')]);
  const groups=model.groups.filter(g=>g.folder===folder);
  const saveName=async()=>{if(!rename||renaming)return;setRenaming(true);try{await props.onRename(rename.id,rename.name);setRename(null);setError(null);}catch(e){setError(String(e));}finally{setRenaming(false);}};
  const row=(item:{id:string;name:string;kind:ProjectDocumentKind},table:boolean,hasChildren=false)=> <div key={item.id} data-testid={`directory-document-${item.id}`} className={`dataset-item sp-table-directory-row ${selectedIds.includes(item.id)?'active':''}`} role="treeitem" aria-expanded={table&&hasChildren?expanded.has(item.id):undefined} draggable={!readOnly&&!rename&&model.diagnostics.length===0}
    onDragStart={event=>{const payload=groupDragPayload(model,item.id);if(payload)props.onDragStart(event,payload);}}
    onDragOver={event=>{event.stopPropagation();event.dataTransfer.dropEffect='none';}} onDrop={event=>{event.preventDefault();event.stopPropagation();}}
    onClick={()=>props.onActivate(item.kind,item.id)} onDoubleClick={()=>{if(!readOnly)setRename({id:item.id,name:item.name});}}
    onContextMenu={event=>props.onContextMenu(item.kind,item.id,event)}>
    {table?<button type="button" className="sp-directory-toggle" disabled={!hasChildren} aria-label={expanded.has(item.id)?labels.collapse:labels.expand} onClick={event=>{event.stopPropagation();setExpanded(current=>{const next=new Set(current);if(next.has(item.id))next.delete(item.id);else next.add(item.id);return next;});}}>{hasChildren?(expanded.has(item.id)?'▾':'▸'):''}</button>:null}
    <i className={`ds-icon fa-solid fa-${icons[item.kind]??'file'}`} aria-hidden="true"/>
    {rename?.id===item.id?<input className="ds-rename-input" autoFocus value={rename.name} disabled={renaming} onClick={e=>e.stopPropagation()} onChange={e=>setRename({...rename,name:e.target.value})} onBlur={()=>void saveName()} onKeyDown={e=>{if(e.key==='Enter')void saveName();if(e.key==='Escape')setRename(null);}}/>:<span className="ds-name">{item.name}</span>}
  </div>;
  const renderGroup=(group:DirectoryGroup)=><div key={group.id} className={`sp-table-group ${group.transforms.length?'sp-table-group-linked':''}`} data-testid={`directory-group-${group.id}`}>
    {group.transforms.length>0&&<div className="sp-table-group-controls" draggable={!readOnly&&model.diagnostics.length===0} onDragStart={e=>props.onDragStart(e,groupDragPayload(model,group.tables[0].id)!)}>
      {group.transforms.length===1?<button type="button" title={group.transforms[0].name} aria-label={`${labels.transform}: ${group.transforms[0].name}`} onClick={()=>props.onActivate('transform',group.transforms[0].id)}><i className="fa-solid fa-shuffle"/></button>:<details><summary aria-label={labels.transform}><i className="fa-solid fa-shuffle"/></summary><div className="sp-table-transform-list">{group.transforms.map(t=><button key={t.id} onClick={()=>props.onActivate('transform',t.id)}>{t.name}</button>)}</div></details>}
    </div>}
    <div className="sp-table-group-tables">{group.needsNormalization&&<span className="sp-directory-warning">{labels.normalize}</span>}{group.tables.slice(0,limits[group.id]??200).map(table=><div key={table.id} className="sp-directory-table">{row({...table,kind:'table'},true,table.children.length>0)}{expanded.has(table.id)&&<div className="sp-table-owned" role="group">{table.children.slice(0,limits[table.id]??100).map(child=>row(child,false))}{table.children.length>(limits[table.id]??100)&&<button onClick={()=>setLimits({...limits,[table.id]:(limits[table.id]??100)+100})}>{labels.more}</button>}</div>}</div>)}{group.tables.length>(limits[group.id]??200)&&<button onClick={()=>setLimits({...limits,[group.id]:(limits[group.id]??200)+200})}>{labels.more}</button>}</div>
  </div>;
  return <div className="sp-table-directory" role="tree">{error&&<div role="alert">{error}</div>}{groups.slice(0,groupLimit).map(renderGroup)}{groups.length>groupLimit&&<button onClick={()=>setGroupLimit(groupLimit+100)}>{labels.more}</button>}</div>;
}
