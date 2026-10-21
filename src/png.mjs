import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function assertSize(size) {
  if (size < 33 || size > MAX_IMAGE_BYTES) {
    throw new Error('生成的图片为空、损坏或超过 20 MB');
  }
}

function readDimensions(header) {
  if (
    header.length < 33 ||
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
  return { width, height };
}

export async function inspectPng(file) {
  const info = await stat(file);
  assertSize(info.size);
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(33);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) throw new Error('Codex 未生成有效的 PNG 文件');
    return { ...readDimensions(header), bytes: info.size };
  } finally {
    await handle.close();
  }
}

export function inspectPngSync(file) {
  const info = statSync(file);
  assertSize(info.size);
  const header = Buffer.alloc(33);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, header, 0, header.length, 0) !== header.length) {
      throw new Error('Codex 未生成有效的 PNG 文件');
    }
    return { ...readDimensions(header), bytes: info.size, mtimeMs: info.mtimeMs };
  } finally {
    closeSync(fd);
  }
}
