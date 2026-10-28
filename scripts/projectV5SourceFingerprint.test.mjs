import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {projectV5SourceFingerprint} from './projectV5SourceFingerprint.mjs';
test('fingerprint includes uncommitted, untracked and removed source, excluding measurement artifacts',()=>{
 const root=mkdtempSync(join(tmpdir(),'project-source-'));execFileSync('git',['--no-pager','init','-q',root]);mkdirSync(join(root,'src'));writeFileSync(join(root,'src','a.ts'),'original');execFileSync('git',['--no-pager','-C',root,'add','src']);
 const initial=projectV5SourceFingerprint(root);writeFileSync(join(root,'src','a.ts'),'changed');const changed=projectV5SourceFingerprint(root);assert.notEqual(changed,initial);
 writeFileSync(join(root,'src','new.ts'),'untracked');const added=projectV5SourceFingerprint(root);assert.notEqual(added,changed);
 mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs','measurement.json'),'new report');assert.equal(projectV5SourceFingerprint(root),added);
 unlinkSync(join(root,'src','a.ts'));assert.notEqual(projectV5SourceFingerprint(root),added);
 assert.match(initial,/^[a-f0-9]{40}$/);
});
