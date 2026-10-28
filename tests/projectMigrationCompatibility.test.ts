import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {hydrateAnalysisProjectPayload} from "../src/components/analysis/analysisWorkspaceLifecycle.ts";
const fixture=JSON.parse(readFileSync(new URL("./fixtures/project-migration-documents.json",import.meta.url),"utf8"));
assert.deepEqual(hydrateAnalysisProjectPayload(fixture.input),fixture.expected,"the native migration corpus must track the existing frontend compatibility semantics");
console.log("native migration corpus matches current frontend legacy analysis conversion");

for(const variant of ["graph-role","malformed-graph","personality","same-field","collision"]) {
 const input=structuredClone(fixture.input);const item=input.fitYByX[0];
 if(variant==="graph-role")item.graph.modeStates.twoD.encoding.x.name="Wrong field";
 if(variant==="malformed-graph")item.graph={};
 if(variant==="personality")item.personality="invalid";
 if(variant==="same-field")item.response=structuredClone(item.factor);
 if(variant==="collision")input.fitYByX.push(structuredClone(item));
 assert.throws(()=>hydrateAnalysisProjectPayload(input),undefined,`legacy frontend rejects ${variant}`);
}
console.log("legacy Fit Y by X rejects mismatched graph roles, malformed graphs, personality/field errors and identities");
