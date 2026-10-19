'use strict';

// Unit tests for roster parsing, name matching and the .xlsx reader.
// Run with: npm run test:unit   (uses made-up names only)

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { nameTokens, parseDelimitedText, rowsToStudents, sanitizeStudents, matchRoster, RosterError } = require('../lib/roster');
const { readXlsxRows } = require('../lib/xlsx');

const project = (id, teamName, members) => ({ id, teamName, members });
const statusOf = (report, name) => report.students.find((s) => s.name === name)?.status;

/* ----------------------------------------------------------- parsing */

test('nameTokens strips leading titles, punctuation, case and accents', () => {
  assert.deepEqual(nameTokens('Mr. Ravi  Kumar'), ['ravi', 'kumar']);
  assert.deepEqual(nameTokens('MS. ANITA DSOUZA'), ['anita', 'dsouza']);
  assert.deepEqual(nameTokens("Dr. José O'Neil"), ['jose', 'o', 'neil']);
  assert.deepEqual(nameTokens('Mr'), ['mr'], 'a lone word is kept even if it looks like a title');
});

test('rowsToStudents detects Roll Number / email / Student Name headers', () => {
  const { students, columns } = rowsToStudents([
    ['Roll Number', 'email', 'Student Name'],
    ['2025A1R001', '2025a1r001@college.in', 'Mr. Ravi Kumar'],
    ['2025A1R002', '2025a1r002@college.in', 'Ms. Anita Rao'],
    ['', '', ''],
  ]);
  assert.equal(students.length, 2);
  assert.deepEqual(students[0], { name: 'Mr. Ravi Kumar', rollNo: '2025A1R001', email: '2025a1r001@college.in' });
  assert.deepEqual(columns, { name: 'Student Name', rollNo: 'Roll Number', email: 'email' });
});

test('rowsToStudents accepts a single column of names without a header', () => {
  const { students, columns } = rowsToStudents([['Ravi Kumar'], ['Anita Rao'], ['']]);
  assert.deepEqual(students.map((s) => s.name), ['Ravi Kumar', 'Anita Rao']);
  assert.equal(columns.name, '');
});

test('rowsToStudents removes duplicates and rejects lists without a name column', () => {
  const { students } = rowsToStudents([['Name', 'Roll No'], ['Ravi Kumar', 'R1'], ['Ravi Kumar', 'R1'], ['Anita Rao', 'R2']]);
  assert.equal(students.length, 2);
  assert.throws(() => rowsToStudents([['Roll', 'Email'], ['R1', 'a@b.c']]), RosterError);
  assert.throws(() => rowsToStudents([['', '']]), RosterError);
});

test('parseDelimitedText handles Excel paste (TSV), quoted CSV and plain lines', () => {
  assert.deepEqual(parseDelimitedText('Roll\tName\r\nR1\tRavi Kumar'), [['Roll', 'Name'], ['R1', 'Ravi Kumar']]);
  assert.deepEqual(parseDelimitedText('Name,Note\n"Rao, Anita","said ""hi"""'), [['Name', 'Note'], ['Rao, Anita', 'said "hi"']]);
  assert.deepEqual(parseDelimitedText('Ravi Kumar\nAnita Rao'), [['Ravi Kumar'], ['Anita Rao']]);
});

test('sanitizeStudents re-validates client data', () => {
  assert.deepEqual(sanitizeStudents([{ name: '  Ravi   Kumar ', rollNo: 'R1', email: 'r@x.in', extra: 'ignored' }]),
    [{ name: 'Ravi Kumar', rollNo: 'R1', email: 'r@x.in' }]);
  assert.throws(() => sanitizeStudents([]), RosterError);
  assert.throws(() => sanitizeStudents('nope'), RosterError);
});

/* ---------------------------------------------------------- matching */

