import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
for(const entry of ['projectService','ioService','store']) {
 const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','--tsconfig','tsconfig.app.json','tests/fixtures/project-service-import-order.ts',entry],{encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,`${entry} must initialize in a fresh process: ${result.stderr}`);
}
console.log('project service import order: service, IO and store entrypoints initialize and default operations remain usable');
