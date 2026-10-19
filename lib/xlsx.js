'use strict';

// Minimal .xlsx reader (first worksheet → rows of strings) using only Node's
// zlib, so the class roster can be imported without a spreadsheet dependency.

const zlib = require('zlib');

const MAX_ENTRY_BYTES = 20 * 1024 * 1024; // guards against zip bombs

class XlsxError extends Error {}

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError('This is not a valid .xlsx file.');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) throw new XlsxError('The .xlsx file is damaged.');
    const nameLen = buf.readUInt16LE(ptr + 28);
    entries.set(buf.toString('utf8', ptr + 46, ptr + 46 + nameLen), {
      method: buf.readUInt16LE(ptr + 10),
      size: buf.readUInt32LE(ptr + 20),
      offset: buf.readUInt32LE(ptr + 42),
    });
    ptr += 46 + nameLen + buf.readUInt16LE(ptr + 30) + buf.readUInt16LE(ptr + 32);
  }

  return (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    const lo = entry.offset;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new XlsxError('The .xlsx file is damaged.');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const data = buf.subarray(start, start + entry.size);
    if (entry.method === 0) return data.toString('utf8');
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    throw new XlsxError('The .xlsx file uses an unsupported compression method.');
  };
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

// Concatenated text runs, ignoring phonetic hints (<rPh>).
const textOf = (xml) => decode([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(read) {
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  const rid = workbook && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1];
  const target = rid && rels && new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  if (!target) return 'xl/worksheets/sheet1.xml';
  return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
}

/** Returns the first worksheet as an array of rows (arrays of trimmed strings). */
function readXlsxRows(buf) {
  const read = readZip(buf);
  const shared = [...(read('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const sheet = read(firstSheetPath(read));
  if (!sheet) throw new XlsxError('The .xlsx file has no worksheet.');

  const rows = [];
  for (const [, rowXml] of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = m[1];
      const inner = m[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (v !== undefined) value = decode(v);
      row[ref ? columnIndex(ref) : row.length] = value.trim();
    }
    rows.push(Array.from(row, (c) => c ?? ''));
  }
  return rows;
}

module.exports = { readXlsxRows, XlsxError };
