import {useDatasetFilterStore} from "../stores/useDatasetFilterStore";
import {useWorkflowStore} from "../stores/useWorkflowStore";
import {useTableTransformStore} from "../stores/useTableTransformStore";
import type {FilterRuleItem} from "../types/filter";
import type {ProjectLineageGraph} from "../types/workflow";
import type {TableTransformBindingState} from "../types/tableTransform";

function invalid():never {throw new Error("project_setting_invalid");}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=="object"||Array.isArray(value)) return invalid();
  return value as Record<string,unknown>;
}
function text(value:unknown):value is string {return typeof value==="string"&&value.trim().length>0;}
function ordinal(value:unknown,minimum=0):value is number {return Number.isSafeInteger(value)&&Number(value)>=minimum;}
function filters(value:unknown):FilterRuleItem[] {
  if(!Array.isArray(value)) return invalid();
  for(const item of value) {
    const row=object(item);const rule=object(row.rule);const field=object(rule.field);
    if(!text(row.id)||!["AND","OR"].includes(String(row.op))||!text(field.name)||!["continuous","nominal","ordinal","datetime","id"].includes(String(field.type))) return invalid();
    if(field.columnId!==undefined&&!text(field.columnId)) return invalid();
    if(row.height!==undefined&&(typeof row.height!=="number"||!Number.isFinite(row.height)||row.height<=0)) return invalid();
    if(rule.kind==="continuous") {
      for(const bound of [rule.min,rule.max]) if(bound!==null&&(typeof bound!=="number"||!Number.isFinite(bound))) return invalid();
    } else if(rule.kind==="categorical") {
      if(!Array.isArray(rule.selected)||rule.selected.some(value=>typeof value!=="string")||(rule.exclude!==undefined&&typeof rule.exclude!=="boolean")) return invalid();
    } else if(rule.kind==="date") {
      if([rule.start,rule.end].some(value=>value!==null&&typeof value!=="string")) return invalid();
    } else return invalid();
  }
  return structuredClone(value) as FilterRuleItem[];
}
function lineage(value:unknown):ProjectLineageGraph {
  const row=object(value);
  if(!text(row.id)||typeof row.name!=="string"||!ordinal(row.graphVersion)||typeof row.graphHash!=="string"||!Array.isArray(row.nodes)||!Array.isArray(row.edges)) return invalid();
  for(const node of row.nodes) {const entry=object(node);if(!text(entry.id)||!["artifact","operation"].includes(String(entry.nodeType))) return invalid();}
  for(const edge of row.edges) {const entry=object(edge);const source=object(entry.source);const target=object(entry.target);if(!text(entry.id)||!text(source.nodeId)||!text(source.portId)||!text(target.nodeId)||!text(target.portId)) return invalid();}
  return structuredClone(value) as ProjectLineageGraph;
}
function binding(value:unknown,id:string):TableTransformBindingState {
  const row=object(value);
  if(row.definitionId!==id||!ordinal(row.definitionRevision,1)||!ordinal(row.outputGeneration)||!Array.isArray(row.inputs)) return invalid();
  for(const input of row.inputs) {const entry=object(input);if(!text(entry.role)||!text(entry.tableDocumentId)) return invalid();}
  if(row.lastRun!==undefined) {
    const run=object(row.lastRun);
    if(!ordinal(run.definitionRevision,1)||!["succeeded","failed","blocked"].includes(String(run.status))||(run.outputGeneration!==undefined&&!ordinal(run.outputGeneration))) return invalid();
  }
  if(row.schemaReports!==undefined&&!Array.isArray(row.schemaReports)) return invalid();
  return structuredClone(value) as TableTransformBindingState;
}

/** Parse the selected setting completely before changing any domain state. */
export function prepareProjectSettingProjection(key:string,value:unknown):()=>void {
  if(key.startsWith("filter:")) {
    const id=key.slice("filter:".length);if(!id) return invalid();
    const rules=value===null?[]:filters(value);
    return ()=>useDatasetFilterStore.setState(state=>{
      const byDataset={...state.byDataset};if(rules.length) byDataset[id]=rules;else delete byDataset[id];return {byDataset};
    });
  }
  if(key==="lineage") {
    const graph=value===null?{id:"project-lineage",name:"",graphVersion:0,graphHash:"",nodes:[],edges:[]}:lineage(value);
    return ()=>useWorkflowStore.setState({lineageGraph:graph});
  }
  if(key.startsWith("transformBinding:")) {
    const id=key.slice("transformBinding:".length);if(!id) return invalid();
    const result=value===null?null:binding(value,id);
    return ()=>useTableTransformStore.setState(state=>({bindings:[...state.bindings.filter(item=>item.definitionId!==id),...(result?[result]:[])]}));
  }
  throw new Error("project_setting_requires_typed_loader");
}
