import type {WorkflowDefinition} from "../src/types/workflow";

export function nativeGraphWorkflowFixture(id:string,columnName="value",columnType="DOUBLE"):WorkflowDefinition {
  return {
    id,name:"Native graph workflow",formatVersion:"1",revision:1,
    inputSlots:[{id:"input-source",name:"Source",outputPort:{id:"input-source:output",name:"output",payloadKind:"table"},schemaContract:{schemaFingerprint:"fixture-schema",columns:[{name:columnName,canonicalDuckdbType:columnType,required:true,requiredByOperationIds:["operation-graph"]}]}}],
    operations:[{id:"operation-graph",kind:"graphGeneration",schemaVersion:"1",configuration:{mode:"2d",activeState:{encoding:{x:{name:columnName,type:"continuous"}},multiX:[],multiY:[],elements:[],smootherLambda:0.5},filters:[],sampling:{mode:"full"},groupThemeSlots:{}},inputPorts:[{id:"operation-graph:in",name:"source",payloadKind:"table"}],outputPorts:[{id:"operation-graph:out",name:"result",payloadKind:"graph"}]}],
    edges:[{id:"edge-input",kind:"consumes",source:{nodeId:"input-source",portId:"input-source:output"},target:{nodeId:"operation-graph",portId:"operation-graph:in"}},{id:"edge-output",kind:"produces",source:{nodeId:"operation-graph",portId:"operation-graph:out"},target:{nodeId:"output-graph",portId:"output-graph:input"}}],
    outputDeclarations:[{id:"output-graph",name:"Native workflow graph",inputPort:{id:"output-graph:input",name:"input",payloadKind:"graph"},outputPort:{id:"output-graph:output",name:"output",payloadKind:"graph"},sourceEndpoint:{nodeId:"operation-graph",portId:"operation-graph:out"},artifactKind:"graph"}],
  };
}
