import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'rolldown';
import {mkdtemp,cp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire,isBuiltin} from 'node:module';
const require=createRequire(import.meta.url),sharp=require('sharp');
test('ESM bundled CJS renderer survives repeated imports, licensed assets and all five sport QR codes', {timeout:180000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fmm-poster-bundle-')),prior=process.cwd();
 try{
  // Use the worker's bundler and native external boundaries, not Node CJS alone.
  const file=join(dir,'poster.mjs');
  await build({input:resolve('shared/growth-poster-studio.js'),platform:'node',external:id=>isBuiltin(id)||!id.startsWith('.')&&!id.startsWith('/'),output:{file,format:'esm'}});
  await cp(resolve('../growth-assets'),join(dir,'growth-assets'),{recursive:true});
  // Let the temporary module resolve only the installed isolated worker packages.
  await import('node:fs/promises').then(fs=>fs.symlink(resolve('node_modules'),join(dir,'node_modules'),'dir'));
  process.chdir(dir);const P=(await import(pathToFileURL(file))).default;
  assert.equal(typeof P.renderPoster,'function');
  const outputs=[];
  for(const sport of ['boxing','mma-ufc','bare-knuckle','kickboxing','pro-wrestling']){
   const contest={id:'bundle-fixture-'+sport,sport,fighterA:'Fixture Fighter A',fighterB:'Fixture Fighter B',dateKey:'2026-11-08',contestUrl:'https://www.fantasymmadness.com/fight/bundle-fixture-'+sport};
   const qrUrl=P.qrLink(contest);const r=await P.renderPoster({contest,qrUrl});
   const meta=await sharp(r.buffer).metadata();assert.deepEqual([meta.width,meta.height,meta.format],[1080,1350,'jpeg']);assert.equal((await P.decodeQr(r.buffer)).text,qrUrl);assert.equal(r.facts.sport.length>0,true);outputs.push(sport);
   if(process.env.GROWTH_POSTER_ARTIFACT_DIR){await import('node:fs/promises').then(fs=>fs.mkdir(process.env.GROWTH_POSTER_ARTIFACT_DIR,{recursive:true}));await writeFile(join(process.env.GROWTH_POSTER_ARTIFACT_DIR,sport+'-bundled-fixture.jpg'),r.buffer);}
  }
  assert.equal((await import(pathToFileURL(file))).default.renderPoster,P.renderPoster);assert.equal(outputs.length,5);
 }finally{process.chdir(prior);await rm(dir,{recursive:true,force:true});}
});
