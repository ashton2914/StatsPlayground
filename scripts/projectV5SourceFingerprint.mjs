import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
const scopes=JSON.parse(readFileSync(new URL('./projectV5SourceScopes.json',import.meta.url),'utf8'));
export function projectV5SourceFingerprint(root){
 const files=execFileSync('git',['--no-pager','-C',root,'ls-files','--cached','--others','--exclude-standard','-z','--',...scopes],{maxBuffer:16*1024*1024}).toString('utf8').split('\0').filter(Boolean);
 const parts=[Buffer.from('StatsPlayground source fingerprint v1\0')];
 for(const path of [...new Set(files)].sort()){
  parts.push(Buffer.from(path+'\0'));let stat;
  try{stat=lstatSync(join(root,path));}catch(error){if(error.code!=='ENOENT')throw error;parts.push(Buffer.from([0]));continue;}
  if(!stat.isFile())throw Error(`Source fingerprint requires a regular file: ${path}`);
  const body=readFileSync(join(root,path)),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(body.length));parts.push(Buffer.from([1]),length,body);
 }
 return execFileSync('git',['--no-pager','-C',root,'hash-object','--stdin'],{input:Buffer.concat(parts),encoding:'utf8'}).trim();
}
