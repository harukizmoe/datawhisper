/**
 * 飞书长连接（WebSocket）的帧编解码。
 *
 * 线上格式是飞书私有的 protobuf `pbbp2.Frame` / `pbbp2.Header`（proto2）。官方各语言 SDK 都带生成的
 * pb 代码与 protobuf 运行时；这里为了不新增依赖，只实现用得到的 9 个字段和两种线型
 * （varint、length-delimited），未知字段按线型跳过。字段号取自 `lark_oapi/ws/pb/pbbp2_pb2.py`：
 *
 *   Frame: 1 SeqID(uint64) 2 LogID(uint64) 3 service(int32) 4 method(int32)
 *          5 headers(repeated Header) 6 payload_encoding(string) 7 payload_type(string)
 *          8 payload(bytes) 9 LogIDNew(string)
 *   Header: 1 key(string) 2 value(string)
 *
 * `SeqID`/`LogID` 用 `bigint`（uint64 可能超过 2^53），`service`/`method` 用 number。
 */

export type FrameHeader = { key: string; value: string };

export type Frame = {
  seqId: bigint;
  logId: bigint;
  service: number;
  method: number;
  headers: FrameHeader[];
  payloadEncoding: string;
  payloadType: string;
  payload: Uint8Array | undefined;
  logIdNew: string;
};

/** `FrameType.CONTROL`：ping/pong 等控制帧。 */
export const FRAME_CONTROL = 0;
/** `FrameType.DATA`：事件/卡片等数据帧。 */
export const FRAME_DATA = 1;

/** 帧头里 `type` 的取值（`lark_oapi.ws.enum.MessageType`）。 */
export const MESSAGE_TYPE = { event: "event", card: "card", ping: "ping", pong: "pong" } as const;

export const HEADER_TYPE = "type";
export const HEADER_MESSAGE_ID = "message_id";
export const HEADER_SUM = "sum";
export const HEADER_SEQ = "seq";
export const HEADER_BIZ_RT = "biz_rt";

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH = 2;
const WIRE_32BIT = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function emptyFrame(): Frame {
  return {
    seqId: 0n,
    logId: 0n,
    service: 0,
    method: 0,
    headers: [],
    payloadEncoding: "",
    payloadType: "",
    payload: undefined,
    logIdNew: "",
  };
}

/** 帧头取值；不存在时返回 undefined（旧 SDK 抛 `HeaderNotFoundException`，这里让调用方决定）。 */
export function headerValue(frame: Frame, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const out: number[] = [];
  // proto2 的必填字段即使为 0 也要写出（官方 SDK 的 ping 帧就带着 SeqID/LogID = 0）。
  writeVarintField(out, 1, frame.seqId);
  writeVarintField(out, 2, frame.logId);
  writeVarintField(out, 3, BigInt(Math.trunc(frame.service)));
  writeVarintField(out, 4, BigInt(Math.trunc(frame.method)));
  for (const header of frame.headers) {
    writeBytesField(out, 5, encodeHeader(header));
  }
  if (frame.payloadEncoding !== "") writeBytesField(out, 6, encoder.encode(frame.payloadEncoding));
  if (frame.payloadType !== "") writeBytesField(out, 7, encoder.encode(frame.payloadType));
  if (frame.payload !== undefined) writeBytesField(out, 8, frame.payload);
  if (frame.logIdNew !== "") writeBytesField(out, 9, encoder.encode(frame.logIdNew));
  return Uint8Array.from(out);
}

export function decodeFrame(data: Uint8Array): Frame {
  const frame = emptyFrame();
  let pos = 0;
  while (pos < data.length) {
    const tag = readVarint(data, pos);
    if (tag === undefined) throw new Error("帧数据在 tag 处被截断");
    pos = tag.pos;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === WIRE_VARINT) {
      const value = readVarint(data, pos);
      if (value === undefined) throw new Error("帧数据在 varint 处被截断");
      pos = value.pos;
      if (field === 1) frame.seqId = value.value;
      else if (field === 2) frame.logId = value.value;
      else if (field === 3) frame.service = Number(value.value);
      else if (field === 4) frame.method = Number(value.value);
      continue;
    }
    if (wire === WIRE_LENGTH) {
      const length = readVarint(data, pos);
      if (length === undefined) throw new Error("帧数据在长度处被截断");
      pos = length.pos;
      const end = pos + Number(length.value);
      if (end > data.length) throw new Error("帧数据的分段超出缓冲区");
      const bytes = data.subarray(pos, end);
      pos = end;
      if (field === 5) frame.headers.push(decodeHeader(bytes));
      else if (field === 6) frame.payloadEncoding = decoder.decode(bytes);
      else if (field === 7) frame.payloadType = decoder.decode(bytes);
      else if (field === 8) frame.payload = bytes.slice();
      else if (field === 9) frame.logIdNew = decoder.decode(bytes);
      continue;
    }
    // 未使用的定长线型与字段：按长度跳过，保证后续字段仍能读出。
    if (wire === WIRE_64BIT) {
      pos += 8;
    } else if (wire === WIRE_32BIT) {
      pos += 4;
    } else {
      throw new Error(`不支持的 protobuf 线型 ${wire}`);
    }
    if (pos > data.length) throw new Error("帧数据在定长字段处被截断");
  }
  return frame;
}

function encodeHeader(header: FrameHeader): Uint8Array {
  const out: number[] = [];
  writeBytesField(out, 1, encoder.encode(header.key));
  writeBytesField(out, 2, encoder.encode(header.value));
  return Uint8Array.from(out);
}

function decodeHeader(data: Uint8Array): FrameHeader {
  const header: FrameHeader = { key: "", value: "" };
  let pos = 0;
  while (pos < data.length) {
    const tag = readVarint(data, pos);
    if (tag === undefined) break;
    pos = tag.pos;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire !== WIRE_LENGTH) {
      if (wire === WIRE_VARINT) pos = (readVarint(data, pos)?.pos ?? data.length);
      else if (wire === WIRE_64BIT) pos += 8;
      else if (wire === WIRE_32BIT) pos += 4;
      else break;
      continue;
    }
    const length = readVarint(data, pos);
    if (length === undefined) break;
    pos = length.pos;
    const end = pos + Number(length.value);
    if (end > data.length) break;
    const text = decoder.decode(data.subarray(pos, end));
    pos = end;
    if (field === 1) header.key = text;
    else if (field === 2) header.value = text;
  }
  return header;
}

function writeVarintField(out: number[], field: number, value: bigint): void {
  writeTag(out, field, WIRE_VARINT);
  writeVarint(out, value);
}

function writeBytesField(out: number[], field: number, bytes: Uint8Array): void {
  writeTag(out, field, WIRE_LENGTH);
  writeVarint(out, BigInt(bytes.length));
  for (const byte of bytes) out.push(byte);
}

function writeTag(out: number[], field: number, wire: number): void {
  writeVarint(out, BigInt(field * 8 + wire));
}

function writeVarint(out: number[], value: bigint): void {
  let rest = value < 0n ? 0n : value;
  while (rest > 0x7fn) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
}

function readVarint(data: Uint8Array, start: number): { value: bigint; pos: number } | undefined {
  let value = 0n;
  let shift = 0n;
  let pos = start;
  while (pos < data.length) {
    const byte = data[pos]!;
    pos += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, pos };
    shift += 7n;
    if (shift > 63n) return undefined;
  }
  return undefined;
}
