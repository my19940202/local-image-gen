# 本地 Codex 生图

这是 [生图中继方案](./codex-imagegen-relay.md) 的第一步：只在本机运行的最小生图通路。无需 Cloudflare 或 OpenAI API key，但需要已登录且能使用内置生图工具的 Codex CLI。

## 运行

需要 Node.js 22 或更新版本，以及能在终端执行的 `codex` 命令。

```sh
npm start
```

打开 <http://127.0.0.1:3000>，输入提示词并等待状态从“排队中”变为“生成中”和“已完成”。页面会列出历史生成记录，并显示每条记录的生成耗时。可用 `PORT=3001 npm start` 更换端口。服务只监听 `127.0.0.1`。

图片保存在 `output/<任务 ID>.png`，任务记录保存在 `output/jobs.json`。重启服务后仍可查看历史；重启前未完成的任务会标为失败，且不显示耗时。并发按 Codex 账户计算，每个账户默认同时生成 2 张，可通过 `IMAGE_CONCURRENCY=1..4` 配置。存在 `~/.codex-safari` 时会同时使用默认账户和这个账户，总并发是该值的两倍（默认 4 张，设为 4 时最多 8 张）。可用 `CODEX_LANES` 指定账户目录，多个目录用逗号分隔。Codex 运行最长 10 分钟，失败原因会显示在页面。更早只留下图片、没有任务记录的文件也会出现在历史里，但没有提示词和耗时。

## 接口

本机其他服务通过 `http://127.0.0.1:3000` 调用（可用 `PORT` 改端口）。生图是异步任务：提交后立刻返回任务 ID，图片要等状态变成 `done` 再取。每个账户默认同时执行 2 条任务，最多可配置为 4 条；两个账户时合计翻倍。每张图生成最长约 10 分钟。

请求体必须是 `Content-Type: application/json`，且不超过 16 KB。

### 1. 提交任务

```sh
curl -s -X POST http://127.0.0.1:3000/api/jobs \
  -H 'content-type: application/json' \
  -d '{"prompt":"一只坐在窗边的橘猫"}'
```

`prompt` 为 1–4200 个字符。也可传 `aspect_ratio`（`16:9`、`9:16`、`1:1`）、最多 3 个已完成的 `reference_ids` 和 `idempotency_key`。重复幂等键配合相同请求会返回已有任务；搭配不同内容会返回 HTTP 409。成功时 HTTP 201：

```json
{
  "id": "任务 UUID",
  "prompt": "一只坐在窗边的橘猫",
  "status": "pending",
  "error": null,
  "image_url": null,
  "width": null,
  "height": null,
  "created_at": 1710000000000,
  "started_at": null,
  "finished_at": null,
  "duration_ms": null,
  "queue_ms": null,
  "aspect_ratio": "16:9",
  "reference_ids": []
}
```

### 2. 轮询状态

`GET /api/jobs/:id`，直到 `status` 为 `done` 或 `failed`。响应还包含排队时间 `queue_ms`、画幅和参考任务 ID。

| 状态 | 含义 |
| --- | --- |
| `pending` | 排队 |
| `running` | 生成中 |
| `done` | 完成，`image_url` 为 `/api/jobs/:id/image`，并带有 `width`、`height`、`duration_ms` |
| `failed` | 失败，原因在 `error` |

`duration_ms` 是生成耗时（毫秒）。未完成或未记录时为 `null`。

### 3. 取图

`GET /api/jobs/:id/image` 返回 `image/png`。任务未完成时返回 404。

`GET /api/jobs` 按创建时间倒序列出历史任务（`{ "jobs": [ ... ] }`），不负责生图。

运行 `npm test` 可用模拟生图器验证本地流程。真实生图通过页面提交一条任务验收。
