'use strict';

// Class roster: turning an uploaded list into students, and matching roster
// names against the free-text member names typed into submissions.

const MAX_STUDENTS = 1000;
// Leading titles that are not part of a name ("Mr. Akhil …").
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'shri', 'sri', 'smt', 'kumari']);

class RosterError extends Error {}

const clean = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/** Lower-cased name words without punctuation, accents or leading titles. */
function nameTokens(name) {
  const tokens = String(name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens;
}

/* ------------------------------------------------------------ parsing */

function splitDelimited(line, delim) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === delim) { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/** CSV, TSV (rows pasted from Excel) or one name per line → rows. */
function parseDelimitedText(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const delim = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(',')) ? ',' : null;
  return lines.map((l) => (delim ? splitDelimited(l, delim) : [l.trim()]));
}

/** Rows (first may be a header) → [{ name, rollNo, email }]. */
function rowsToStudents(rows) {
  const filled = rows.map((r) => r.map((c) => clean(c, 200))).filter((r) => r.some(Boolean));
  if (!filled.length) throw new RosterError('The list is empty.');

  const header = filled[0].map((h) => h.toLowerCase());
  const col = (re, exclude) => header.findIndex((h) => re.test(h) && !(exclude && exclude.test(h)));
  let nameCol = col(/name/, /team|project|father|mother|guardian/);
  const rollCol = col(/roll|enrol|registration|reg\.? ?no|admission|\busn\b|\bprn\b|student id/);
  const emailCol = col(/e-?mail/);

  let body = filled.slice(1);
  let hasHeader = true;
  if (nameCol === -1) {
    hasHeader = false;
    // No recognisable header: accept a single column of names (first row included).
    if (!filled.every((r) => r.filter(Boolean).length === 1)) {
      throw new RosterError('Could not find a name column. Add a header row such as "Student Name", "Roll Number", "Email".');
    }
    nameCol = 0;
    body = filled.map((r) => [r.find(Boolean)]);
  }

  const seen = new Set();
  const students = [];
  for (const r of body) {
    const name = clean(r[nameCol], 80);
    if (!name || !nameTokens(name).length) continue;
    const student = {
      name,
      rollNo: rollCol >= 0 ? clean(r[rollCol], 40) : '',
      email: emailCol >= 0 ? clean(r[emailCol], 120) : '',
    };
    const key = student.rollNo ? `roll:${student.rollNo.toLowerCase()}` : `name:${nameTokens(name).join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    students.push(student);
  }
  if (!students.length) throw new RosterError('No student names were found in the list.');
  if (students.length > MAX_STUDENTS) throw new RosterError(`A roster can have at most ${MAX_STUDENTS} students.`);
  return {
    students,
    columns: {
      name: hasHeader ? filled[0][nameCol] : '',
      rollNo: hasHeader && rollCol >= 0 ? filled[0][rollCol] : '',
      email: hasHeader && emailCol >= 0 ? filled[0][emailCol] : '',
    },
  };
}

/** Validates a roster sent back by the client before it is saved. */
function sanitizeStudents(list) {
  if (!Array.isArray(list) || !list.length) throw new RosterError('The roster is empty.');
  if (list.length > MAX_STUDENTS) throw new RosterError(`A roster can have at most ${MAX_STUDENTS} students.`);
  return rowsToStudents([['Name', 'Roll Number', 'Email'], ...list.map((s) => [s?.name, s?.rollNo, s?.email])]).students;
}

/* ----------------------------------------------------------- matching */

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Same word, allowing one typo in words of 5+ letters ("Sharma" / "Sharmaa").
const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b));

/** 'exact' | 'partial' | null for a roster name vs. a submitted member name. */
function compareNames(rosterTokens, memberTokens) {
  const used = new Set();
  let common = 0;
  for (const m of memberTokens) {
    const idx = rosterTokens.findIndex((r, i) => !used.has(i) && sameWord(r, m));
    if (idx >= 0) {
      used.add(idx);
      common++;
    }
  }
  if (common === memberTokens.length && common === rosterTokens.length) return 'exact';
  if (common >= 2) return 'partial'; // e.g. "Arjun Rathore" vs "Arjun Dev Singh Rathore"
  return null;
}

// Names are often split differently ("Har Preet" / "Harpreet"), so each name is
// also tried with one pair of neighbouring words joined.
function spellings(tokens) {
  const out = [tokens];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push([...tokens.slice(0, i), tokens[i] + tokens[i + 1], ...tokens.slice(i + 2)]);
  }
  return out;
}

/** Best result over all spellings of both names: 'exact' | 'partial' | null. */
function compareSpellings(rosterSpellings, memberSpellings) {
  let best = null;
  for (const r of rosterSpellings) {
    for (const m of memberSpellings) {
      const kind = compareNames(r, m);
      if (kind === 'exact') return 'exact';
      if (kind) best = kind;
    }
  }
  return best;
}

/**
 * Matches roster students against submitted team members.
 * Students are 'submitted' (exact name or roll number), 'possible' (partial
 * match for faculty to confirm) or 'missing'. Member names that match nobody,
 * or several students equally, are returned as `unmatched`.
 */
function matchRoster(students, projects) {
  const roster = students.map((s) => {
    const tokens = nameTokens(s.name);
    const variants = spellings(tokens);
    // First names in every spelling: "Har Preet Gill" → "har", "harpreet".
    return { ...s, tokens, variants, firsts: new Set(variants.map((v) => v[0])), roll: s.rollNo.toLowerCase() };
  });
  const firstNameCount = new Map();
  for (const r of roster) for (const f of r.firsts) firstNameCount.set(f, (firstNameCount.get(f) || 0) + 1);

  const matches = roster.map(() => []);
  const unmatched = [];

  for (const project of projects) {
    for (const member of project.members) {
      const tokens = nameTokens(member);
      const raw = member.trim().toLowerCase();
      if (!tokens.length) continue;

      let kind = null;
      let hits = roster.flatMap((r, i) => (r.roll && r.roll === raw ? [i] : []));
      if (hits.length) kind = 'exact';
      if (!kind) {
        const exact = [];
        const partial = [];
        const memberSpellings = spellings(tokens);
        roster.forEach((r, i) => {
          const k = compareSpellings(r.variants, memberSpellings);
          if (k === 'exact') exact.push(i);
          else if (k === 'partial') partial.push(i);
        });
        if (exact.length) [kind, hits] = ['exact', exact];
        else if (partial.length) [kind, hits] = ['partial', partial];
        else if (tokens.length === 1 && firstNameCount.get(tokens[0])) {
          // A lone first name: a possible match if only one student has it,
          // otherwise reported as ambiguous below.
          [kind, hits] = ['partial', roster.flatMap((r, i) => (r.firsts.has(tokens[0]) ? [i] : []))];
        }
      }

      if (!kind || hits.length !== 1) {
        unmatched.push({ name: member, team: project.teamName, reason: hits.length > 1 ? 'ambiguous' : 'not-on-roster' });
        continue;
      }
      matches[hits[0]].push({ member, team: project.teamName, projectId: project.id, kind });
    }
  }

  const report = roster.map((r, i) => {
    const found = matches[i];
    const status = found.some((m) => m.kind === 'exact') ? 'submitted' : found.length ? 'possible' : 'missing';
    return { name: r.name, rollNo: r.rollNo, email: r.email, status, matches: found };
  });
  const count = (s) => report.filter((r) => r.status === s).length;
  return {
    summary: { total: report.length, submitted: count('submitted'), possible: count('possible'), missing: count('missing') },
    students: report,
    unmatched,
  };
}

module.exports = { RosterError, nameTokens, parseDelimitedText, rowsToStudents, sanitizeStudents, matchRoster };
