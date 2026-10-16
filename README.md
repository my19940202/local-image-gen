# 本地 Codex 生图

这是 [生图中继方案](./codex-imagegen-relay.md) 的第一步：只在本机运行的最小生图通路。无需 Cloudflare 或 OpenAI API key，但需要已登录且能使用内置生图工具的 Codex CLI。

## 运行

需要 Node.js 22 或更新版本，以及能在终端执行的 `codex` 命令。

```sh
npm start
```

打开 <http://127.0.0.1:3000>，输入提示词并等待状态从“排队中”变为“生成中”和“已完成”。可用 `PORT=3001 npm start` 更换端口。服务只监听 `127.0.0.1`。

图片保存在 `output/<任务 ID>.png`。任务状态仅保存在内存中；重启服务后旧任务无法在页面查询，但图片文件仍保留。一次只处理一条任务。Codex 运行最长 10 分钟，失败原因会显示在页面。

## 接口

- `POST /api/jobs`：JSON `{ "prompt": "..." }`，返回任务 ID 和状态。
- `GET /api/jobs/:id`：返回 `pending`、`running`、`done` 或 `failed`，以及结果或错误。
- `GET /api/jobs/:id/image`：完成后返回 PNG。

运行 `npm test` 可用模拟生图器验证本地流程。真实生图通过页面提交一条任务验收。
