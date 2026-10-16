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
    assert.match(await page.text(), /本地生图/);

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
    assert.match((await waitFor(() => get(failed.id), 'failed')).error, /模拟生图失败/);
    assert.equal((await post('  ')).status, 400);
  } finally {
    releaseFirst();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(outputDir, { recursive: true, force: true });
  }
});
