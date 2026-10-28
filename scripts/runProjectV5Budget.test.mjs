import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const runner=new URL('./runProjectV5Budget.mjs',import.meta.url);
test('incomplete observations fail and retain immutable raw evidence',()=>{
 const directory=mkdtempSync(join(tmpdir(),'project-budget-'));const raw=join(directory,'raw.json'),output=join(directory,'assessment.json');
 const bytes=JSON.stringify({schemaVersion:1,scenario:'catalog',samples:[{backendMs:1,uiReadyMs:null}]});writeFileSync(raw,bytes);
 const result=spawnSync(process.execPath,[runner.pathname,'assess','--report',raw,'--output',output],{encoding:'utf8'});
 assert.equal(result.status,1,result.stderr);assert.equal(readFileSync(raw,'utf8'),bytes);
 const summary=JSON.parse(readFileSync(output,'utf8'));assert.equal(summary.qualified,false);assert.ok(summary.failures.some(message=>message.includes('uiReadyMs')));
});
test('assessment never overwrites a previous report',()=>{
 const directory=mkdtempSync(join(tmpdir(),'project-budget-'));const raw=join(directory,'raw.json'),output=join(directory,'assessment.json');
 writeFileSync(raw,'{}');writeFileSync(output,'retained evidence');
 const result=spawnSync(process.execPath,[runner.pathname,'assess','--report',raw,'--output',output],{encoding:'utf8'});
 assert.equal(result.status,2);assert.equal(readFileSync(output,'utf8'),'retained evidence');assert.match(result.stderr,/exist/i);
});
test('collection rejects a binary from another source tree before seeding data',()=>{
 const directory=mkdtempSync(join(tmpdir(),'project-budget-'));const binary=join(directory,'old-binary'),fixture=join(directory,'fixture.spprj'),output=join(directory,'reports');
 writeFileSync(binary,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const output=args[args.indexOf('--output')+1];fs.writeFileSync(output,JSON.stringify({processId:process.pid,source:{treeHash:'0'.repeat(40)}}));`,{mode:0o755});
 const result=spawnSync(process.execPath,[runner.pathname,'collect','--binary',binary,'--fixture',fixture,'--output',output,'--samples','2'],{encoding:'utf8'});
 assert.equal(result.status,2);assert.match(result.stderr,/source.*fingerprint|source.*tree/i);assert.throws(()=>readFileSync(fixture),/ENOENT/);
});
