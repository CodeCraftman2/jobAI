#!/usr/bin/env node
/**
 * `npm run kb` — build projects.json in the knowledge folder from your portfolio.
 *
 * Reads every project in <portfolio>/src/content/projects.ts, then its README:
 * from a local clone next to the portfolio when there is one, else from GitHub.
 * With --ai, a local Ollama model turns each README into short interview notes
 * (what it does, stack, how it works, challenges). Notes are kept until the
 * README changes, so re-running is quick.
 *
 *   node scripts/build-kb.js [--portfolio X:\yagya-portfolio] [--ai] [--model qwen3.5:4b]
 *
 * Env: JOBAI_KB_DIR (output folder), JOBAI_PORTFOLIO_DIR, OLLAMA_HOST.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const knowledge = require('../src/services/knowledge.service');

function args(argv) {
  const out = { ai: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ai') out.ai = true;
    else if (a === '--portfolio') out.portfolio = argv[++i];
    else if (a === '--model') out.model = argv[++i];
  }
  return out;
}

/** The project objects in projects.ts, read field by field (the file is TypeScript, not JSON). */
function parseProjects(source) {
  const start = source.indexOf('projects');
  const body = start === -1 ? source : source.slice(start);
  const projects = [];
  for (const block of body.split(/\n\s*\{\s*\n/).slice(1)) {
    const field = (name) => {
      const m = block.match(new RegExp(`\\b${name}:\\s*(?:\\n\\s*)?("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`[^\`]*\`)`));
      return m ? m[1].slice(1, -1).replace(/\\(["'\\])/g, '$1') : '';
    };
    const tagsMatch = block.match(/\btags:\s*\[([^\]]*)\]/);
    const tags = tagsMatch ? [...tagsMatch[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]) : [];
    const title = field('title');
    if (title) projects.push({ title, description: field('description'), link: field('link'), tags });
  }
  return projects;
}

function githubRepo(link) {
  const m = String(link || '').match(/github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/i, '') } : null;
}

/** Plain text from a README: no images, badges, HTML or long code blocks. */
function cleanReadme(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000);
}

async function readReadme(project, portfolioDir) {
  const gh = githubRepo(project.link);
  if (!gh) return '';
  const local = path.join(path.dirname(path.resolve(portfolioDir)), gh.repo);
  for (const name of ['README.md', 'readme.md', 'Readme.md', 'README']) {
    const file = path.join(local, name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/README.md`, { signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.text() : '';
  } catch (_) {
    return '';
  }
}

async function aiNotes(project, readme, model) {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '').replace(/^(?!https?:)/, 'http://');
  const prompt = `Write interview notes for the candidate's own project, using ONLY the README below. ` +
    `No markdown headings. At most 120 words, as 4 short lines:\n` +
    `What it does: ...\nTech: ...\nHow it works: ...\nInteresting challenge: ... (write "not stated" if the README does not say)\n\n` +
    `Project: ${project.title} - ${project.description}\n\nREADME:\n${readme.slice(0, 5000)}`;
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, think: false, options: { num_ctx: 4096, temperature: 0.2 } }),
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return String((data.message && data.message.content) || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function main() {
  const opt = args(process.argv.slice(2));
  const portfolioDir = opt.portfolio || process.env.JOBAI_PORTFOLIO_DIR || path.resolve(__dirname, '..', '..', 'yagya-portfolio');
  const model = opt.model || process.env.JOBAI_KB_MODEL || 'qwen3.5:4b';
  const file = path.join(portfolioDir, 'src', 'content', 'projects.ts');
  if (!fs.existsSync(file)) throw new Error(`No projects file at ${file}. Pass --portfolio <folder>.`);

  const projects = parseProjects(fs.readFileSync(file, 'utf8'));
  const previous = new Map(knowledge.readList('projects').map((p) => [p.title, p]));
  const out = [];
  for (const p of projects) {
    const readme = cleanReadme(await readReadme(p, portfolioDir));
    const readmeHash = readme ? crypto.createHash('sha1').update(readme).digest('hex').slice(0, 12) : '';
    const old = previous.get(p.title);
    let details = readme.slice(0, 1500);
    let notes = old && old.readmeHash === readmeHash && old.aiNotes ? old.details : '';
    if (!notes && opt.ai && readme) {
      try {
        process.stdout.write(`  asking ${model} about ${p.title}... `);
        notes = await aiNotes(p, readme, model);
        console.log('done');
      } catch (error) {
        console.log(`skipped (${error.message})`);
      }
    }
    if (notes) details = notes;
    out.push({ ...p, details, readmeHash, ...(notes ? { aiNotes: true } : {}) });
    console.log(`${notes ? '+' : readme ? '~' : '-'} ${p.title}${readme ? '' : ' (no README found)'}`);
  }
  knowledge.writeList('projects', out);
  console.log(`\nWrote ${out.length} projects to ${path.join(knowledge.kbDir(), 'projects.json')}`);
  if (!opt.ai) console.log('Tip: add --ai to have Ollama write interview notes from each README.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { parseProjects, cleanReadme, githubRepo };
