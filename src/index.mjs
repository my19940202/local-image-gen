import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';
import { generateWithCodex } from './codex.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputDir = path.join(root, 'output');
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须是 1–65535 之间的整数');
}

const controller = new AbortController();
const server = createApp({
  outputDir,
  generateImage: (job) => generateWithCodex({ ...job, signal: controller.signal }),
});
server.listen(port, '127.0.0.1', () => {
  console.log(`本地生图页面：http://127.0.0.1:${port}`);
  console.log(`图片目录：${outputDir}`);
});

for (const name of ['SIGINT', 'SIGTERM']) {
  process.once(name, () => {
    controller.abort();
    server.close();
  });
}
