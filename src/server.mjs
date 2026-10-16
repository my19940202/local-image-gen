import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectPng } from './png.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = fileURLToPath(new URL('../public/index.html', import.meta.url));

function sendJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('请求必须是 JSON'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) {
      throw Object.assign(new Error('请求内容过大'), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式无效'), { status: 400 });
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    image_url: job.status === 'done' ? `/api/jobs/${job.id}/image` : null,
    width: job.width,
    height: job.height,
    created_at: job.createdAt,
  };
}

export function createApp({ outputDir, generateImage }) {
  const jobs = new Map();
  const queue = [];
  let processing = false;

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const job = jobs.get(queue.shift());
        if (!job) continue;
        job.status = 'running';
        const file = path.join(outputDir, `${job.id}.png`);
        try {
          await mkdir(outputDir, { recursive: true });
          await generateImage({ prompt: job.prompt, file, outputDir });
          const image = await inspectPng(file);
          job.status = 'done';
          job.width = image.width;
          job.height = image.height;
        } catch (error) {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          await rm(file, { force: true }).catch(() => {});
          console.error(`Job ${job.id} failed: ${job.error}`);
        }
      }
    } finally {
      processing = false;
    }
  }

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && pathname === '/') {
        const page = await readFile(PAGE);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(page);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/jobs') {
        const body = await readJson(req);
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt || prompt.length > 1000) {
          sendJson(res, 400, { error: '提示词须为 1–1000 个字符' });
          return;
        }
        const id = randomUUID();
        const job = {
          id, prompt, status: 'pending', error: null,
          width: null, height: null, createdAt: Date.now(),
        };
        jobs.set(id, job);
        queue.push(id);
        sendJson(res, 201, publicJob(job));
        setImmediate(() => void drain());
        return;
      }

      const match = pathname.match(/^\/api\/jobs\/([^/]+)(\/image)?$/);
      if (req.method === 'GET' && match && UUID.test(match[1])) {
        const job = jobs.get(match[1]);
        if (!job) {
          sendJson(res, 404, { error: '任务不存在' });
          return;
        }
        if (!match[2]) {
          sendJson(res, 200, publicJob(job));
          return;
        }
        if (job.status !== 'done') {
          sendJson(res, 404, { error: '图片尚未生成' });
          return;
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        const stream = createReadStream(path.join(outputDir, `${job.id}.png`));
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }

      sendJson(res, 404, { error: '接口不存在' });
    } catch (error) {
      sendJson(res, error.status ?? 500, { error: error.status ? error.message : '服务内部错误' });
      if (!error.status) console.error(error);
    }
  });

  return server;
}
