/**
 * Text extraction from PDF, with no dependencies.
 *
 * A PDF does not contain paragraphs — it contains instructions for placing
 * glyphs at coordinates. Everything here is aimed at undoing that: find the
 * content streams, decode the glyph codes back into characters, group the
 * placements into lines, and group the lines back into paragraphs.
 *
 * The file is read as latin1 throughout so that string offsets and byte
 * offsets are the same number, which is what makes scanning for objects safe.
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';

// ------------------------------------------------------------------ pdf values

class Name {
  constructor(name) {
    this.name = name;
  }
}
class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}
class PdfString {
  /** @param {string} bytes latin1, one char per byte */
  constructor(bytes) {
    this.bytes = bytes;
  }
}
class Op {
  constructor(op) {
    this.op = op;
  }
}

const isWS = (c) =>
  c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
const isDelim = (c) => c === '(' || c === ')' || c === '<' || c === '>' ||
  c === '[' || c === ']' || c === '{' || c === '}' || c === '/' || c === '%';

function skipWS(s, i) {
  for (;;) {
    while (i < s.length && isWS(s[i])) i++;
    if (s[i] === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    return i;
  }
}

function readName(s, i) {
  let out = '';
  i++; // the slash
  while (i < s.length && !isWS(s[i]) && !isDelim(s[i])) {
    if (s[i] === '#' && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 1, 2))) {
      out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16));
      i += 3;
    } else {
      out += s[i++];
    }
  }
  return [new Name(out), i];
}

const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

function readLiteralString(s, i) {
  let out = '';
  let depth = 1;
  i++; // '('
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const next = s[i + 1];
      if (next >= '0' && next <= '7') {
        let oct = '';
        i++;
        while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        continue;
      }
      if (next === '\n') i += 2;
      else if (next === '\r') i += s[i + 2] === '\n' ? 3 : 2;
      else {
        out += ESCAPES[next] ?? next;
        i += 2;
      }
      continue;
    }
    if (c === '(') depth++;
    if (c === ')' && --depth === 0) return [new PdfString(out), i + 1];
    out += c;
    i++;
  }
  return [new PdfString(out), i];
}

function readHexString(s, i) {
  i++; // '<'
  let hex = '';
  while (i < s.length && s[i] !== '>') {
    if (/[0-9a-fA-F]/.test(s[i])) hex += s[i];
    i++;
  }
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) {
    out += String.fromCharCode(parseInt(hex.substr(k, 2), 16));
  }
  return [new PdfString(out), i + 1];
}

/**
 * Parse one object starting at `i`. Returns [value, nextIndex]. Bare words that
 * are not keywords come back as `Op`, which is how content-stream operators are
 * recognised — the same grammar serves both files and content streams.
 */
function parseValue(s, i) {
  i = skipWS(s, i);
  if (i >= s.length) return [undefined, i];
  const c = s[i];

  if (c === '/') return readName(s, i);
  if (c === '(') return readLiteralString(s, i);

  if (c === '<') {
    if (s[i + 1] === '<') {
      const dict = {};
      i += 2;
      for (;;) {
        i = skipWS(s, i);
        if (i >= s.length) break;
        if (s[i] === '>' && s[i + 1] === '>') {
          i += 2;
          break;
        }
        if (s[i] !== '/') {
          // Malformed key — step over it rather than spinning.
          const [, next] = parseValue(s, i);
          if (next <= i) i++;
          else i = next;
          continue;
        }
        const [key, afterKey] = readName(s, i);
        const [value, afterValue] = parseValue(s, afterKey);
        dict[key.name] = value;
        i = afterValue;
      }
      return [dict, i];
    }
    return readHexString(s, i);
  }

  if (c === '[') {
    const arr = [];
    i++;
    for (;;) {
      i = skipWS(s, i);
      if (i >= s.length) break;
      if (s[i] === ']') {
        i++;
        break;
      }
      const [value, next] = parseValue(s, i);
      if (next <= i) {
        i++;
        continue;
      }
      arr.push(value);
      i = next;
    }
    return [arr, i];
  }

  if (c === ']' || c === '>' || c === ')' || c === '}' || c === '{') {
    return [new Op(c), i + 1];
  }

  if (/[+\-.\d]/.test(c)) {
    let word = '';
    while (i < s.length && /[+\-.\deE]/.test(s[i])) word += s[i++];
    const num = parseFloat(word);
    const value = Number.isFinite(num) ? num : 0;
    // `12 0 R` is an indirect reference; only integers can start one.
    if (Number.isInteger(value) && value >= 0) {
      const save = i;
      let j = skipWS(s, i);
      let gen = '';
      while (j < s.length && /\d/.test(s[j])) gen += s[j++];
      if (gen) {
        const k = skipWS(s, j);
        if (s[k] === 'R' && (isWS(s[k + 1]) || isDelim(s[k + 1]) || k + 1 >= s.length)) {
          return [new Ref(value, parseInt(gen, 10)), k + 1];
        }
      }
      i = save;
    }
    return [value, i];
  }

  let word = '';
  while (i < s.length && !isWS(s[i]) && !isDelim(s[i])) word += s[i++];
  if (word === 'true') return [true, i];
  if (word === 'false') return [false, i];
  if (word === 'null') return [null, i];
  if (!word) return [new Op(s[i]), i + 1];
  return [new Op(word), i];
}

// ------------------------------------------------------------------- filters

