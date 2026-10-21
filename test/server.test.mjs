import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/server.mjs';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==',
  'base64',
);

async function waitFor(getJob, expected) {
  for (let i = 0; i < 50; i++) {
    const job = await getJob();
    if (job.status === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`任务没有进入 ${expected} 状态`);
}

test('本地 API 串行生图并返回状态与 PNG；错误可见', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'imagegen-test-'));
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const server = createApp({
    outputDir,
    generateImage: async ({ prompt, file }) => {
      calls++;
      if (prompt === '失败') throw new Error('模拟生图失败');
      if (prompt === '第一张') await firstGate;
      await writeFile(file, PNG);
    },
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (prompt) => fetch(`${base}/api/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  const get = async (id) => (await fetch(`${base}/api/jobs/${id}`)).json();

  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /历史记录/);

    const firstResponse = await post('第一张');
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    await waitFor(() => get(first.id), 'running');

    const second = await (await post('第二张')).json();
    assert.equal((await get(second.id)).status, 'pending');
    assert.equal(calls, 1);
    releaseFirst();

    const done = await waitFor(() => get(first.id), 'done');
    assert.deepEqual([done.width, done.height], [1, 1]);
    await waitFor(() => get(second.id), 'done');
    const image = await fetch(`${base}${done.image_url}`);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

    const failed = await (await post('失败')).json();
    const failedJob = await waitFor(() => get(failed.id), 'failed');
    assert.match(failedJob.error, /模拟生图失败/);
    assert.equal(typeof failedJob.duration_ms, 'number');
    assert.equal(typeof (await get(first.id)).duration_ms, 'number');
    const history = await (await fetch(`${base}/api/jobs`)).json();
    assert.deepEqual(history.jobs.map((job) => job.id), [failed.id, second.id, first.id]);
    assert.equal(history.jobs[0].prompt, '失败');
    assert.equal((await post('  ')).status, 400);
  } finally {
    releaseFirst();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('生成耗时会保留到重启之后，旧图片也会出现在历史里', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'imagegen-test-'));
  const legacyId = '11111111-1111-4111-8111-111111111111';
  await writeFile(path.join(outputDir, `${legacyId}.png`), PNG);

  const start = async () => {
    const server = createApp({
      outputDir,
      generateImage: async ({ file }) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await writeFile(file, PNG);
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  };

  const server = await start();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const legacy = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(legacy.jobs[0].id, legacyId);
    assert.equal(legacy.jobs[0].prompt, '');
    assert.equal(legacy.jobs[0].duration_ms, null);
    assert.deepEqual([legacy.jobs[0].width, legacy.jobs[0].height], [1, 1]);

    const created = await (await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '一只猫' }),
    })).json();
    const done = await waitFor(async () => (await fetch(`${base}/api/jobs/${created.id}`)).json(), 'done');
    assert.ok(done.duration_ms >= 30);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    const restarted = await start();
    const again = `http://127.0.0.1:${restarted.address().port}`;
    try {
      const history = await (await fetch(`${again}/api/jobs`)).json();
      assert.equal(history.jobs[0].id, created.id);
      assert.equal(history.jobs[0].prompt, '一只猫');
      assert.equal(history.jobs[0].duration_ms, done.duration_ms);
      assert.equal(history.jobs[1].id, legacyId);
      const image = await fetch(`${again}${history.jobs[1].image_url}`);
      assert.equal(image.status, 200);
    } finally {
      restarted.closeAllConnections();
      await new Promise((resolve) => restarted.close(resolve));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('重启时未完成的任务记为失败，且不编造耗时', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'imagegen-test-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = createApp({
    outputDir,
    generateImage: async ({ file }) => {
      await gate;
      await writeFile(file, PNG);
    },
  });
  first.listen(0, '127.0.0.1');
  await once(first, 'listening');
  const base = `http://127.0.0.1:${first.address().port}`;
  let restarted;
  try {
    const created = await (await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '中断' }),
    })).json();
    await waitFor(async () => (await fetch(`${base}/api/jobs/${created.id}`)).json(), 'running');

    restarted = createApp({
      outputDir,
      generateImage: async () => { throw new Error('不应再次执行'); },
    });
    restarted.listen(0, '127.0.0.1');
    await once(restarted, 'listening');
    const job = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/jobs/${created.id}`)).json();
    assert.equal(job.status, 'failed');
    assert.match(job.error, /服务重启/);
    assert.equal(job.duration_ms, null);
  } finally {
    release();
    for (let i = 0; i < 50; i++) {
      const jobs = await fetch(`${base}/api/jobs`).then((response) => response.json()).catch(() => null);
      if (jobs?.jobs?.[0]?.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    first.closeAllConnections();
    restarted?.closeAllConnections();
    await new Promise((resolve) => first.close(resolve));
    if (restarted) await new Promise((resolve) => restarted.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  }
});
