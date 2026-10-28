// Regenerate the native compatibility fixture from current frontend document constructors.
import {writeFileSync} from "node:fs";
import {nativeGraphWorkflowFixture} from "../nativeWorkflowFixture";
import {createDefaultGraph2DState,createDefaultGraph3DState,createDefaultMultivariateGraphState} from "../../src/components/graphBuilder/graphBuilderMode";
import {useGraphBuilderNewStore} from "../../src/stores/useGraphBuilderNewStore";
import {useProjectStore} from "../../src/stores/useProjectStore";
useProjectStore.setState({readOnly:false});
const store=useGraphBuilderNewStore;store.getState().open("table",0);
const graphNew={...store.getState().items[0],id:"graph-new",name:"Layered chart",layers:store.getState().items[0].layers.map((layer,index)=>({...layer,id:`layer-${index}`}))};
const workflow=nativeGraphWorkflowFixture("workflow");
const fixture={
 graphBuilders:[{id:"graph",name:"Legacy chart",sourceDatasetId:"table",mode:"2d",modeStates:{twoD:createDefaultGraph2DState(),threeD:createDefaultGraph3DState(),multivariate:createDefaultMultivariateGraphState()},sampling:{mode:"full"},createdAt:"2026-01-01"}],
 graphBuildersNew:[graphNew],graphNewFolders:{"graph-new":"Charts"},graphFolders:{graph:"Charts"},
 reports:[{id:"report",name:"Report",schemaVersion:1,markdown:"# Kept report",createdAt:"2026-01-01",updatedAt:"2026-01-01"}],reportFolders:{report:"Reports"},
 tabulates:[{id:"tabulate",name:"Summary",sourceDatasetId:"table",rowFields:[],columnFields:[],statistics:[{id:"mean",field:"value",kind:"mean"}],includeRowTotals:true,includeColumnTotals:false,createdAt:"2026-01-01"}],tabulateFolders:{tabulate:"Reports"},
 workflows:[workflow],logicalFolders:[{id:"logical-root",name:"Workflow runs",kind:"project"}],
 workflowRuns:[{id:"saved-run",workflowId:"workflow",workflowRevision:1,status:"succeeded",startedAt:"2026-01-01",completedAt:"2026-01-02",inputBindings:[{slotId:"input-source",tableDocumentId:"table"}],nodeResults:[],outputBindings:[{declarationId:"output-graph",artifactDocumentId:"graph"}],errors:[],parentFolderId:"logical-root",inputFingerprints:[],outputFingerprints:[]}],
 tableTransforms:[{id:"transform",name:"Concatenate",formatVersion:"1",revision:1,operation:{kind:"concatenate",sourceCount:2},inputSlots:["source-1","source-2"].map(role=>({role,schemaContract:{schemaFingerprint:"cbf29ce484222325",columns:[]}})),output:{tableDocumentId:"output",name:"Output"}}],
 tableTransformBindings:[{definitionId:"transform",definitionRevision:1,inputs:[{role:"source-1",tableDocumentId:"table"},{role:"source-2",tableDocumentId:"table"}],outputGeneration:0}],
 folders:["Charts","Reports","Empty/Nested"],tableFolders:{table:"",output:""},
 datasetFilters:{table:[{id:"filter",op:"AND",rule:{kind:"continuous",field:{name:"value",type:"continuous"},min:0,max:10}}]},
 history:[],snapshots:[],
};
writeFileSync(new URL("./project-migration-domains.json",import.meta.url),JSON.stringify(fixture,null,2)+"\n");
store.getState().reset();