function ascii85Decode(input) {
  let s = input.replace(/\s+/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let tuple = [];
  for (const ch of s) {
    if (ch === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    tuple.push(ch.charCodeAt(0) - 33);
    if (tuple.length === 5) {
      let n = 0;
      for (const t of tuple) n = n * 85 + t;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const missing = 5 - tuple.length;
    for (let k = 0; k < missing; k++) tuple.push(84);
    let n = 0;
    for (const t of tuple) n = n * 85 + t;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

function runLengthDecode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const len = buf[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len; k++) out.push(buf[i++]);
    } else {
      const byte = buf[i++];
      for (let k = 0; k < 257 - len; k++) out.push(byte);
    }
  }
  return Buffer.from(out);
}

/** Undo the PNG/TIFF predictors that flate streams are often filtered through. */
function undoPredictor(buf, parms, resolve) {
  const predictor = resolve(parms?.Predictor) ?? 1;
  if (predictor <= 1) return buf;
  const colors = resolve(parms?.Colors) ?? 1;
  const bpc = resolve(parms?.BitsPerComponent) ?? 8;
  const columns = resolve(parms?.Columns) ?? 1;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLength = Math.ceil((colors * bpc * columns) / 8);

  if (predictor === 2) {
    if (bpc !== 8) return buf;
    for (let r = 0; r + rowLength <= buf.length; r += rowLength) {
      for (let i = bpp; i < rowLength; i++) {
        buf[r + i] = (buf[r + i] + buf[r + i - bpp]) & 0xff;
      }
    }
    return buf;
  }

  const rows = Math.floor(buf.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let prev = Buffer.alloc(rowLength);
  for (let r = 0; r < rows; r++) {
    const tag = buf[r * (rowLength + 1)];
    const row = buf.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = Buffer.from(row);
    for (let i = 0; i < rowLength; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (tag) {
        case 1: cur[i] = (cur[i] + a) & 0xff; break;
        case 2: cur[i] = (cur[i] + b) & 0xff; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[i] = (cur[i] + pred) & 0xff;
          break;
        }
        default: break;
      }
    }
    cur.copy(out, r * rowLength);
    prev = cur;
  }
  return out;
}

function inflate(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch {
    // Truncated or slightly malformed streams are common; take what we can get.
    for (const options of [{ finishFlush: zlib.constants.Z_SYNC_FLUSH }]) {
      try {
        return zlib.inflateSync(buf, options);
      } catch {
        /* fall through */
      }
      try {
        return zlib.inflateRawSync(buf.subarray(1), options);
      } catch {
        /* fall through */
      }
    }
    return Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------- encryption

/**
 * The standard security handler, empty user password only — the case of a PDF
 * that is "encrypted" purely to carry permission flags, which is common enough
 * to be worth handling. Anything needing a real password is refused.
 */
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest();

function buildDecryptor(encrypt, idFirst, resolve) {
  const filter = resolve(encrypt.Filter);
  if (!(filter instanceof Name) || filter.name !== 'Standard') return null;

  const v = resolve(encrypt.V) ?? 0;
  const r = resolve(encrypt.R) ?? 2;
  const o = resolve(encrypt.O);
  const u = resolve(encrypt.U);
  const p = resolve(encrypt.P) ?? 0;
  if (!(o instanceof PdfString)) return null;

  let method = 'rc4';
  if (v >= 4) {
    const cf = resolve(encrypt.CF);
    const stmF = resolve(encrypt.StmF);
    const name = stmF instanceof Name ? stmF.name : 'StdCF';
    if (name === 'Identity') return { decrypt: (data) => data };
    const entry = cf ? resolve(cf[name]) : null;
    const cfm = entry ? resolve(entry.CFM) : null;
    if (cfm instanceof Name) {
      if (cfm.name === 'AESV2') method = 'aes128';
      else if (cfm.name === 'AESV3') method = 'aes256';
      else if (cfm.name === 'None') return { decrypt: (data) => data };
    }
  }

  if (r >= 5) {
    // AES-256: the file key is unwrapped straight from /U with an empty password.
    if (!(u instanceof PdfString) || u.bytes.length < 48) return null;
    const ub = Buffer.from(u.bytes, 'latin1');
    const validation = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.alloc(0), ub.subarray(32, 40)]))
      .digest();
    if (!validation.equals(ub.subarray(0, 32))) return null; // non-empty password
    const intermediate = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.alloc(0), ub.subarray(40, 48)]))
      .digest();
    const ue = resolve(encrypt.UE);
    if (!(ue instanceof PdfString)) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      intermediate,
      Buffer.alloc(16),
    );
    decipher.setAutoPadding(false);
    const fileKey = Buffer.concat([
      decipher.update(Buffer.from(ue.bytes, 'latin1')),
      decipher.final(),
    ]);
    return {
      decrypt(data) {
        if (data.length <= 16) return Buffer.alloc(0);
        try {
          const d = crypto.createDecipheriv('aes-256-cbc', fileKey, data.subarray(0, 16));
          d.setAutoPadding(false);
          const out = Buffer.concat([d.update(data.subarray(16)), d.final()]);
          const pad = out[out.length - 1];
          return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
        } catch {
          return Buffer.alloc(0);
        }
      },
    };
  }

  const lengthBits = resolve(encrypt.Length) ?? 40;
  const keyLength = v === 1 ? 5 : Math.max(5, Math.min(16, lengthBits >> 3));
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p | 0, 0);
  const parts = [
    PAD,
    Buffer.from(o.bytes, 'latin1').subarray(0, 32),
    pBuf,
    Buffer.from(idFirst || '', 'latin1'),
  ];
  if (r >= 4 && resolve(encrypt.EncryptMetadata) === false) {
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  }
  let key = md5(Buffer.concat(parts)).subarray(0, keyLength);
  if (r >= 3) {
    for (let i = 0; i < 50; i++) key = md5(key.subarray(0, keyLength)).subarray(0, keyLength);
  }

  return {
    decrypt(data, num, gen) {
      const extra = Buffer.from([
        num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff,
        gen & 0xff, (gen >> 8) & 0xff,
      ]);
      const salt = method === 'rc4' ? [key, extra] : [key, extra, Buffer.from('sAlT', 'latin1')];
      const objKey = md5(Buffer.concat(salt)).subarray(0, Math.min(16, key.length + 5));
      if (method === 'rc4') return rc4(objKey, data);
      if (data.length <= 16) return Buffer.alloc(0);
      try {
        const d = crypto.createDecipheriv('aes-128-cbc', objKey, data.subarray(0, 16));
        d.setAutoPadding(false);
        const out = Buffer.concat([d.update(data.subarray(16)), d.final()]);
        const pad = out[out.length - 1];
        return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
      } catch {
        return Buffer.alloc(0);
      }
    },
  };
}

