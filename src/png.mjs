import { open, stat } from 'node:fs/promises';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export async function inspectPng(file) {
  const info = await stat(file);
  if (info.size < 33 || info.size > MAX_IMAGE_BYTES) {
    throw new Error('生成的图片为空、损坏或超过 20 MB');
  }

  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(33);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      !header.subarray(0, 8).equals(PNG_SIGNATURE) ||
      header.readUInt32BE(8) !== 13 ||
      header.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      throw new Error('Codex 未生成有效的 PNG 文件');
    }
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (!width || !height || width > 8192 || height > 8192) {
      throw new Error('生成的图片尺寸无效');
    }
    return { width, height, bytes: info.size };
  } finally {
    await handle.close();
  }
}
