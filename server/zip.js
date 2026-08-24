// Чтение zip — потому что EPUB, FB2.ZIP и DOCX это zip в разных шляпах.
//
// Только то, что нужно этим троим: центральный каталог, записи «как есть» и
// сжатые, и столько ZIP64, чтобы пережить большую книгу. Ни записи, ни потоков,
// ни шифрования.

import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

const MAX_COMMENT = 0xffff;

function findEocd(buf) {
  const start = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

// Старые 32-битные поля упираются в 0xffffffff, а настоящее значение уезжает
// в запись ZIP64. Увидели заглушку — идём за ней.
function locateCentralDirectory(buf) {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === EOCD64_LOCATOR) {
      const at = Number(buf.readBigUInt64LE(loc + 8));
      if (at >= 0 && at < buf.length && buf.readUInt32LE(at) === EOCD64) {
        count = Number(buf.readBigUInt64LE(at + 32));
        offset = Number(buf.readBigUInt64LE(at + 48));
      }
    }
  }
  return { count, offset };
}

// ZIP64 кладёт большие значения в дополнительное поле, в строгом порядке, но
// только для тех полей, которые действительно переполнились.
function readZip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => {
        const v = Number(extra.readBigUInt64LE(q));
        q += 8;
        return v;
      };
      if (entry.size === 0xffffffff && q + 8 <= p + 4 + size) entry.size = take();
      if (entry.compressedSize === 0xffffffff && q + 8 <= p + 4 + size) entry.compressedSize = take();
      if (entry.offset === 0xffffffff && q + 8 <= p + 4 + size) entry.offset = take();
      return;
    }
    p += 4 + size;
  }
}

/**
 * Прочитать оглавление архива. Сами данные распаковываются по требованию.
 *
 * @param {Buffer} buf
 * @returns {{ names: string[], has(name: string): boolean, read(name: string): Buffer }}
 */
export function openZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const { count, offset } = locateCentralDirectory(buf);

  const entries = new Map();
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const entry = {
      method,
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    };
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (extraLen) readZip64Extra(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry);
    if (!name.endsWith('/')) entries.set(name, entry);
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`no such entry in zip: ${name}`);
    const head = entry.offset;
    if (buf.readUInt32LE(head) !== LOCAL) throw new Error(`corrupt local header for ${name}`);
    // Локальный заголовок повторяет имя и несёт своё дополнительное поле, длина
    // которого может отличаться от центрального. Пропустить нужно оба.
    const start = head + 30 + buf.readUInt16LE(head + 26) + buf.readUInt16LE(head + 28);
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported compression method ${entry.method} for ${name}`);
  };

  return {
    get names() {
      return [...entries.keys()];
    },
    has: (name) => entries.has(name),
    size: (name) => entries.get(name)?.size ?? 0,
    read,
    text: (name) => read(name).toString('utf8').replace(/^﻿/, ''),
  };
}

export function looksLikeZip(buf) {
  return buf.length > 4 && buf.readUInt32LE(0) === LOCAL;
}
