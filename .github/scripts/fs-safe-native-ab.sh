#!/usr/bin/env bash
set -euo pipefail
proof_root=/tmp/oc-bump-0212-native-hook-ab-evidence
mkdir -p "$proof_root"
git diff --quiet
git diff --cached --quiet
expected_head=bdf943d544a28efd560c5939548f5e075f65be7b
test_file=extensions/qa-lab/src/codex-native-hook-pressure.e2e.test.ts
export OPENCLAW_E2E_USE_PREBUILT_DIST=1 OPENCLAW_CI_TEST_RUNTIME_POLICY=bun-compatible OPENCLAW_VITEST_MAX_WORKERS=3 NODE_OPTIONS=--max-old-space-size=8192
snapshot() {
  node --input-type=module - "$1" "$2" "$proof_root" <<'SNAPSHOT'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {getFsSafeNativeConfig} from '@openclaw/fs-safe/config';
const [variant,expected,dir]=process.argv.slice(2);
const req=createRequire(path.join(process.cwd(),'package.json'));
let root=path.dirname(req.resolve('@openclaw/fs-safe'));
while(!fs.existsSync(path.join(root,'package.json'))||JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).name!=='@openclaw/fs-safe') {
 const parent=path.dirname(root); assert.notEqual(parent,root,'fs-safe manifest not found'); root=parent;
}
const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
assert.equal(manifest.version,expected);
const read=(file)=>{try{return fs.readFileSync(file,'utf8').trim()}catch{return null}};
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(head,'bdf943d544a28efd560c5939548f5e075f65be7b');
const testFile='extensions/qa-lab/src/codex-native-hook-pressure.e2e.test.ts';
const record={variant,sourceHead:head,fsSafe:manifest.version,fsSafePath:root,native:getFsSafeNativeConfig(),node:process.version,kernel:os.release(),platform:os.platform(),architecture:os.arch(),osRelease:read('/etc/os-release'),hostPolicy:Object.fromEntries(['/proc/sys/kernel/unprivileged_userns_clone','/proc/sys/kernel/apparmor_restrict_unprivileged_userns','/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined','/proc/sys/user/max_user_namespaces'].map(p=>[p,read(p)])),processPolicy:read('/proc/self/status')?.split('\n').filter(x=>/^(Seccomp|NoNewPrivs):/.test(x)),env:Object.fromEntries(['FS_SAFE_NATIVE_MODE','OPENCLAW_FS_SAFE_NATIVE_MODE','OPENCLAW_E2E_USE_PREBUILT_DIST','OPENCLAW_CI_TEST_RUNTIME_POLICY','OPENCLAW_VITEST_MAX_WORKERS','NODE_OPTIONS'].map(k=>[k,process.env[k]??null])),sandbox:'workspace-write',testSha256:createHash('sha256').update(fs.readFileSync(testFile)).digest('hex'),command:['node','scripts/run-vitest.mjs','run','--config','test/vitest/vitest.e2e.config.ts',testFile]};
fs.writeFileSync(path.join(dir,variant+'-environment.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify(record));
SNAPSHOT
}
run_variant() {
  local variant="$1" version="$2"
  printf 'CRABBOX_PHASE:%s-build\n' "$variant"
  snapshot "$variant" "$version"
  pnpm clean:dist > "$proof_root/$variant-build.log" 2>&1
  OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build:ci-artifacts >> "$proof_root/$variant-build.log" 2>&1
  printf 'CRABBOX_PHASE:%s-test\n' "$variant"
  local started="$SECONDS" result=0
  node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts "$test_file" > "$proof_root/$variant-test.log" 2>&1 || result=$?
  local elapsed=$((SECONDS-started))
  printf '{"variant":"%s","fsSafe":"%s","testExit":%s,"elapsedSeconds":%s,"sourceHead":"%s"}\n' "$variant" "$version" "$result" "$elapsed" "$expected_head" > "$proof_root/$variant-receipt.json"
  cat "$proof_root/$variant-receipt.json"
  tail -140 "$proof_root/$variant-test.log"
}
run_variant A 0.21.2
printf 'CRABBOX_PHASE:B-dependency-switch\n'
node --input-type=module - "$proof_root" <<'SWITCH'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseAllDocuments} from 'yaml';
const dir=process.argv[2];
const parse=(text)=>parseAllDocuments(text).map(doc=>{assert.equal(doc.errors.length,0,doc.errors.join('\n'));return doc.toJSON()});
const isFs=(v)=>typeof v==='string'&&/^@openclaw\/fs-safe(?:-|@|$)/.test(v);
const clean=(v)=>Array.isArray(v)?v.filter(x=>!isFs(x)).map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!isFs(k)).map(([k,x])=>[k,clean(x)])):v;
const files=execFileSync('git',['diff','--name-only','HEAD^','HEAD','--','package.json','**/package.json','pnpm-lock.yaml','pnpm-workspace.yaml'],{encoding:'utf8'}).trim().split('\n');
assert(files.includes('pnpm-lock.yaml')&&files.includes('package.json'));
for(const file of files){
 const a=fs.readFileSync(file,'utf8');
 const b=execFileSync('git',['show',`HEAD^:${file}`],{encoding:'utf8'});
 assert.deepEqual(clean(parse(a)),clean(parse(b)),`unrelated dependency difference: ${file}`);
 fs.mkdirSync(path.join(dir,'A-dependencies',path.dirname(file)),{recursive:true});
 fs.writeFileSync(path.join(dir,'A-dependencies',file),a);
 fs.writeFileSync(file,b);
}
fs.writeFileSync(path.join(dir,'dependency-files.json'),JSON.stringify(files,null,2)+'\n');
console.log(JSON.stringify({dependencyFiles:files,unrelatedDependenciesUnchanged:true}));
SWITCH
pnpm install --lockfile-only --ignore-scripts > "$proof_root/B-lock-reconcile.log" 2>&1
pnpm install --frozen-lockfile > "$proof_root/B-install.log" 2>&1
node --input-type=module - "$proof_root" <<'VERIFY'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseAllDocuments} from 'yaml';
const dir=process.argv[2];
const parse=(text)=>parseAllDocuments(text).map(doc=>{assert.equal(doc.errors.length,0,doc.errors.join('\n'));return doc.toJSON()});
const isFs=(v)=>typeof v==='string'&&/^@openclaw\/fs-safe(?:-|@|$)/.test(v);
const clean=(v)=>Array.isArray(v)?v.filter(x=>!isFs(x)).map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!isFs(k)).map(([k,x])=>[k,clean(x)])):v;
for(const file of JSON.parse(fs.readFileSync(path.join(dir,'dependency-files.json'),'utf8'))){
 assert.deepEqual(clean(parse(fs.readFileSync(path.join(dir,'A-dependencies',file),'utf8'))),clean(parse(fs.readFileSync(file,'utf8'))),`pnpm changed unrelated dependencies in ${file}`);
}
assert.equal(JSON.parse(fs.readFileSync('package.json','utf8')).dependencies['@openclaw/fs-safe'],'0.21.1');
fs.writeFileSync(path.join(dir,'B-dependency-verification.json'),JSON.stringify({sourceHead:'bdf943d544a28efd560c5939548f5e075f65be7b',unrelatedDependenciesUnchanged:true,fsSafe:'0.21.1'},null,2)+'\n');
VERIFY
git diff --stat > "$proof_root/B-working-diff.txt"
run_variant B 0.21.1
node --input-type=module - "$proof_root" <<'COMPARE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const dir=process.argv[2];
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
const a=read('A-environment.json'),b=read('B-environment.json');
for(const key of ['sourceHead','node','kernel','platform','architecture','osRelease','hostPolicy','processPolicy','env','sandbox','testSha256']) assert.deepEqual(a[key],b[key],`environment changed: ${key}`);
assert.equal(a.native.mode,b.native.mode,'native mode changed');
const results=['A','B'].map(v=>read(v+'-receipt.json'));
for(const variant of ['A','B']){
 const log=fs.readFileSync(path.join(dir,variant+'-test.log'),'utf8').replace(/\x1b\[[0-9;]*m/g,'');
 const lines=log.split('\n').filter(x=>x.includes('NATIVE_HOOK_TOOL_RESULT')||x.includes('NATIVE_HOOK_PRESSURE_FAILURE')||/bwrap|bubblewrap|Process exited with code|helper-unavailable|helper-failed/.test(x));
 fs.writeFileSync(path.join(dir,variant+'-native-child-evidence.log'),lines.join('\n')+'\n');
}
const report={sameHead:true,sameEnvironment:true,results,assessment:results.every(r=>r.testExit===0)?'does-not-reproduce':'inspect both native-child stderr records; nonzero test exits are retained'};
fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
process.exit(results.some(r=>r.testExit!==0)?1:0);
COMPARE
