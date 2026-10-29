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

/* ---------------------------------------------------------------- writer */

// Minimal .xlsx writer for the faculty export. Cells carry plain style objects
// ({ font, fill, border, align, numFmt }); identical styles are shared.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

const xml = (value) => String(value)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function styleSheet(defaultFont) {
  const fontXml = (f) => `<font>${f.bold ? '<b/>' : ''}${f.italic ? '<i/>' : ''}${f.underline ? '<u/>' : ''}`
    + `<sz val="${f.size}"/><color rgb="FF${f.color}"/><name val="${xml(f.name)}"/><family val="2"/></font>`;
  const edge = (side, b) => (b ? `<${side} style="${b.style || 'thin'}"><color rgb="FF${b.color}"/></${side}>` : `<${side}/>`);
  const fonts = [fontXml(defaultFont)];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const numFmts = [];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const ids = new Map();
  const indexOf = (list, item) => {
    let i = list.indexOf(item);
    if (i < 0) i = list.push(item) - 1;
    return i;
  };

  return {
    id(style) {
      if (!style) return 0;
      const key = JSON.stringify(style);
      if (ids.has(key)) return ids.get(key);
      const font = indexOf(fonts, fontXml({ ...defaultFont, ...style.font }));
      const fill = style.fill ? indexOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const b = style.border || {};
      const border = indexOf(borders, `<border>${edge('left', b.left)}${edge('right', b.right)}${edge('top', b.top)}${edge('bottom', b.bottom)}<diagonal/></border>`);
      const fmt = style.numFmt ? 164 + indexOf(numFmts, style.numFmt) : 0;
      const a = style.align || {};
      const align = `<alignment vertical="${a.v || 'center'}"${a.h ? ` horizontal="${a.h}"` : ''}${a.wrap ? ' wrapText="1"' : ''}${a.indent ? ` indent="${a.indent}"` : ''}/>`;
      const id = indexOf(xfs, `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`);
      ids.set(key, id);
      return id;
    },
    xml() {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xml(f)}"/>`).join('')}</numFmts>` : '')
        + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
        + `<fills count="${fills.length}">${fills.join('')}</fills>`
        + `<borders count="${borders.length}">${borders.join('')}</borders>`
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>';
    },
  };
}

/**
 * sheets: [{ name, base?, tabColor?, cols: [{ width }], rows: [{ height?, cells: [cell] }],
 *            merges?, freezeRows?, autoFilter?, printTitleRows?, landscape? }]
 * cell: null | { v: string | number, style?, link? }. `base` styles every empty cell.
 */
function writeXlsx({ sheets, font }) {
  const styles = styleSheet(font);
  const files = [];
  const definedNames = [];

  sheets.forEach((sheet, si) => {
    const base = styles.id(sheet.base);
    const links = [];
    let width = sheet.cols.length;
    const rowsXml = sheet.rows.map((row, ri) => {
      width = Math.max(width, row.cells.length);
      const r = ri + 1;
      const cells = row.cells.map((cell, ci) => {
        const ref = columnName(ci) + r;
        if (cell === null || cell === undefined || cell.v === null || cell.v === undefined || cell.v === '') {
          const s = cell?.style ? styles.id(cell.style) : base;
          return s ? `<c r="${ref}" s="${s}"/>` : '';
        }
        const s = styles.id(cell.style || sheet.base);
        if (cell.link) links.push({ ref, target: cell.link });
        return typeof cell.v === 'number'
          ? `<c r="${ref}" s="${s}"><v>${cell.v}</v></c>`
          : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.v)}</t></is></c>`;
      }).join('');
      const height = row.height ? ` ht="${row.height}" customHeight="1"` : '';
      return `<row r="${r}"${height}>${cells}</row>`;
    }).join('');

    const last = `${columnName(Math.max(width, 1) - 1)}${Math.max(sheet.rows.length, 1)}`;
    const quoted = `'${sheet.name.replace(/'/g, "''")}'`;
    if (sheet.autoFilter) {
      definedNames.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${si}" hidden="1">${quoted}!${sheet.autoFilter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>`);
    }
    if (sheet.printTitleRows) {
      definedNames.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${si}">${quoted}!$1:$${sheet.printTitleRows}</definedName>`);
    }

    const pane = sheet.freezeRows
      ? `<pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freezeRows + 1}" sqref="A${sheet.freezeRows + 1}"/>`
      : '';
    const cols = sheet.cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"${base ? ` style="${base}"` : ''}/>`).join('')
      + (base ? `<col min="${sheet.cols.length + 1}" max="16384" width="9" style="${base}"/>` : '');

    files.push({
      name: `xl/worksheets/sheet${si + 1}.xml`,
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheetPr>${sheet.tabColor ? `<tabColor rgb="FF${sheet.tabColor}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr>`
        + `<dimension ref="A1:${last}"/>`
        + `<sheetViews><sheetView workbookViewId="0" showGridLines="0"${si === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
        + '<sheetFormatPr defaultRowHeight="18" customHeight="1"/>'
        + `<cols>${cols}</cols>`
        + `<sheetData>${rowsXml}</sheetData>`
        + (sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : '')
        + (sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
        + (links.length ? `<hyperlinks>${links.map((l, i) => `<hyperlink ref="${l.ref}" r:id="rId${i + 1}"/>`).join('')}</hyperlinks>` : '')
        + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
        + `<pageSetup paperSize="9" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
        + '</worksheet>',
    });
    if (links.length) {
      files.push({
        name: `xl/worksheets/_rels/sheet${si + 1}.xml.rels`,
        data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + links.map((l, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(l.target)}" TargetMode="External"/>`).join('')
          + '</Relationships>',
      });
    }
  });

  const n = sheets.length;
  files.unshift(
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<bookViews><workbookView activeTab="0"/></bookViews>'
        + `<sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
        + (definedNames.length ? `<definedNames>${definedNames.join('')}</definedNames>` : '')
        + '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
        + '</Relationships>',
    },
    { name: 'xl/styles.xml', data: styles.xml() },
  );
  return writeZip(files);
}

module.exports = { readXlsxRows, writeXlsx, XlsxError };