// ------------------------------------------------------------------- document

class PdfDocument {
  constructor(buffer) {
    this.buf = buffer;
    this.raw = buffer.toString('latin1');
    this.offsets = new Map(); // objNum -> byte offset of the header
    this.cache = new Map();
    this.embedded = new Map(); // objects unpacked from object streams
    this.decryptor = null;
    this.indexObjects();
    this.setUpDecryption();
    this.expandObjectStreams();
  }

  /**
   * Rather than trusting the cross-reference table — which is the first thing to
   * rot in a damaged or incrementally-updated file — every `N G obj` header in
   * the file is indexed directly. Later definitions win, which matches how
   * incremental updates are meant to be read.
   */
  indexObjects() {
    const re = /(?:^|[\s>\]])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let match;
    while ((match = re.exec(this.raw))) {
      const num = parseInt(match[1], 10);
      this.offsets.set(num, match.index + match[0].indexOf(match[1]));
      re.lastIndex = match.index + match[0].length;
    }
  }

  setUpDecryption() {
    const trailerRe = /\/Encrypt\s+(\d+)\s+(\d+)\s*R/g;
    let match;
    let encryptRef = null;
    while ((match = trailerRe.exec(this.raw))) encryptRef = parseInt(match[1], 10);
    if (encryptRef === null) return;

    let idFirst = '';
    const idMatch = /\/ID\s*\[\s*<([0-9a-fA-F\s]*)>/.exec(this.raw);
    if (idMatch) {
      const hex = idMatch[1].replace(/\s+/g, '');
      for (let i = 0; i + 1 < hex.length; i += 2) {
        idFirst += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      }
    }

    this.encryptedObj = encryptRef;
    const dict = this.get(new Ref(encryptRef, 0));
    if (dict && typeof dict === 'object') {
      this.decryptor = buildDecryptor(dict, idFirst, (v) => this.resolve(v));
      this.encrypted = true;
      if (!this.decryptor) this.encryptionUnsupported = true;
    }
  }

  expandObjectStreams() {
    for (const num of [...this.offsets.keys()]) {
      let obj;
      try {
        obj = this.get(new Ref(num, 0));
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object' || !obj.__stream) continue;
      const type = this.resolve(obj.Type);
      if (!(type instanceof Name) || type.name !== 'ObjStm') continue;

      const data = this.streamData(obj, num).toString('latin1');
      const count = this.resolve(obj.N) ?? 0;
      const first = this.resolve(obj.First) ?? 0;
      const header = data.slice(0, first);
      const nums = header.trim().split(/\s+/).map(Number);
      for (let k = 0; k < count; k++) {
        const objNum = nums[k * 2];
        const offset = nums[k * 2 + 1];
        if (!Number.isFinite(objNum) || !Number.isFinite(offset)) continue;
        if (this.offsets.has(objNum)) continue; // a real object wins
        const [value] = parseValue(data, first + offset);
        this.embedded.set(objNum, value);
      }
    }
  }

  /** Parse the object with this number, including its stream bytes if it has one. */
  get(ref) {
    const num = ref instanceof Ref ? ref.num : ref;
    if (this.cache.has(num)) return this.cache.get(num);
    this.cache.set(num, null); // guard against reference cycles

    let value = null;
    const offset = this.offsets.get(num);
    if (offset === undefined) {
      value = this.embedded.has(num) ? this.embedded.get(num) : null;
      this.cache.set(num, value);
      return value;
    }

    const headerEnd = this.raw.indexOf('obj', offset) + 3;
    const [parsed, after] = parseValue(this.raw, headerEnd);
    value = parsed;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const streamAt = skipWS(this.raw, after);
      if (this.raw.startsWith('stream', streamAt)) {
        let dataStart = streamAt + 6;
        if (this.raw[dataStart] === '\r') dataStart++;
        if (this.raw[dataStart] === '\n') dataStart++;
        let length = this.resolve(value.Length);
        if (typeof length !== 'number' || dataStart + length > this.raw.length) length = null;
        if (length !== null) {
          // Trust /Length only if `endstream` actually follows it.
          const tail = this.raw.slice(dataStart + length, dataStart + length + 20);
          if (!/^\s*endstream/.test(tail)) length = null;
        }
        if (length === null) {
          const end = this.raw.indexOf('endstream', dataStart);
          length = (end < 0 ? this.raw.length : end) - dataStart;
          while (length > 0 && (this.raw[dataStart + length - 1] === '\n' ||
                 this.raw[dataStart + length - 1] === '\r')) length--;
        }
        value.__stream = { start: dataStart, length };
      }
    }
    this.cache.set(num, value);
    return value;
  }

  resolve(value) {
    let seen = 0;
    while (value instanceof Ref && seen++ < 32) value = this.get(value);
    return value;
  }

  /** Decoded bytes of a stream object. `num` is needed for per-object decryption. */
  streamData(dict, num, gen = 0) {
    if (!dict?.__stream) return Buffer.alloc(0);
    let data = this.buf.subarray(
      dict.__stream.start,
      dict.__stream.start + dict.__stream.length,
    );

    if (this.decryptor && num !== this.encryptedObj) {
      const type = this.resolve(dict.Type);
      const isXref = type instanceof Name && type.name === 'XRef';
      if (!isXref) data = this.decryptor.decrypt(data, num, gen);
    }

    let filters = this.resolve(dict.Filter);
    if (!filters) return data;
    if (!Array.isArray(filters)) filters = [filters];
    let parms = this.resolve(dict.DecodeParms) ?? this.resolve(dict.DP);
    if (!Array.isArray(parms)) parms = [parms];

    filters.forEach((filter, index) => {
      const name = this.resolve(filter)?.name;
      const parm = this.resolve(parms[index]) || null;
      switch (name) {
        case 'FlateDecode':
        case 'Fl':
          data = undoPredictor(inflate(data), parm, (v) => this.resolve(v));
          break;
        case 'ASCII85Decode':
        case 'A85':
          data = ascii85Decode(data.toString('latin1'));
          break;
        case 'ASCIIHexDecode':
        case 'AHx': {
          const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
          data = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
          break;
        }
        case 'RunLengthDecode':
        case 'RL':
          data = runLengthDecode(data);
          break;
        case 'LZWDecode':
          data = undoPredictor(lzwDecode(data), parm, (v) => this.resolve(v));
          break;
        default:
          // An image filter (DCT, JPX, CCITT) — not text, leave it alone.
          break;
      }
    });
    return data;
  }

  /** Pages in reading order, walking the page tree and inheriting attributes. */
  pages() {
    const found = [];
    const root = this.findCatalog();
    const seen = new Set();

    const walk = (ref, inherited, depth) => {
      if (depth > 64 || found.length > 5000) return;
      const key = ref instanceof Ref ? ref.num : null;
      if (key !== null) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      const node = this.resolve(ref);
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;

      const attrs = { ...inherited };
      for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
        if (node[key] !== undefined) attrs[key] = node[key];
      }

      const type = this.resolve(node.Type);
      const kids = this.resolve(node.Kids);
      if (Array.isArray(kids)) {
        for (const kid of kids) walk(kid, attrs, depth + 1);
        return;
      }
      if ((type instanceof Name && type.name === 'Page') || node.Contents !== undefined) {
        found.push({ dict: node, attrs });
      }
    };

    if (root?.Pages !== undefined) walk(root.Pages, {}, 0);

    if (!found.length) {
      // No usable page tree — fall back to every object that looks like a page.
      const numbers = [...new Set([...this.offsets.keys(), ...this.embedded.keys()])].sort(
        (a, b) => a - b,
      );
      for (const num of numbers) {
        const obj = this.get(new Ref(num, 0));
        const type = obj && typeof obj === 'object' ? this.resolve(obj.Type) : null;
        if (type instanceof Name && type.name === 'Page') {
          found.push({ dict: obj, attrs: { Resources: obj.Resources } });
        }
      }
    }
    return found;
  }

  findCatalog() {
    const rootRe = /\/Root\s+(\d+)\s+(\d+)\s*R/g;
    let match;
    let last = null;
    while ((match = rootRe.exec(this.raw))) last = parseInt(match[1], 10);
    if (last !== null) {
      const obj = this.get(new Ref(last, 0));
      if (obj && typeof obj === 'object' && obj.Pages !== undefined) return obj;
    }
    for (const num of [...this.offsets.keys(), ...this.embedded.keys()]) {
      const obj = this.get(new Ref(num, 0));
      if (!obj || typeof obj !== 'object') continue;
      const type = this.resolve(obj.Type);
      if (type instanceof Name && type.name === 'Catalog') return obj;
    }
    return null;
  }

  info() {
    const infoRe = /\/Info\s+(\d+)\s+(\d+)\s*R/g;
    let match;
    let last = null;
    while ((match = infoRe.exec(this.raw))) last = parseInt(match[1], 10);
    if (last === null) return {};
    const dict = this.get(new Ref(last, 0));
    if (!dict || typeof dict !== 'object') return {};
    const read = (key) => {
      const value = this.resolve(dict[key]);
      if (!(value instanceof PdfString)) return '';
      const text = decodeTextString(value.bytes).trim();
      // Producers stamp placeholders here; none of them is a title.
      if (/^\(?(anonymous|untitled|unspecified|unknown|none|no title)\)?$/i.test(text)) {
        return '';
      }
      // Word writes "Microsoft Word - thesis-final-3.docx" into /Title.
      const stripped = text.replace(/^Microsoft Word\s*-\s*/i, '').trim();
      if (/\.(docx?|pptx?|pages|odt|rtf|tex|indd)$/i.test(stripped)) {
        return stripped.replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ').trim();
      }
      return stripped;
    };
    return { title: read('Title'), author: read('Author'), subject: read('Subject') };
  }

  /** Content streams of a page, concatenated. */
  pageContent(page) {
    const contents = this.resolve(page.dict.Contents);
    const list = Array.isArray(contents) ? contents : [contents];
    const parts = [];
    for (const item of list) {
      const num = item instanceof Ref ? item.num : 0;
      const stream = this.resolve(item);
      if (stream && typeof stream === 'object' && stream.__stream) {
        parts.push(this.streamData(stream, num, item instanceof Ref ? item.gen : 0));
        parts.push(Buffer.from('\n'));
      }
    }
    return Buffer.concat(parts).toString('latin1');
  }
}

