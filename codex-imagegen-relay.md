# 本地 Codex 生图中继：技术实现文档

> 目标：把图片生成网站的生图请求排进队列，由你本地 Mac 上的 worker 主动领取，调用 Codex 生图后回传结果。
> 第一版原则：简单、能扛慢和离线、不暴露本机到公网。

---

## 1. 总体架构

```
用户浏览器 ──提交 prompt──▶ Cloudflare Worker (API)
                                │
                     D1: jobs 表（任务队列）
                     R2: 图片存储
                                ▲
             轮询领任务 / 回传图片（HTTPS + 密钥）
                                │
                    你的 Mac：worker 脚本 + codex CLI
```

- **拉模式（推荐）**：Mac 主动请求网站接口领任务。不需要公网 IP、不需要 Tunnel，Mac 睡眠或断网时任务只是在队列里等着。
- 网站只负责：收任务、存状态、存图、给前端查询。
- Mac 只负责：领任务、生图、上传结果。

### 1.1 备选：Cloudflare Tunnel（推模式）

原理：Mac 上运行 `cloudflared`，它从本机**主动**向 Cloudflare 建立长连接（出站连接）。外部访问绑定的域名时，Cloudflare 沿这条已建立的连接把请求转发到本机端口（如 `localhost:8787`），响应原路返回。因此不需要公网 IP、不用开路由器端口，也不暴露真实 IP。

不作为第一版的原因：
- Mac 离线时网站请求直接失败；
- 生图耗时长，同步 HTTP 请求容易超时，最终仍需要队列；
- 本地服务直接暴露在域名下，需要额外做鉴权（可用 Cloudflare Access）。

---

## 2. 数据模型（D1）

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,          -- uuid
  user_id       TEXT,                      -- 可选，关联网站用户
  prompt        TEXT NOT NULL,
  size          TEXT DEFAULT '1024x1024',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  image_key     TEXT,                      -- R2 对象 key
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  worker_id     TEXT,
  created_at    INTEGER NOT NULL,          -- unix ms
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
```

> 提醒：D1 控制台一次只能执行一条语句，建表和建索引要分开 Run；用 `wrangler d1 execute --file` 或 migrations 则可以一次跑多条。

状态流转：

```
pending ──领取──▶ running ──成功──▶ done
   ▲                 │
   └──超时/可重试─────┤
                     └──失败且超过重试上限──▶ failed
```

---

## 3. API 设计（Cloudflare Worker）

### 3.1 面向用户

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/jobs` | 提交任务，body `{ prompt, size? }`，返回 `{ id, status }` |
| GET | `/api/jobs/:id` | 查询状态，done 时返回 `image_url` |

- 提交时做基本限流（按用户或 IP，比如每人同时最多 2 个 pending）。
- prompt 长度上限，例如 1000 字符。

### 3.2 面向本地 worker（请求头 `Authorization: Bearer <WORKER_SECRET>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/jobs/claim` | 领一条任务，无任务返回 `204` |
| POST | `/internal/jobs/:id/result` | 上传图片（`Content-Type: image/png`，原始二进制） |
| POST | `/internal/jobs/:id/fail` | 回报失败，body `{ error }` |

#### 领任务（原子操作）

用一条 `UPDATE ... RETURNING` 保证不会两个 worker 抢到同一条：

```sql
UPDATE jobs
SET status = 'running', started_at = ?1, worker_id = ?2, attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
)
RETURNING id, prompt, size;
```

#### 超时回收

Worker 加一个 Cron Trigger（每分钟），把卡住的任务放回队列或判失败：

```sql
UPDATE jobs SET status = 'pending', worker_id = NULL
WHERE status = 'running' AND started_at < ?1 AND attempts < 3;   -- ?1 = now - 10min

UPDATE jobs SET status = 'failed', error = 'timeout', finished_at = ?2
WHERE status = 'running' AND started_at < ?1 AND attempts >= 3;
```

---

