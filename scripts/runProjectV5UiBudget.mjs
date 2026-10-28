import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {projectV5SourceFingerprint} from './projectV5SourceFingerprint.mjs';
import {assessProjectV5Report,evaluateProjectV5Budget} from './projectV5BudgetCore.mjs';

// This launches only the explicitly built benchmark executable against owned fixtures.
// It does not install an app, purge the system cache, or touch normal project data.
const options=new Map();const flags=new Set(['--allow-debug']);
for(let index=2;index<process.argv.length;index++){
 const key=process.argv[index];if(!['--harness','--app','--output','--fixtures','--samples','--cases','--cold-opens',...flags].includes(key)||options.has(key))throw Error(`Invalid/duplicate option ${key}`);
 options.set(key,flags.has(key)?true:process.argv[++index]);
}
const required=key=>{const value=options.get(key);if(typeof value!=='string'||!isAbsolute(value))throw Error(`${key} requires an absolute path`);return value;};
const harness=required('--harness'),app=required('--app'),output=required('--output'),fixtures=required('--fixtures');
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const samples=Number(options.get('--samples')??100);if(!Number.isSafeInteger(samples)||samples<1||samples>1000)throw Error('Invalid sample count');
const coldOpens=Number(options.get('--cold-opens')??5);if(!Number.isSafeInteger(coldOpens)||coldOpens<0||coldOpens>100)throw Error('Invalid cold open count');
const cases={regular300k:{rows:300000,tier:'regular'},regular2m:{rows:2000000,tier:'regular'},regular10m:{rows:10000000,tier:'regular'},many:{rows:300000,tier:'many-documents'},long:{rows:300000,tier:'long-strings'}};
const selected=String(options.get('--cases')??Object.keys(cases).join(',')).split(',');
if(new Set(selected).size!==selected.length||selected.some(key=>!cases[key]))throw Error('Unknown/duplicate fixture case');
const source=projectV5SourceFingerprint(root);
const provenance=JSON.parse(execFileSync(harness,['--scenario','provenance','--path',fixtures],{encoding:'utf8',maxBuffer:1024*1024}));
if(provenance.source.treeHash!==source)throw Error('Harness source differs; rebuild frozen source');
if(provenance.source.profile!=='release'&&!options.has('--allow-debug'))throw Error('Release build required (explicit --allow-debug is unqualified smoke only)');
mkdirSync(output);mkdirSync(fixtures); // Exclusive roots: preserve all earlier evidence.
const publish=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const frozen=()=>{if(projectV5SourceFingerprint(root)!==source)throw Error('Source changed during benchmark');};
const scenarios=['catalog','window','scroll','edit','close'];const reports=[];
async function childProbe(args,log){
 const fd=openSync(log,'wx');try{
  await new Promise((resolve,reject)=>{const child=spawn(harness,args,{stdio:['ignore',fd,fd]});const timer=setTimeout(()=>child.kill('SIGKILL'),30*60*1000);timer.unref();child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Fixture probe failed (${code}); see ${log}`));});});
 }finally{closeSync(fd);}frozen();
}
async function runNative(name,fixture,profile,tier,cacheMode,count){
 const reportRoot=join(output,name),configPath=join(output,`${name}-configuration.json`);
 const measured=cacheMode==='cold'?['catalog']:scenarios;
 publish(configPath,{fixturePath:fixture,profilePath:profile,reportRoot,sourceTreeHash:source,tier,samples:count,cacheMode});
 const fd=openSync(join(output,`${name}-app.log`),'wx');const child=spawn(app,[],{stdio:['ignore',fd,fd],env:{...process.env,STATSPG_PROJECT_V5_UI_CONFIG:configPath}});let launchError;child.on('error',error=>{launchError=error;});
 const started=Date.now();const collected=[];
 try{
  console.log(`Measuring ${name}/${cacheMode}; keep its native window visible`);
  while(!measured.every(scenario=>existsSync(join(reportRoot,`${scenario}-${cacheMode}.json`)))){
   if(launchError)throw launchError;
   if(child.exitCode!==null||child.signalCode!==null)throw Error(`Benchmark exited before reports for ${name}`);
   if(Date.now()-started>20*60*1000)throw Error(`Native UI run timed out for ${name}`);
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  for(const scenario of measured){
   const path=join(reportRoot,`${scenario}-${cacheMode}.json`);let report;
   for(let retry=0;retry<40;retry++){
    try{report=JSON.parse(readFileSync(path,'utf8'));break;}catch(error){if(retry===39)throw error;await new Promise(resolve=>setTimeout(resolve,100));}
   }
   collected.push(report);publish(join(output,`${name}-${scenario}-assessment.json`),assessProjectV5Report(report));
  }
  frozen();
  if(collected.some(report=>report.verification.passed!==true||report.samples.length!==count))throw Error(`Native UI logical verification failed for ${name}; ${collected.find(report=>typeof report.runError==='string')?.runError??'raw partial reports preserved'}`);
  return collected;
 }finally{
  // Terminate only this runner's own process. Successful samples closed the
  // project; failed fixtures retain WAL/recovery evidence on disk.
  if(child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM');await new Promise(resolve=>{
    const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');resolve();},5000);
    child.once('exit',()=>{clearTimeout(timer);resolve();});
   });
  }
  closeSync(fd);
 }
}
for(const name of selected){
 const fixture=join(fixtures,`${name}.spprj`),profile=join(output,`${name}-profile.json`);
 const config=cases[name];console.log(`Preparing ${name}: ${config.rows} × 20`);
 await childProbe(['--scenario','seed','--path',fixture,'--rows',String(config.rows),'--columns','20','--tier',config.tier,'--output',join(output,`${name}-seed.json`)],join(output,`${name}-seed.log`));
 await childProbe(['--scenario','profile','--path',fixture,'--output',profile],join(output,`${name}-profile.log`));
 // Cold directory-only processes precede edits so the seeded fixture/profile
 // identity and committed revision stay unchanged for every cold process.
 if(config.tier==='regular'&&coldOpens>0){
  const cold=[];
  for(let index=0;index<coldOpens;index++)cold.push(...await runNative(`${name}-cold-${index+1}`,fixture,profile,config.tier,'cold',1));
  const aggregate={...cold[0],samples:cold.flatMap(report=>report.samples),verification:{passed:cold.every(report=>report.verification.passed===true)}};
  publish(join(output,`${name}-catalog-cold.json`),aggregate);reports.push(aggregate);
 }
 reports.push(...await runNative(name,fixture,profile,config.tier,'warm',samples));
}
const assessment=evaluateProjectV5Budget(reports);publish(join(output,'assessment.json'),assessment);
console.log(JSON.stringify({source,output,qualified:assessment.qualified,failures:assessment.failures.length}));
if(!assessment.qualified)process.exitCode=2; // Warm-only and smoke runs remain unqualified.