function lzwDecode(buf) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null);
  };
  reset();
  let width = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let previous = null;
  for (const byte of buf) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= width) {
      const code = (bitBuffer >> (bitCount - width)) & ((1 << width) - 1);
      bitCount -= width;
      if (code === 256) {
        reset();
        width = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Buffer.from(out);
      let entry;
      if (code < dict.length && dict[code]) entry = dict[code];
      else if (previous) entry = [...previous, previous[0]];
      else continue;
      out.push(...entry);
      if (previous) dict.push([...previous, entry[0]]);
      previous = entry;
      if (dict.length + 1 >= 1 << width && width < 12) width++;
    }
  }
  return Buffer.from(out);
}

/** PDF text strings are either UTF-16BE with a BOM, or PDFDocEncoding. */
function decodeTextString(bytes) {
  if (bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    }
    return out;
  }
  return bytes;
}

// ------------------------------------------------------------------ encodings

/** WinAnsiEncoding 0x80-0x9F, where it parts company with Latin-1. 0 = unused. */
const WIN_ANSI_HIGH = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

/** MacRomanEncoding 0x80-0xFF. */
const MAC_ROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1,
  0x00e0, 0x00e2, 0x00e4, 0x00e3, 0x00e5, 0x00e7, 0x00e9, 0x00e8,
  0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc,
  0x2020, 0x00b0, 0x00a2, 0x00a3, 0x00a7, 0x2022, 0x00b6, 0x00df,
  0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211,
  0x220f, 0x03c0, 0x222b, 0x00aa, 0x00ba, 0x03a9, 0x00e6, 0x00f8,
  0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0x00f7, 0x25ca,
  0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1,
  0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc, 0x00d3, 0x00d4,
  0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

