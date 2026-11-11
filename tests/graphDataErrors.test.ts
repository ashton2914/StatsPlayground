import assert from "node:assert/strict";
import i18n from "../src/i18n";
import { createGraphStreamTransport } from "../src/services/graphDataTransport";
import type { GraphDataRequest } from "../src/types/graphData";

await i18n.changeLanguage("en");
const request: GraphDataRequest = { requestId:"numeric-error",datasetId:"sales",generation:0,fields:[],filters:[],elements:[],sampling:{mode:"full"},rawPointBudget:100,viewport:{width:800,height:600} };
function rejected(error:unknown) {
  let message="";
  const transport=createGraphStreamTransport(request,{onHeader:()=>{},onPayload:()=>{},onAggregate:()=>{},onComplete:()=>{},onError:value=>{message=value;}});
  transport.onInvokeRejected(error);
  return message;
}
const message=rejected({code:"graphNumericColumnRequired",column:"Net_Sales",role:"y"});
assert.match(message,/Net_Sales/);
assert.match(message,/numeric/i);
assert.match(message,/clean|convert|column type/i);
for (const error of ["Database error: CAST(Net_Sales AS DOUBLE) dataset_sales _row_id __sp_x",new Error("SELECT * FROM dataset_sales"),{code:"unexpected",message:"SELECT __sp_y"}]) {
  const safe=rejected(error);
  assert.match(safe,/graph|chart/i);
  assert.doesNotMatch(safe,/\bSQL\b|\bSELECT\b|\bCAST\b|dataset_|_row_id|__sp_|\[object Object\]/i);
}
console.log("graph data error boundary passed");
