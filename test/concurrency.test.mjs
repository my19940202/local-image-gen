import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createApp} from '../src/server.mjs';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('双并发有上限，幂等提交不会重复生图，参考图与画幅传入生成器',async()=>{
 const outputDir=await mkdtemp(join(tmpdir(),'image-concurrency-'));let running=0,max=0,calls=[];let release;const gate=new Promise(r=>release=r);
 const server=createApp({outputDir,concurrency:2,generateImage:async job=>{running++;max=Math.max(max,running);calls.push(job);await gate;await writeFile(job.file,PNG);running--;}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const post=body=>fetch(base+'/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const get=id=>fetch(base+'/api/jobs/'+id).then(r=>r.json());
 try{
   const body={prompt:'测试',idempotency_key:'same',aspect_ratio:'9:16'};
   const a=await(await post(body)).json();const duplicate=await(await post(body)).json();assert.equal(a.id,duplicate.id);
   assert.equal((await post({...body,prompt:'不同'})).status,409);
   const b=await(await post({prompt:'第二张'})).json(),c=await(await post({prompt:'第三张'})).json();
   for(let i=0;i<50&&calls.length<2;i++)await wait(10);
   assert.equal(calls.length,2);assert.equal((await get(c.id)).status,'pending');release();
   for(let i=0;i<100&&(await get(c.id)).status!=='done';i++)await wait(10);
   assert.equal(max,2);assert.equal(calls[0].aspectRatio,'9:16');
   const ref=await(await post({prompt:'参考样稿',reference_ids:[a.id]})).json();
   for(let i=0;i<100&&(await get(ref.id)).status!=='done';i++)await wait(10);
   assert.deepEqual(calls[3].references,[join(outputDir,`${a.id}.png`)]);assert.equal(typeof (await get(b.id)).queue_ms,'number');
   assert.equal((await post({prompt:'a'.repeat(4201)})).status,400);assert.equal((await post({prompt:'test',aspect_ratio:'bad'})).status,400);
 }finally{release();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(outputDir,{recursive:true,force:true});}
});
test('两个车道各自不超过上限，第五个任务继续排队',async()=>{
 const outputDir=await mkdtemp(join(tmpdir(),'image-lanes-'));let release;const gate=new Promise(r=>release=r);
 const counts=[0,0],maxes=[0,0];let running=0,maxRunning=0;
 const workers=[0,1].map(index=>async job=>{counts[index]++;maxes[index]=Math.max(maxes[index],counts[index]);running++;maxRunning=Math.max(maxRunning,running);await gate;await writeFile(job.file,PNG);counts[index]--;running--;});
 const server=createApp({outputDir,concurrency:2,workers});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const post=body=>fetch(base+'/api/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const get=id=>fetch(base+'/api/jobs/'+id).then(r=>r.json());
 try{
   const ids=[];
   for(let i=0;i<5;i++)ids.push((await(await post({prompt:`图${i}`})).json()).id);
   for(let i=0;i<50&&running<4;i++)await wait(10);
   assert.equal(running,4);assert.deepEqual(counts,[2,2]);assert.equal(maxRunning,4);
   const pending=[];for(const id of ids)if((await get(id)).status==='pending')pending.push(id);
   assert.equal(pending.length,1);release();
   for(const id of ids){for(let i=0;i<100&&(await get(id)).status!=='done';i++)await wait(10);assert.equal((await get(id)).status,'done');}
   assert.deepEqual(maxes,[2,2]);assert.equal(maxRunning,4);
 }finally{release();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(outputDir,{recursive:true,force:true});}
});