/** Adobe glyph names, as they appear in /Differences arrays. */
const GLYPHS = (() => {
  const map = new Map(
    Object.entries({
      space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$',
      percent: '%', ampersand: '&', quotesingle: "'", parenleft: '(',
      parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
      period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
      equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
      backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
      grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
      zero: '0', one: '1', two: '2', three: '3', four: '4',
      five: '5', six: '6', seven: '7', eight: '8', nine: '9',
      quoteleft: '‘', quoteright: '’', quotedblleft: '“',
      quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„',
      endash: '–', emdash: '—', bullet: '•', ellipsis: '…',
      dagger: '†', daggerdbl: '‡', perthousand: '‰',
      guilsinglleft: '‹', guilsinglright: '›',
      guillemotleft: '«', guillemotright: '»',
      fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ',
      trademark: '™', copyright: '©', registered: '®',
      degree: '°', plusminus: '±', section: '§',
      paragraph: '¶', sterling: '£', euro: '€',
      yen: '¥', cent: '¢', currency: '¤',
      germandbls: 'ß', questiondown: '¿', exclamdown: '¡',
      florin: 'ƒ', circumflex: 'ˆ', tilde: '˜',
      minus: '−', multiply: '×', divide: '÷',
      fraction: '⁄', dotlessi: 'ı', ae: 'æ', AE: 'Æ',
      oslash: 'ø', Oslash: 'Ø', oe: 'œ', OE: 'Œ',
      thorn: 'þ', Thorn: 'Þ', eth: 'ð', Eth: 'Ð',
    }),
  );
  for (let c = 65; c <= 90; c++) map.set(String.fromCharCode(c), String.fromCharCode(c));
  for (let c = 97; c <= 122; c++) map.set(String.fromCharCode(c), String.fromCharCode(c));
  // Accented names follow a regular pattern: base letter plus the accent name.
  const accents = {
    acute: '́', grave: '̀', dieresis: '̈', circumflex: '̂',
    tilde: '̃', ring: '̊', cedilla: '̧', caron: '̌',
    breve: '̆', macron: '̄', ogonek: '̨', dotaccent: '̇',
    hungarumlaut: '̋',
  };
  for (const letter of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const [suffix, mark] of Object.entries(accents)) {
      map.set(letter + suffix, (letter + mark).normalize('NFC'));
    }
  }
  return map;
})();

function glyphToUnicode(name) {
  if (GLYPHS.has(name)) return GLYPHS.get(name);
  const match = /^uni?([0-9A-Fa-f]{4,6})$/.exec(name);
  if (match) {
    const code = parseInt(match[1], 16);
    if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
  }
  return '';
}

function baseEncodingChar(code, base) {
  if (code < 0x80) return String.fromCharCode(code);
  if (base === 'MacRomanEncoding') {
    const point = MAC_ROMAN_HIGH[code - 0x80];
    return point ? String.fromCharCode(point) : '';
  }
  if (code < 0xa0) {
    const point = WIN_ANSI_HIGH[code - 0x80];
    return point ? String.fromCharCode(point) : '';
  }
  return String.fromCharCode(code);
}

// ---------------------------------------------------------------------- fonts

