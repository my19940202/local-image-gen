import { existsSync } from 'node:fs';
import os from 'node:os';
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

function codexHomes() {
  if (process.env.CODEX_LANES) {
    const homes = process.env.CODEX_LANES.split(',').map((item) => item.trim()).filter(Boolean);
    if (!homes.length) throw new Error('CODEX_LANES 至少要有一个目录');
    for (const home of homes) {
      if (!existsSync(home)) throw new Error(`CODEX_LANES 目录不存在：${home}`);
    }
    return homes;
  }
  const homes = [path.join(os.homedir(), '.codex')];
  const safari = path.join(os.homedir(), '.codex-safari');
  if (existsSync(safari)) homes.push(safari);
  return homes;
}

const homes = codexHomes();
const concurrency = Number(process.env.IMAGE_CONCURRENCY || 2);
const controller = new AbortController();
const workers = homes.map((codexHome) => (job) => generateWithCodex({
  ...job,
  codexHome,
  signal: controller.signal,
}));
const server = createApp({ outputDir, concurrency, workers });
server.listen(port, '127.0.0.1', () => {
  console.log(`本地生图页面：http://127.0.0.1:${port}`);
  console.log(`图片目录：${outputDir}`);
  console.log(`生图并发：每账户 ${concurrency}，共 ${homes.length} 个账户，同时最多 ${concurrency * homes.length} 张`);
  console.log(`账户：${homes.join('、')}`);
});

for (const name of ['SIGINT', 'SIGTERM']) {
  process.once(name, () => {
    controller.abort();
    server.close();
  });
}
