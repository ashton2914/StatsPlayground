import {readFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
if(!process.env.STATSPG_PERSISTENCE_HARNESS||!existsSync(process.env.STATSPG_PERSISTENCE_HARNESS))throw Error('Build project_persistence_contract with project-v5,perf-harness and provide STATSPG_PERSISTENCE_HARNESS; native persistence checks are required');
const suites=JSON.parse(readFileSync(new URL('./projectPersistenceSuites.json',import.meta.url),'utf8'));
function run(args){const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:process.env});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
for(const path of suites.contracts){console.log(`Project contract: ${path}`);run(['node_modules/tsx/dist/cli.mjs','--tsconfig','tsconfig.app.json',path]);}
run(['node_modules/@playwright/test/cli.js','test','-c','playwright-ct.config.ts',...suites.ui,'--workers=1']);