/** Parse a /ToUnicode CMap into a character-code -> string map. */
function parseCMap(text) {
  const map = new Map();
  const toStr = (hex) => {
    let out = '';
    for (let i = 0; i < hex.length; i += 4) {
      const unit = parseInt(hex.substr(i, 4).padEnd(4, '0'), 16);
      if (Number.isFinite(unit) && unit !== 0) out += String.fromCharCode(unit);
    }
    return out;
  };

  let block;
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((block = charRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\/([^\s/<>[\]]+))/g;
    let pair;
    while ((pair = pairRe.exec(block[1]))) {
      const value = pair[2] !== undefined ? toStr(pair[2]) : glyphToUnicode(pair[3]);
      if (value) map.set(parseInt(pair[1], 16), value);
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeRe.exec(text))) {
    const lineRe =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
    let line;
    while ((line = lineRe.exec(block[1]))) {
      const from = parseInt(line[1], 16);
      const to = parseInt(line[2], 16);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 65535) {
        continue;
      }
      if (line[3] !== undefined) {
        const base = toStr(line[3]);
        if (!base) continue;
        const last = base.charCodeAt(base.length - 1);
        for (let code = from; code <= to; code++) {
          map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - from)));
        }
      } else {
        [...line[4].matchAll(/<([0-9A-Fa-f]*)>/g)].forEach((item, index) => {
          const value = toStr(item[1]);
          if (value) map.set(from + index, value);
        });
      }
    }
  }
  return map;
}

const FALLBACK_FONT = {
  twoByte: false,
  toUnicode: null,
  differences: null,
  base: 'StandardEncoding',
};

function buildFont(doc, dict) {
  const font = { ...FALLBACK_FONT };
  if (!dict || typeof dict !== 'object') return font;

  const subtype = doc.resolve(dict.Subtype);
  const isType0 = subtype instanceof Name && subtype.name === 'Type0';
  const encoding = doc.resolve(dict.Encoding);
  if (isType0) font.twoByte = true;

  if (!isType0) {
    if (encoding instanceof Name) {
      font.base = encoding.name;
    } else if (encoding && typeof encoding === 'object' && !Array.isArray(encoding)) {
      const baseEncoding = doc.resolve(encoding.BaseEncoding);
      if (baseEncoding instanceof Name) font.base = baseEncoding.name;
      const differences = doc.resolve(encoding.Differences);
      if (Array.isArray(differences)) {
        font.differences = new Map();
        let code = 0;
        for (const item of differences) {
          const value = doc.resolve(item);
          if (typeof value === 'number') code = value;
          else if (value instanceof Name) font.differences.set(code++, glyphToUnicode(value.name));
        }
      }
    }
  }

  const toUnicode = doc.resolve(dict.ToUnicode);
  if (toUnicode && typeof toUnicode === 'object' && toUnicode.__stream) {
    const num = dict.ToUnicode instanceof Ref ? dict.ToUnicode.num : 0;
    try {
      font.toUnicode = parseCMap(doc.streamData(toUnicode, num).toString('latin1'));
    } catch {
      font.toUnicode = null;
    }
  }
  return font;
}

function fontMap(doc, resources) {
  const map = new Map();
  const fonts = doc.resolve(resources?.Font);
  if (!fonts || typeof fonts !== 'object' || Array.isArray(fonts)) return map;
  for (const [key, ref] of Object.entries(fonts)) {
    try {
      map.set(key, buildFont(doc, doc.resolve(ref)));
    } catch {
      map.set(key, { ...FALLBACK_FONT });
    }
  }
  return map;
}

/**
 * Glyph codes back to characters. A subset font with no /ToUnicode is not
 * decodable at all — better to yield nothing than convincing-looking rubbish.
 */
function decodeString(font, bytes) {
  let out = '';
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
      const mapped = font.toUnicode?.get(code);
      if (mapped !== undefined) out += mapped;
      else if (!font.toUnicode && code >= 32 && code < 0x3000) out += String.fromCharCode(code);
    }
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    const mapped = font.toUnicode?.get(code);
    if (mapped) {
      out += mapped;
      continue;
    }
    const differed = font.differences?.get(code);
    if (differed) {
      out += differed;
      continue;
    }
    out += baseEncodingChar(code, font.base);
  }
  return out;
}

// ------------------------------------------------------------ content streams

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/**
 * Walk a content stream and record each piece of text with where it landed.
 * Glyph widths are not read, so horizontal advance is estimated — it only has
 * to be good enough to order runs that share a line.
 */