## 4. Worker 参考实现（TypeScript）

```ts
export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  WORKER_SECRET: string;
  PUBLIC_IMAGE_BASE: string; // 例如 https://img.example.com
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const authed = (req: Request, env: Env) =>
  req.headers.get('authorization') === `Bearer ${env.WORKER_SECRET}`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // 用户：提交
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const { prompt, size } = await req.json<{ prompt: string; size?: string }>();
      if (!prompt || prompt.length > 1000) return json({ error: 'invalid prompt' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO jobs (id, prompt, size, created_at) VALUES (?1, ?2, ?3, ?4)'
      ).bind(id, prompt, size ?? '1024x1024', Date.now()).run();
      return json({ id, status: 'pending' }, 201);
    }

    // 用户：查询
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
      const job = await env.DB.prepare(
        'SELECT id, status, image_key, error FROM jobs WHERE id = ?1'
      ).bind(parts[2]).first<any>();
      if (!job) return json({ error: 'not found' }, 404);
      return json({
        id: job.id,
        status: job.status,
        image_url: job.image_key ? `${env.PUBLIC_IMAGE_BASE}/${job.image_key}` : null,
        error: job.error,
      });
    }

    // 内部接口
    if (parts[0] === 'internal') {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

      if (req.method === 'POST' && url.pathname === '/internal/jobs/claim') {
        const workerId = req.headers.get('x-worker-id') ?? 'mac';
        const job = await env.DB.prepare(`
          UPDATE jobs SET status='running', started_at=?1, worker_id=?2, attempts=attempts+1
          WHERE id = (SELECT id FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1)
          RETURNING id, prompt, size`).bind(Date.now(), workerId).first();
        return job ? json(job) : new Response(null, { status: 204 });
      }

      const id = parts[2];
      if (req.method === 'POST' && parts[3] === 'result') {
        const key = `jobs/${id}.png`;
        await env.IMAGES.put(key, req.body, { httpMetadata: { contentType: 'image/png' } });
        await env.DB.prepare(
          "UPDATE jobs SET status='done', image_key=?1, finished_at=?2 WHERE id=?3 AND status='running'"
        ).bind(key, Date.now(), id).run();
        return json({ ok: true });
      }

      if (req.method === 'POST' && parts[3] === 'fail') {
        const { error } = await req.json<{ error: string }>();
        await env.DB.prepare(`
          UPDATE jobs SET
            status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
            error = ?1, worker_id = NULL,
            finished_at = CASE WHEN attempts >= 3 THEN ?2 ELSE NULL END
          WHERE id = ?3`).bind(String(error).slice(0, 500), Date.now(), id).run();
        return json({ ok: true });
      }
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(_e: ScheduledEvent, env: Env) {
    const now = Date.now();
    const cutoff = now - 10 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status='pending', worker_id=NULL WHERE status='running' AND started_at<?1 AND attempts<3").bind(cutoff),
      env.DB.prepare("UPDATE jobs SET status='failed', error='timeout', finished_at=?2 WHERE status='running' AND started_at<?1 AND attempts>=3").bind(cutoff, now),
    ]);
  },
};
```

`wrangler.jsonc` 关键配置：

```jsonc
{
  "name": "imagegen-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "d1_databases": [{ "binding": "DB", "database_name": "imagegen", "database_id": "<id>" }],
  "r2_buckets": [{ "binding": "IMAGES", "bucket_name": "imagegen-images" }],
  "vars": { "PUBLIC_IMAGE_BASE": "https://img.example.com" },
  "triggers": { "crons": ["* * * * *"] }
}
```

密钥：`wrangler secret put WORKER_SECRET`。

---

## 5. 本地 worker（Mac，Node.js）

