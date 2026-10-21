import { createReadStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectPng, inspectPngSync } from './png.mjs';

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

function durationMs(job) {
  if (typeof job.startedAt !== 'number' || typeof job.finishedAt !== 'number') return null;
  return Math.max(0, job.finishedAt - job.startedAt);
}

function publicJob(job) {
  return {
    id: job.id,
    prompt: job.prompt,
    status: job.status,
    error: job.error,
    image_url: job.status === 'done' ? `/api/jobs/${job.id}/image` : null,
    width: job.width,
    height: job.height,
    created_at: job.createdAt ?? null,
    started_at: job.startedAt ?? null,
    finished_at: job.finishedAt ?? null,
    duration_ms: durationMs(job),
  };
}

export function createApp({ outputDir, generateImage }) {
  const jobs = new Map();
  const queue = [];
  let processing = false;
  const jobsFile = path.join(outputDir, 'jobs.json');

  function saveJobs() {
    try {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(jobsFile, JSON.stringify([...jobs.values()], null, 2));
    } catch (error) {
      console.error(`无法保存历史记录：${error.message}`);
    }
  }

  function remember(job) {
    jobs.set(job.id, job);
    saveJobs();
  }

  function loadJobs() {
    let data;
    try {
      data = JSON.parse(readFileSync(jobsFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`无法读取历史记录：${error.message}`);
      return false;
    }
    if (!Array.isArray(data)) return false;
    let changed = false;
    for (const job of data) {
      if (!job || typeof job !== 'object' || !UUID.test(job.id) || typeof job.prompt !== 'string') continue;
      if (!['pending', 'running', 'done', 'failed'].includes(job.status)) continue;
      if (job.status === 'pending' || job.status === 'running') {
        job.status = 'failed';
        job.error = '服务重启，任务已中断';
        job.finishedAt = null;
        changed = true;
      }
      jobs.set(job.id, {
        id: job.id,
        prompt: job.prompt,
        status: job.status,
        error: typeof job.error === 'string' ? job.error : null,
        width: Number.isInteger(job.width) ? job.width : null,
        height: Number.isInteger(job.height) ? job.height : null,
        createdAt: typeof job.createdAt === 'number' ? job.createdAt : null,
        startedAt: typeof job.startedAt === 'number' ? job.startedAt : null,
        finishedAt: typeof job.finishedAt === 'number' ? job.finishedAt : null,
      });
    }
    return changed;
  }

  function importLegacyImages() {
    let names;
    try {
      names = readdirSync(outputDir);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`无法读取图片目录：${error.message}`);
      return;
    }
    for (const name of names) {
      const match = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.png$/i);
      if (!match || jobs.has(match[1])) continue;
      try {
        const image = inspectPngSync(path.join(outputDir, name));
        jobs.set(match[1], {
          id: match[1],
          prompt: '',
          status: 'done',
          error: null,
          width: image.width,
          height: image.height,
          createdAt: Math.round(image.mtimeMs),
          startedAt: null,
          finishedAt: null,
        });
      } catch (error) {
        console.error(`跳过无法读取的图片 ${name}：${error.message}`);
      }
    }
  }

  if (loadJobs()) saveJobs();
  importLegacyImages();

  function listJobs() {
    return [...jobs.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) {
        const job = jobs.get(queue.shift());
        if (!job) continue;
        job.status = 'running';
        job.startedAt = Date.now();
        saveJobs();
        const file = path.join(outputDir, `${job.id}.png`);
        try {
          await mkdir(outputDir, { recursive: true });
          await generateImage({ prompt: job.prompt, file, outputDir });
          const image = await inspectPng(file);
          job.status = 'done';
          job.width = image.width;
          job.height = image.height;
          job.finishedAt = Date.now();
        } catch (error) {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          job.finishedAt = Date.now();
          await rm(file, { force: true }).catch(() => {});
          console.error(`Job ${job.id} failed: ${job.error}`);
        }
        saveJobs();
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
        if (!prompt || prompt.length > 4200) {
          sendJson(res, 400, { error: '提示词须为 1–1000 个字符' });
          return;
        }
        const id = randomUUID();
        const job = {
          id, prompt, status: 'pending', error: null,
          width: null, height: null, createdAt: Date.now(),
          startedAt: null, finishedAt: null,
        };
        remember(job);
        queue.push(id);
        sendJson(res, 201, publicJob(job));
        setImmediate(() => void drain());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/jobs') {
        sendJson(res, 200, { jobs: listJobs().map(publicJob) });
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
