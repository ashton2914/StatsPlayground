import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {projectV5SourceFingerprint} from './projectV5SourceFingerprint.mjs';
import {evaluateProjectV5Budget} from './projectV5BudgetCore.mjs';
function immutableJson(path,value){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});}
function parse(args){
 const mode=args.shift();if(!['assess','collect'].includes(mode))throw Error('Use assess or collect');
 const fields=new Map(),reports=[];
 while(args.length){const key=args.shift(),value=args.shift();if(!key?.startsWith('--')||value===undefined)throw Error('Each option needs a value');if(key==='--report'){reports.push(value);continue;}if(fields.has(key))throw Error(`Duplicate ${key}`);fields.set(key,value);}
 const allowed=mode==='assess'?['--output']:['--binary','--fixture','--output','--rows','--columns','--seed','--samples'];
 for(const key of fields.keys())if(!allowed.includes(key))throw Error(`Unknown ${key}`);
 const required=key=>{if(!fields.has(key))throw Error(`Required ${key}`);return fields.get(key);};
 return {mode,fields,reports,required};
}
export function runProjectV5Budget(args){
 const {mode,fields,reports,required}=parse([...args]);const output=resolve(required('--output'));
 if(existsSync(output))throw Error(`Output already exists: ${output}`);
 if(mode==='assess'){
  if(reports.length===0)throw Error('At least one --report is required');
  const result=evaluateProjectV5Budget(reports.map(path=>JSON.parse(readFileSync(path,'utf8'))));
  immutableJson(output,{...result,rawReports:reports.map(path=>resolve(path))});
  return result.qualified?0:1;
 }
 if(reports.length)throw Error('--report is only valid for assess');
 const binary=resolve(required('--binary')),fixture=resolve(required('--fixture'));
 const number=(key,fallback)=>{const value=Number(fields.get(key)??fallback);if(!Number.isSafeInteger(value)||value<1)throw Error(`Invalid ${key}`);return String(value);};
 const rows=number('--rows',300000),columns=number('--columns',20),seed=number('--seed',282),samples=number('--samples',100);
 const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
 const frozenHash=projectV5SourceFingerprint(sourceRoot);
 mkdirSync(output,{recursive:false});
 immutableJson(join(output,'invocation.json'),{binary,fixture,rows:Number(rows),columns:Number(columns),seed:Number(seed),samples:Number(samples),sourceTreeHash:frozenHash,startedAt:new Date().toISOString(),scope:'native backend only; UI readiness, cold OS cache and checkpoint-write observations unavailable'});
 function invoke(scenario,extra=[]){
  const raw=join(output,`${scenario}.json`);
  const result=spawnSync(binary,['--scenario',scenario,'--path',fixture,'--output',raw,...extra],{encoding:'utf8',timeout:30*60*1000,maxBuffer:32*1024*1024});
  immutableJson(join(output,`${scenario}-process.json`),{status:result.status,signal:result.signal,error:result.error?.message??null,stderr:result.stderr??'',stdout:result.stdout??''});
  if(result.error||result.status!==0)throw Error(`Native ${scenario} failed; raw process evidence retained in ${output}`);
  const report=JSON.parse(readFileSync(raw,'utf8'));
  if(projectV5SourceFingerprint(sourceRoot)!==frozenHash)throw Error('Source tree changed during collection; retain this run as failed');
  if(report.source?.treeHash!==frozenHash)throw Error('Binary source fingerprint differs from current source tree; rebuild before collecting');
  return report;
 }
 // A fresh fixture is deliberate: reused edited fixtures would change expected state.
 if(existsSync(fixture))throw Error('Collection refuses an existing fixture; choose a new path');
 invoke('provenance');
 invoke('seed',['--rows',rows,'--columns',columns,'--seed',seed]);
 const nativeReports=[];
 for(const scenario of ['catalog','window','scroll','edit','close'])nativeReports.push(invoke(scenario,['--samples',samples]));
 const result=evaluateProjectV5Budget(nativeReports);
 immutableJson(join(output,'assessment.json'),result);
 return result.qualified?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{process.exitCode=runProjectV5Budget(process.argv.slice(2));}
 catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=2;}
}