const ROSTER = [
  { name: 'Mr. Ravi Kumar', rollNo: '2025A1R001', email: '' },
  { name: 'Ms. Anita Rao', rollNo: '2025A1R002', email: '' },
  { name: 'Mr. Arjun Dev Singh Rathore', rollNo: '2025A1R003', email: '' },
  { name: 'Ms. Priya Sharma', rollNo: '2025A1R004', email: '' },
  { name: 'Mr. Priya Ranjan', rollNo: '2025A1R005', email: '' },
  { name: 'Ms. Meenakshi Iyer', rollNo: '2025A1R006', email: '' },
  { name: 'Mr. Zubin Mehta', rollNo: '2025A1R007', email: '' },
];

test('exact matches ignore titles, case and punctuation', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['RAVI KUMAR', 'anita rao.'])]);
  assert.equal(statusOf(r, 'Mr. Ravi Kumar'), 'submitted');
  assert.equal(statusOf(r, 'Ms. Anita Rao'), 'submitted');
  assert.equal(r.summary.submitted, 2);
});

test('one-letter typos in longer words still count as submitted', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['Meenakshy Iyer'])]);
  assert.equal(statusOf(r, 'Ms. Meenakshi Iyer'), 'submitted');
});

test('partial names are flagged as possible matches, not counted as submitted', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['Arjun Rathore'])]);
  assert.equal(statusOf(r, 'Mr. Arjun Dev Singh Rathore'), 'possible');
  assert.equal(r.summary.possible, 1);
  assert.equal(r.summary.submitted, 0);
});

test('a unique first name alone is a possible match; a shared first name is ambiguous', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['Zubin', 'Priya'])]);
  assert.equal(statusOf(r, 'Mr. Zubin Mehta'), 'possible');
  assert.equal(statusOf(r, 'Ms. Priya Sharma'), 'missing');
  assert.deepEqual(r.unmatched, [{ name: 'Priya', team: 'Alpha', reason: 'ambiguous' }]);
});

test('roll numbers typed as member names match exactly', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['2025a1r007'])]);
  assert.equal(statusOf(r, 'Mr. Zubin Mehta'), 'submitted');
});

test('unknown names are reported and everyone else is missing', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['Ravi Kumar', 'Someone Else'])]);
  assert.deepEqual(r.unmatched, [{ name: 'Someone Else', team: 'Alpha', reason: 'not-on-roster' }]);
  assert.deepEqual(r.summary, { total: 7, submitted: 1, possible: 0, missing: 6 });
  assert.equal(r.students.find((s) => s.status === 'submitted').matches[0].team, 'Alpha');
});

test('a single shared word is not enough to match', () => {
  const r = matchRoster(ROSTER, [project('p1', 'Alpha', ['Ravi Shastri'])]);
  assert.equal(statusOf(r, 'Mr. Ravi Kumar'), 'missing');
  assert.equal(r.unmatched.length, 1);
});

/* -------------------------------------------------------- xlsx reader */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Builds a minimal zip (deflated entries) in memory.
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('readXlsxRows reads shared strings, inline strings, numbers and gaps', () => {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const buf = zip({
    'xl/workbook.xml': `<workbook ${ns} xmlns:r="r"><sheets><sheet name="Class" sheetId="1" r:id="rId7"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Target="worksheets/data.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst ${ns}><si><t>Roll Number</t></si><si><t>Student Name</t></si><si><r><t>Mr. Ravi</t></r><r><t xml:space="preserve"> Kumar &amp; Co</t></r></si></sst>`,
    'xl/worksheets/data.xml': `<worksheet ${ns}><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2"><v>101</v></c><c r="C2" t="s"><v>2</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>102</t></is></c><c r="C3" t="inlineStr"><is><t>Anita Rao</t></is></c></row>
    </sheetData></worksheet>`,
  });
  assert.deepEqual(readXlsxRows(buf), [
    ['Roll Number', '', 'Student Name'],
    ['101', '', 'Mr. Ravi Kumar & Co'],
    ['102', '', 'Anita Rao'],
  ]);
});

test('readXlsxRows rejects files that are not spreadsheets', () => {
  assert.throws(() => readXlsxRows(Buffer.from('not a zip file at all, just text')), /not a valid \.xlsx/);
});