function extractRuns(doc, content, resources, baseCtm, depth, out) {
  const fonts = fontMap(doc, resources);
  const graphicsStack = [];
  let ctm = baseCtm;
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let font = null;
  let fontSize = 0;
  let leading = 0;
  let charSpacing = 0;
  let hScale = 1;
  let operands = [];
  let i = 0;

  const emit = (text, at) => {
    if (!text.trim()) return;
    const m = mul(at, ctm);
    const size = Math.abs(fontSize * Math.hypot(m[2], m[3])) || Math.abs(fontSize) || 10;
    out.push({ x: m[4], y: m[5], size, text });
  };

  const advance = (chars) => {
    const width = (chars * fontSize * 0.5 + chars * charSpacing) * hScale;
    tm = mul([1, 0, 0, 1, width, 0], tm);
  };

  const showString = (pdfString) => {
    const text = decodeString(font || FALLBACK_FONT, pdfString.bytes);
    emit(text, tm);
    advance(text.length);
  };

  const showArray = (array) => {
    const start = tm;
    let buffer = '';
    for (const item of array) {
      if (item instanceof PdfString) {
        buffer += decodeString(font || FALLBACK_FONT, item.bytes);
      } else if (typeof item === 'number') {
        const gap = (-item / 1000) * fontSize;
        if (gap > Math.abs(fontSize) * 0.17 && buffer && !buffer.endsWith(' ')) buffer += ' ';
        tm = mul([1, 0, 0, 1, gap * hScale, 0], tm);
      }
    }
    emit(buffer, start);
    advance(buffer.length);
  };

  const nextLine = (tx, ty) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };

  while (i < content.length) {
    const [value, next] = parseValue(content, i);
    if (next <= i || value === undefined) break;
    i = next;

    if (!(value instanceof Op)) {
      operands.push(value);
      if (operands.length > 40) operands.shift();
      continue;
    }

    const last = operands[operands.length - 1];
    const n = (fromEnd) => {
      const v = operands[operands.length - fromEnd];
      return typeof v === 'number' ? v : 0;
    };

    switch (value.op) {
      case 'q':
        graphicsStack.push(ctm);
        break;
      case 'Q':
        ctm = graphicsStack.pop() ?? ctm;
        break;
      case 'cm':
        if (operands.length >= 6) ctm = mul([n(6), n(5), n(4), n(3), n(2), n(1)], ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf':
        fontSize = n(1);
        if (operands[operands.length - 2] instanceof Name) {
          font = fonts.get(operands[operands.length - 2].name) ?? null;
        }
        break;
      case 'Td':
        nextLine(n(2), n(1));
        break;
      case 'TD':
        leading = -n(1);
        nextLine(n(2), n(1));
        break;
      case 'Tm':
        if (operands.length >= 6) {
          tlm = [n(6), n(5), n(4), n(3), n(2), n(1)];
          tm = tlm;
        }
        break;
      case 'T*':
        nextLine(0, -leading);
        break;
      case 'TL':
        leading = n(1);
        break;
      case 'Tc':
        charSpacing = n(1);
        break;
      case 'Tz':
        hScale = n(1) / 100 || 1;
        break;
      case 'Tj':
        if (last instanceof PdfString) showString(last);
        break;
      case 'TJ':
        if (Array.isArray(last)) showArray(last);
        break;
      case "'":
        nextLine(0, -leading);
        if (last instanceof PdfString) showString(last);
        break;
      case '"':
        charSpacing = n(2);
        nextLine(0, -leading);
        if (last instanceof PdfString) showString(last);
        break;
      case 'Do': {
        if (depth < 8 && last instanceof Name) {
          const ref = doc.resolve(resources?.XObject)?.[last.name];
          const xobject = doc.resolve(ref);
          const subtype = doc.resolve(xobject?.Subtype);
          if (xobject?.__stream && subtype instanceof Name && subtype.name === 'Form') {
            const matrix = doc.resolve(xobject.Matrix);
            const inner =
              Array.isArray(matrix) && matrix.length === 6
                ? mul(matrix.map((v) => doc.resolve(v) || 0), ctm)
                : ctm;
            const body = doc
              .streamData(xobject, ref instanceof Ref ? ref.num : 0)
              .toString('latin1');
            extractRuns(doc, body, doc.resolve(xobject.Resources) ?? resources, inner, depth + 1, out);
          }
        }
        break;
      }
      case 'BI': {
        // Inline image: its binary payload would lex as garbage, so step over it.
        const end = content.indexOf('EI', i);
        i = end < 0 ? content.length : end + 2;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
}

// ------------------------------------------------- lines, columns, paragraphs

/** Split a page's runs in two when there is a clear empty gutter down it. */
function splitColumns(runs, width) {
  if (runs.length < 40 || !width) return [runs];
  const occupied = new Array(100).fill(0);
  for (const run of runs) {
    const from = Math.max(0, Math.min(99, Math.floor((run.x / width) * 100)));
    const span = Math.max(1, Math.round(((run.text.length * run.size * 0.5) / width) * 100));
    for (let k = from; k < Math.min(100, from + span); k++) occupied[k]++;
  }

  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let k = 25; k < 75; k++) {
    if (occupied[k] === 0) {
      if (start < 0) start = k;
      if (k - start + 1 > bestLength) {
        bestLength = k - start + 1;
        bestStart = start;
      }
    } else {
      start = -1;
    }
  }
  if (bestLength < 4) return [runs];

  const cut = ((bestStart + bestLength / 2) / 100) * width;
  const left = runs.filter((run) => run.x < cut);
  const right = runs.filter((run) => run.x >= cut);
  const floor = runs.length * 0.2;
  if (left.length < floor || right.length < floor) return [runs];
  return [left, right];
}

/** Group runs that sit at the same height into lines, in reading order. */
function assembleLines(runs) {
  if (!runs.length) return [];
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;
  for (const run of sorted) {
    const tolerance = Math.max(1.5, run.size * 0.4);
    if (current && Math.abs(current.y - run.y) <= tolerance) {
      const gap = run.x - current.endX;
      const needsSpace =
        gap > run.size * 0.2 && !current.text.endsWith(' ') && !run.text.startsWith(' ');
      current.text += (needsSpace ? ' ' : '') + run.text;
      current.endX = run.x + run.text.length * run.size * 0.5;
      current.size = Math.max(current.size, run.size);
    } else {
      current = {
        y: run.y,
        x: run.x,
        endX: run.x + run.text.length * run.size * 0.5,
        size: run.size,
        text: run.text,
      };
      lines.push(current);
    }
  }
  return lines.filter((line) => line.text.trim());
}

/**
 * Lines back into paragraphs. The cue is the page's own vertical rhythm: a gap
 * wider than usual, a first-line indent, or a short line before it.
 */
function paragraphsFromLines(lines) {
  if (!lines.length) return '';
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  // The lower quartile approximates single-spaced leading even on a page that is
  // mostly paragraph breaks; the type size keeps it honest when there are only a
  // handful of lines to judge from.
  const quartile = gaps.length ? gaps[Math.floor(gaps.length * 0.25)] : 12;
  const sizes = lines.map((line) => line.size).sort((a, b) => a - b);
  const typeSize = sizes[Math.floor(sizes.length / 2)] || 10;
  const paragraphGap = Math.max(typeSize * 1.5, quartile * 1.25);

  const leftEdges = lines.map((line) => line.x).sort((a, b) => a - b);
  const margin = leftEdges[Math.floor(leftEdges.length * 0.15)] ?? 0;
  const widths = lines.map((line) => line.endX - line.x).sort((a, b) => a - b);
  const fullWidth = widths[Math.floor(widths.length * 0.75)] || 1;

  // A page knows which of its lines are headings, because it set them larger.
  // That is the one piece of structure worth carrying out of the layout, so it
  // leaves as a markdown marker the rest of the pipeline already understands.
  const heading = (line, text) =>
    line.size > typeSize * 1.15 && text.length >= 3 && text.length <= 120
      ? line.size > typeSize * 1.45
        ? '# '
        : '## '
      : '';

  let out = '';
  let previousWasHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const mark = heading(lines[i], text);

    if (!out) {
      out = mark + text;
      previousWasHeading = Boolean(mark);
      continue;
    }
    const previous = lines[i - 1];
    const indented = lines[i].x > margin + lines[i].size * 0.9;
    const previousWasShort = previous.endX - previous.x < fullWidth * 0.72;
    const wideGap = previous.y - lines[i].y > paragraphGap;
    const breaks = mark || previousWasHeading || wideGap || indented || previousWasShort;
    out += breaks ? `\n\n${mark}${text}` : `\n${text}`;
    previousWasHeading = Boolean(mark);
  }
  return out;
}

/**
 * Drop running heads, folios and footers: the short lines that recur at the
 * same place on many pages, and lines that are nothing but a page number.
 */
function stripRunningHeads(pages) {
  if (pages.length < 2) return pages;
  const counts = new Map();
  const key = (text) => text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

  for (const page of pages) {
    const seen = new Set();
    for (const line of [...page.slice(0, 2), ...page.slice(-2)]) {
      const k = key(line.text);
      if (k.length < 2 || k.length > 90 || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.floor(pages.length * 0.4));
  const repeated = new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([k]) => k),
  );

  // A title often matches its own running head word for word. Type size tells
  // them apart: the head is set small, the title is the largest thing on the page.
  const bodySize = (page) => {
    const sizes = page.map((line) => line.size).sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)] || 10;
  };

  return pages.map((page) => {
    const body = bodySize(page);
    return page.filter((line, index) => {
      if (index >= 2 && index < page.length - 2) return true;
      if (line.size > body * 1.3) return true;
      const text = line.text.trim();
      if (/^[-–—\s]*(\d{1,4}|[ivxlcdm]{1,7})[-–—\s]*$/i.test(text)) return false;
      return !repeated.has(key(text));
    });
  });
}