```js
// worker.mjs   运行：API_BASE=... WORKER_SECRET=... node worker.mjs
import { spawn } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const API = process.env.API_BASE;           // https://your-site.example.com
const SECRET = process.env.WORKER_SECRET;
const OUT = path.resolve('out');
const POLL_MS = 3000;
const TIMEOUT_MS = 8 * 60 * 1000;

const headers = { authorization: `Bearer ${SECRET}`, 'x-worker-id': 'mac-1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runCodex(prompt, file) {
  const instruction =
    `使用图像生成工具生成一张图片，内容：${prompt}。` +
    `把最终图片保存为 PNG 到这个路径：${file}。只生成图片，不要做其他事。`;
  return new Promise((resolve, reject) => {
    const p = spawn('codex', ['exec', '--skip-git-repo-check', instruction], { cwd: OUT });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    const t = setTimeout(() => { p.kill('SIGTERM'); reject(new Error('codex timeout')); }, TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(log) : reject(new Error(`codex exit ${code}: ${log.slice(-500)}`));
    });
  });
}

async function handle(job) {
  const file = path.join(OUT, `${job.id}.png`);
  try {
    await runCodex(job.prompt, file);
    const buf = await readFile(file);               // 文件不存在会抛错 → 走失败
    const r = await fetch(`${API}/internal/jobs/${job.id}/result`, {
      method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body: buf,
    });
    if (!r.ok) throw new Error(`upload ${r.status}`);
    console.log('done', job.id);
  } catch (e) {
    console.error('fail', job.id, e.message);
    await fetch(`${API}/internal/jobs/${job.id}/fail`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    }).catch(() => {});
  } finally {
    await rm(file, { force: true });
  }
}

await mkdir(OUT, { recursive: true });
for (;;) {
  try {
    const r = await fetch(`${API}/internal/jobs/claim`, { method: 'POST', headers });
    if (r.status === 200) { await handle(await r.json()); continue; }
  } catch (e) {
    console.error('poll error', e.message);
  }
  await sleep(POLL_MS);
}
```

常驻运行：用 `pm2 start worker.mjs` 或 macOS `launchd`；系统设置里关闭自动睡眠（或用 `caffeinate -i node worker.mjs`）。

---

## 6. 前端

1. `POST /api/jobs` 拿到 `id`。
2. 每 3–5 秒 `GET /api/jobs/:id`，显示「排队中 / 生成中」。
3. `done` 显示 `image_url`；`failed` 显示错误并允许重试。
4. 可在提交前提示「预计需要几分钟」。

---

## 7. 实施步骤

1. **先验证 Codex 出图（最大不确定性）**：在 Mac 上手动跑
   `codex exec --skip-git-repo-check "使用图像生成工具生成一只猫，保存为 ./test.png"`
   确认：能否出图、文件是否落盘、单张耗时、额度消耗。不行的话再调整指令或换调用方式。
2. 建 D1 库和 R2 桶，跑第 2 节建表 SQL。
3. 部署 Worker，设置 `WORKER_SECRET`，配 R2 公开域名。
4. 用 curl 走一遍：提交 → claim → 上传测试 PNG → 查询。
5. 启动本地 worker，端到端测试。
6. 接入网站前端。

---

## 8. 风险与注意事项

- **条款风险**：Codex 额度绑定 ChatGPT 个人订阅，用来给网站公开用户出图可能被视为转售或共享账号，存在封号风险。建议仅自用或小范围内测；对外开放时改用正式的 Images API（第 5 节的 `runCodex` 换成 API 调用即可，其他部分不变）。
- **吞吐**：单 worker 串行，一张可能要几十秒到几分钟。需要提速可以开多个 worker 进程，claim 是原子的。
- **安全**：`WORKER_SECRET` 只放在 Mac 环境变量和 Worker secret 里；prompt 原样拼进 Codex 指令，要防止用户在 prompt 里注入「执行命令」之类的内容——Codex 运行目录限制在 `out/`，并保持默认沙箱，不要开 `--dangerously-bypass-approvals-and-sandbox`。
- **离线**：Mac 不在线时任务停在 pending，前端应显示排队，不算故障。
