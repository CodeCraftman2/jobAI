const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Facts about the candidate, kept as plain JSON files in one shared folder
 * (JOBAI_KB_DIR, default ~/career-kb) so other tools can write to it:
 *
 *   projects.json      [{ title, description, tags[], link, details }]  scripts/build-kb.js
 *   applications.json  [{ title, company, link, status, appliedOn, ... }] JobFill, via sync.server.js
 *   answers.json       [{ question, answer, saved }]                      JobFill, via sync.server.js
 *
 * plus profile.md (or the profile sections of a CLAUDE.md in the same folder),
 * which is always included.
 *
 * For each interview question only the few entries that share words with it
 * are added to the system prompt, so a small local model's context still fits.
 */

const FILES = { projects: 'projects.json', applications: 'applications.json', answers: 'answers.json' };
const LIMITS = { applications: 5000, answers: 2000 };
const DEFAULT_MAX_CHARS = 3200;
const STOP = new Set(('the and for are was were with that this have has had you your yours our ours they them their ' +
  'what which who whom when where why how can could would should will shall may might must about into from over ' +
  'under than then there here been being does did doing done tell give explain describe talk walk through me my mine ' +
  'please some any all each one two more most very just also only not but its it\'s use used using like').split(/\s+/));
// Questions about the candidate's own work, answered from the projects even when no word matches.
const ABOUT_ME = /\b(your|you)\b.*\b(project|projects|built|build|worked|work|experience|portfolio|proud|challenge|yourself|background)\b|\btell me about yourself\b|\bwalk me through your\b/i;

const str = (v) => (v == null ? '' : String(v)).trim();
const norm = (s) => str(s).toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').replace(/\s+/g, ' ').trim();

function tokens(text) {
  const out = new Set();
  for (const w of norm(text).split(' ')) {
    const t = w.replace(/^\.+|\.+$/g, '');
    if (t.length >= 2 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function kbDir() {
  return process.env.JOBAI_KB_DIR || path.join(os.homedir(), 'career-kb');
}

function enabled() {
  return !/^(false|0|off|no)$/i.test(str(process.env.JOBAI_KNOWLEDGE));
}

// ---- storage -------------------------------------------------------------------

const cache = {};

function readList(kind, dir = kbDir()) {
  const file = path.join(dir, FILES[kind]);
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return []; }
  const hit = cache[file];
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.list;
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    list = Array.isArray(parsed) ? parsed.filter((x) => x && typeof x === 'object') : [];
  } catch (_) { /* a half-written or hand-broken file reads as empty */ }
  cache[file] = { mtimeMs: stat.mtimeMs, size: stat.size, list };
  return list;
}

/** Write atomically (temp file + rename) so a reader never sees half a file. */
function writeList(kind, list, dir = kbDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILES[kind]);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
  delete cache[file];
}

/** Insert or replace by key; the newest entries are kept when the list is over its limit. */
function upsert(kind, items, keyOf, dir = kbDir()) {
  const list = readList(kind, dir).slice();
  const index = new Map(list.map((x, i) => [keyOf(x), i]));
  let added = 0;
  let updated = 0;
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    if (index.has(key)) {
      list[index.get(key)] = { ...list[index.get(key)], ...item };
      updated++;
    } else {
      index.set(key, list.length);
      list.push(item);
      added++;
    }
  }
  const limit = LIMITS[kind];
  writeList(kind, limit && list.length > limit ? list.slice(-limit) : list, dir);
  return { added, updated };
}

const applicationKey = (a) => norm(a.link) || norm(`${a.company} ${a.title}`);
const answerKey = (a) => norm(a.question);

function cleanApplication(raw) {
  const a = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') a[k] = str(v).slice(0, 2000);
  }
  return a;
}

function addApplications(items, dir) {
  const clean = (Array.isArray(items) ? items : []).map(cleanApplication).filter(applicationKey);
  return upsert('applications', clean, applicationKey, dir);
}

function addAnswers(items, dir) {
  const clean = (Array.isArray(items) ? items : [])
    .map((x) => ({ question: str(x && (x.question || x.label)).slice(0, 500), answer: str(x && x.answer).slice(0, 4000), saved: str(x && x.saved) || new Date().toISOString().slice(0, 10) }))
    .filter((x) => x.question && x.answer);
  return upsert('answers', clean, answerKey, dir);
}

// ---- profile ---------------------------------------------------------------------
// A short always-included summary of who the candidate is and the job they want:
// profile.md when present, else the matching sections of the folder's CLAUDE.md
// (the job-search workspace keeps "The job ... wants" and "Candidate snapshot" there).
// Contact lines are left out: the model never needs a phone number or email.

const PROFILE_SECTION = /candidate|snapshot|job .*want|about me|profile|goals?/i;
const CONTACT = /\+?\d[\d\s-]{8,}\d|@[a-z0-9-]+\.[a-z]|linkedin\.com|github\.com|\.github\.io/i;