// ----------------------------------------------------------------- public api

/**
 * @param {Buffer} buffer raw bytes of a PDF
 * @returns {{text: string, pageCount: number, meta: object, ok: boolean, reason: string}}
 *   `ok` is false when too little text came out to be a real document — a scan,
 *   most likely, which the caller can hand to a model that can see it instead.
 */
export function extractPdf(buffer) {
  const result = { text: '', pageCount: 0, meta: {}, ok: false, reason: '' };
  if (!buffer?.length) {
    result.reason = 'empty file';
    return result;
  }
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    const at = buffer.subarray(0, 4096).indexOf('%PDF-');
    if (at < 0) {
      result.reason = 'not a pdf';
      return result;
    }
    buffer = buffer.subarray(at);
  }

  let doc;
  try {
    doc = new PdfDocument(buffer);
  } catch (error) {
    result.reason = `unreadable: ${error.message}`;
    return result;
  }
  if (doc.encryptionUnsupported) {
    result.reason = 'password protected';
    return result;
  }

  result.meta = doc.info();
  const pages = doc.pages();
  result.pageCount = pages.length;

  const perPage = [];
  for (const page of pages.slice(0, 2000)) {
    try {
      const box = doc.resolve(page.attrs.MediaBox);
      const width = Array.isArray(box)
        ? Math.abs(doc.resolve(box[2]) - doc.resolve(box[0])) || 612
        : 612;
      const runs = [];
      extractRuns(doc, doc.pageContent(page), doc.resolve(page.attrs.Resources) ?? {}, IDENTITY, 0, runs);
      const usable = runs.filter(
        (run) => run.text.trim() && Number.isFinite(run.x) && Number.isFinite(run.y),
      );
      perPage.push(splitColumns(usable, width).flatMap((column) => assembleLines(column)));
    } catch {
      perPage.push([]);
    }
  }

  result.text = stripRunningHeads(perPage)
    .map((lines) => paragraphsFromLines(lines))
    .filter((page) => page.trim())
    .join('\n\n');

  result.ok = result.text.replace(/\s/g, '').length > Math.max(40, pages.length * 12);
  if (!result.ok && !result.reason) {
    result.reason = result.text.trim()
      ? 'very little extractable text, probably a scan'
      : 'no extractable text, probably a scan';
  }
  return result;
}

export const internals = {
  parseValue,
  parseCMap,
  paragraphsFromLines,
  assembleLines,
  PdfDocument,
  Name,
  Ref,
  PdfString,
};
