import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {projectV5SourceFingerprint} from './projectV5SourceFingerprint.mjs';
const root=resolve(new URL('..',import.meta.url).pathname);
function setup(source=projectV5SourceFingerprint(root),failed=false){
 const directory=mkdtempSync(join(tmpdir(),'project-v5-ui-runner-test-'));
 const executable=(name,body)=>{const path=join(directory,name);writeFileSync(path,`#!${process.execPath}\n${body}`);chmodSync(path,0o700);return path;};
 const harness=executable('harness.mjs',`import{writeFileSync}from'node:fs';const args=process.argv.slice(2);const get=key=>args[args.indexOf(key)+1];const value={source:{treeHash:${JSON.stringify(source)},profile:'debug'}};if(args.includes('--output'))writeFileSync(get('--output'),JSON.stringify(value));process.stdout.write(JSON.stringify(value));`);
 const app=executable('app.mjs',`import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{join}from'node:path';const config=JSON.parse(readFileSync(process.env.STATSPG_PROJECT_V5_UI_CONFIG));mkdirSync(config.reportRoot);const mode=config.cacheMode??'warm';for(const scenario of mode==='cold'?['catalog']:['catalog','window','scroll','edit','close'])writeFileSync(join(config.reportRoot,scenario+'-'+mode+'.json'),JSON.stringify({schemaVersion:1,scenario,fixture:{id:'host-test',tier:'regular',rows:300000,columns:20,seed:282},source:{},verification:{passed:${!failed}},samples:[{processId:process.pid,verification:{passed:${!failed}}}]}));setInterval(()=>{},1000);`);
 const output=join(directory,'reports'),fixtures=join(directory,'fixtures');
 const run=(coldOpens=0)=>spawnSync(process.execPath,[join(root,'scripts/runProjectV5UiBudget.mjs'),'--harness',harness,'--app',app,'--output',output,'--fixtures',fixtures,'--samples','1','--cases','regular300k','--allow-debug','--cold-opens',String(coldOpens)],{cwd:root,encoding:'utf8',timeout:20000});
 return{output,fixtures,run};
}
test('UI host rejects stale source before creating fixture/report roots',()=>{
 const fixture=setup('0'.repeat(40));const result=fixture.run();assert.equal(result.status,1);assert.match(result.stderr,/source differs/);assert.equal(existsSync(fixture.output),false);assert.equal(existsSync(fixture.fixtures),false);
});
test('UI host retains unqualified smoke reports and never overwrites prior evidence',()=>{
 const fixture=setup();const first=fixture.run();assert.equal(first.status,2,first.stderr);const path=join(fixture.output,'assessment.json');const before=readFileSync(path);assert.equal(JSON.parse(before).qualified,false);const second=fixture.run();assert.equal(second.status,1);assert.deepEqual(readFileSync(path),before);
});
test('UI host preserves failed native samples and stops the qualification run',()=>{
 const fixture=setup(undefined,true);const result=fixture.run();assert.equal(result.status,1);assert.match(result.stderr,/logical verification failed/);assert.equal(existsSync(join(fixture.output,'regular300k','edit-warm.json')),true);assert.equal(existsSync(join(fixture.output,'assessment.json')),false);
});

test('UI host aggregates cold catalog samples from independent owned processes before warm edits',()=>{
 const fixture=setup();const result=fixture.run(2);assert.equal(result.status,2,result.stderr);
 const report=JSON.parse(readFileSync(join(fixture.output,'regular300k-catalog-cold.json'),'utf8'));
 assert.equal(report.samples.length,2);assert.equal(new Set(report.samples.map(sample=>sample.processId)).size,2);
 const config=JSON.parse(readFileSync(join(fixture.output,'regular300k-cold-1-configuration.json'),'utf8'));assert.equal(config.cacheMode,'cold');assert.equal(config.samples,1);
});
