import assert from "node:assert/strict";
import {createViewportBudget} from "../src/projectPersistence/viewportBudget.ts";
const evicted:string[]=[];
const budget=createViewportBudget({maxRows:5000,maxBytes:67108864,maxRetainedViewports:2});
for(let index=0;index<100;index++) {
 const id=`table-${index}`;budget.acquire(id,()=>evicted.push(id));
 assert.equal(budget.update(id,{rows:5000,bytes:67108864}),true);
 const state=budget.snapshot();assert.ok(state.retainedViewports<=2);assert.ok(state.rows<=10000);assert.ok(state.bytes<=134217728);
 budget.release(id);
 assert.ok(budget.snapshot().registeredViewports<=2,"evicted inactive viewports must release callbacks and cached component references");
}
assert.equal(evicted.length,98);
assert.deepEqual(budget.snapshot().ids,["table-98","table-99"]);
budget.acquire("table-98");budget.acquire("new");
assert.ok(budget.snapshot().ids.includes("table-98"),"active viewports take priority over inactive LRU entries");
assert.ok(!budget.snapshot().ids.includes("table-99"));
assert.equal(budget.update("new",{rows:5001,bytes:1}),false);
assert.ok(!budget.snapshot().ids.includes("new"));
budget.forget("table-98");assert.equal(budget.snapshot().retainedViewports,0);
budget.acquire("oversize",()=>evicted.push("oversize"));assert.equal(budget.update("oversize",{rows:1,bytes:67108865}),false);
budget.acquire("reset",()=>evicted.push("reset"));budget.update("reset",{rows:1,bytes:10});budget.reset();assert.equal(budget.snapshot().rows,0);assert.ok(evicted.includes("reset"));
assert.throws(()=>budget.update("invalid",{rows:-1,bytes:0}),/budget/);
console.log("viewport budget: 100 switches, aggregate caps, active preference, byte rejection and disposal passed");
