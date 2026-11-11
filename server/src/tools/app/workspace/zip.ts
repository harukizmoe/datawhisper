/**
 * 最小 ZIP 读取器：只服务于 DOCX / XLSX 的只读解析。
 *
 * Bun/Node 没有内置 zip 解压 API；这里直接按中央目录读取条目，支持 stored（0）
 * 与 deflate（8）两种压缩方式，并对解压后大小做上限检查，避免 zip bomb。
 */

import { inflateRawSync } from "node:zlib";

export type ZipEntry = {
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly offset: number;
};

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= start; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  return -1;
}

export function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("not a ZIP archive (end of central directory not found)");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, size, compressedSize, method, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 读取一个条目的原始字节；`maxBytes` 同时约束压缩后与解压后大小。 */
export function readZipEntry(buffer: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) {
    throw new Error(`ZIP entry ${entry.name} exceeds the ${maxBytes} byte safety limit`);
  }
  const offset = entry.offset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`ZIP entry ${entry.name} has an invalid local header`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new Error(`ZIP entry ${entry.name} is truncated`);
  const data = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error(`ZIP entry ${entry.name} uses unsupported compression method ${entry.method}`);
}

export function findZipEntry(buffer: Buffer, name: string): ZipEntry | undefined {
  return listZipEntries(buffer).find((entry) => entry.name === name);
}