function profileText(dir = kbDir()) {
  const read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch (_) { return ''; } };
  let text = read('profile.md');
  if (!text) {
    const sections = read('CLAUDE.md').split(/\n(?=##\s)/).filter((s) => /^##\s/.test(s) && PROFILE_SECTION.test(s.split('\n')[0]));
    text = sections.join('\n\n');
  }
  // "Name: Asha · Delhi · +91… · asha@…" keeps "Name: Asha · Delhi"; a line of only links goes.
  const withoutContact = (line) => {
    if (!CONTACT.test(line)) return line;
    const kept = line.split(/\s+[·|]\s+/).filter((part) => !CONTACT.test(part));
    return kept.length && /\w/.test(kept.join('').replace(/^[\s*-]*[\w ]+:\s*$/, '')) ? kept.join(' · ') : null;
  };
  return text.split('\n').map(withoutContact).filter((line) => line !== null).join('\n')
    .replace(/^##\s+/gm, '#### ').replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- retrieval -------------------------------------------------------------------

function projectText(p) {
  return [p.title, p.description, (p.tags || []).join(', '), p.details].map(str).filter(Boolean).join('\n');
}

function applicationText(a) {
  const title = str(a.title || a.role || a.position || a['job title']);
  const company = str(a.company || a.employer || a.organisation || a.organization);
  const when = str(a.appliedOn || a.applied_on);
  const status = str(a.status);
  return `${title || 'a role'}${company ? ` at ${company}` : ''}${status ? ` (${status}${when ? `, ${when}` : ''})` : ''}`;
}

/** Rank docs by the rarer query words they contain (a word in every doc counts for little). */
function rank(docs, queryTokens) {
  if (!queryTokens.size || !docs.length) return [];
  const df = new Map();
  for (const d of docs) for (const t of d.tokens) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  return docs
    .map((d) => {
      let score = 0;
      for (const t of queryTokens) if (d.tokens.has(t)) score += Math.log(1 + n / df.get(t));
      return { ...d, score };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
}

const asDocs = (list, textOf) => list.map((item) => {
  const text = textOf(item);
  return { item, text, tokens: tokens(text) };
});

/**
 * The prompt section for one question, or '' when the knowledge base is empty
 * or switched off. `maxChars` caps the whole section.
 */
function contextFor(question, { dir = kbDir(), maxChars = Number(process.env.JOBAI_KB_MAX_CHARS) || DEFAULT_MAX_CHARS } = {}) {
  if (!enabled()) return '';
  const projects = readList('projects', dir);
  const answers = readList('answers', dir);
  const applications = readList('applications', dir);
  const profile = profileText(dir);
  if (!profile && !projects.length && !answers.length && !applications.length) return '';

  const q = tokens(question);
  let topProjects = rank(asDocs(projects, projectText), q).slice(0, 3).map((d) => d.item);
  if (!topProjects.length && ABOUT_ME.test(str(question))) topProjects = projects.slice(-3).reverse();
  const topAnswers = rank(asDocs(answers, (a) => `${a.question}\n${a.answer}`), q).slice(0, 3).map((d) => d.item);
  const topApps = rank(asDocs(applications, applicationText), q).slice(0, 3).map((d) => d.item);

  const blocks = [];
  if (profile) blocks.push(profile.slice(0, Math.floor(maxChars * 0.6)));
  if (projects.length) blocks.push(`Projects the candidate has built: ${projects.map((p) => str(p.title)).filter(Boolean).join('; ')}.`);
  for (const p of topProjects) {
    const details = str(p.details).slice(0, 700);
    blocks.push(`### Project: ${str(p.title)}\n${str(p.description)}${p.tags && p.tags.length ? `\nTech: ${p.tags.join(', ')}` : ''}${details ? `\n${details}` : ''}`);
  }
  if (topAnswers.length) {
    blocks.push('### Answers the candidate wrote before\n' + topAnswers.map((a) => `Q: ${str(a.question)}\nA: ${str(a.answer).slice(0, 500)}`).join('\n\n'));
  }
  if (topApps.length) blocks.push('### Related applications\n' + topApps.map((a) => `- ${applicationText(a)}`).join('\n'));

  const header = '## About the candidate (real facts)\n' +
    'Use these facts when the question is about the candidate\'s own projects, experience, skills or the jobs they applied for, ' +
    'and answer in the first person. Keep job titles, company names, dates and numbers exactly as written here; do not combine roles, ' +
    'promote a title or add facts that are not listed. Do not assume which company the interview is for. Ignore this section for general questions.\n\n';
  let body = '';
  for (const b of blocks) {
    const next = body ? `${body}\n\n${b}` : b;
    if (header.length + next.length > maxChars) {
      if (!body) body = b.slice(0, Math.max(0, maxChars - header.length));
      break;
    }
    body = next;
  }
  return body ? header + body : '';
}

module.exports = { kbDir, enabled, contextFor, profileText, addApplications, addAnswers, readList, writeList, tokens, FILES };
