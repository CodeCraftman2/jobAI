const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const knowledge = require('../src/services/knowledge.service');
const syncServer = require('../src/services/sync.server');
const { parseProjects, cleanReadme } = require('../scripts/build-kb');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-kb-'));

const PROJECTS = [
  { title: 'Multi-Cloud Storage API', description: 'API for managing files across multiple cloud storage providers.', tags: ['API', 'Cloud', 'Backend'], details: 'Node.js service with S3 and Azure Blob adapters.' },
  { title: 'Study Reminders', description: 'Expo phone app that turns a study plan into daily notifications.', tags: ['React Native', 'Expo'], details: 'Parses PDF and CSV plans.' },
  { title: 'BitChord Jam Server', description: 'Realtime jam server.', tags: ['Go', 'Realtime'], details: 'WebSockets in Go.' },
];

test('knowledge: picks the projects that share words with the question', () => {
  const dir = tmpDir();
  knowledge.writeList('projects', PROJECTS, dir);
  const s = knowledge.contextFor('How did you handle cloud storage across providers?', { dir });
  assert.match(s, /About the candidate/);
  assert.match(s, /### Project: Multi-Cloud Storage API/);
  assert.match(s, /S3 and Azure/);
  assert.doesNotMatch(s, /### Project: Study Reminders/);
  assert.match(s, /Projects the candidate has built: Multi-Cloud Storage API; Study Reminders; BitChord Jam Server/);
});

test('knowledge: "tell me about your projects" lists the latest ones even with no shared word', () => {
  const dir = tmpDir();
  knowledge.writeList('projects', PROJECTS, dir);
  const s = knowledge.contextFor('Tell me about a project you are proud of', { dir });
  assert.match(s, /### Project: BitChord Jam Server/);
});

test('knowledge: empty folder or switched off adds nothing', () => {
  assert.equal(knowledge.contextFor('anything', { dir: tmpDir() }), '');
  const dir = tmpDir();
  knowledge.writeList('projects', PROJECTS, dir);
  process.env.JOBAI_KNOWLEDGE = 'false';
  try {
    assert.equal(knowledge.contextFor('cloud storage', { dir }), '');
  } finally {
    delete process.env.JOBAI_KNOWLEDGE;
  }
});

test('knowledge: the section stays under maxChars', () => {
  const dir = tmpDir();
  knowledge.writeList('projects', PROJECTS.map((p) => ({ ...p, details: 'cloud '.repeat(400) })), dir);
  const s = knowledge.contextFor('cloud', { dir, maxChars: 800 });
  assert.ok(s.length <= 800, `got ${s.length}`);
});

test('knowledge: answers and applications upsert by question and by link', () => {
  const dir = tmpDir();
  knowledge.addAnswers([{ label: 'Why do you want to work here?', answer: 'v1' }], dir);
  const r = knowledge.addAnswers([{ question: 'why do you want to work here', answer: 'v2' }, { question: 'Notice period', answer: '30 days' }], dir);
  assert.deepEqual(r, { added: 1, updated: 1 });
  const answers = knowledge.readList('answers', dir);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].answer, 'v2');

  knowledge.addApplications([{ title: 'Backend Engineer', company: 'Acme', link: 'https://jobs.acme.dev/1', status: 'Opened', nested: { x: 1 } }], dir);
  knowledge.addApplications([{ link: 'https://jobs.acme.dev/1', status: 'Applied', appliedOn: '2026-11-21' }], dir);
  const apps = knowledge.readList('applications', dir);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, 'Applied');
  assert.equal(apps[0].title, 'Backend Engineer');
  assert.equal(apps[0].nested, undefined, 'only plain values are stored');

  const s = knowledge.contextFor('Why do you want to work at Acme as a backend engineer?', { dir });
  assert.match(s, /Q: why do you want to work here\nA: v2/);
  assert.match(s, /- Backend Engineer at Acme \(Applied, 2026-11-21\)/);
});

test('llm: interview requests get the candidate section, DSA requests do not', () => {
  const dir = tmpDir();
  knowledge.writeList('projects', PROJECTS, dir);
  process.env.JOBAI_KB_DIR = dir;
  try {
    const llm = require('../src/services/llm.service');
    const ask = (skill) => {
      const req = { contents: [{ role: 'user', parts: [{ text: 'What did you build with Expo?' }] }], systemInstruction: { parts: [{ text: 'base prompt' }] } };
      llm.tagRoute(req, skill);
      llm.addCandidateContext(req);
      return req;
    };
    const interview = ask('interview');
    assert.equal(interview.systemInstruction.parts[0].text, 'base prompt');
    assert.match(interview.systemInstruction.parts[1].text, /### Project: Study Reminders/);
    assert.equal(JSON.stringify(interview).includes('_skill'), false, 'the tag is never serialised');
    assert.equal(ask('dsa').systemInstruction.parts.length, 1);
  } finally {
    delete process.env.JOBAI_KB_DIR;
  }
});

test('sync server: stores posts from an extension, refuses web pages', async () => {
  const dir = tmpDir();
  const server = await syncServer.start({ port: 0, dir });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  try {
    let res = await fetch(`${base}/v1/health`, { headers: { Origin: ext } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ext);

    res = await fetch(`${base}/v1/applications`, { method: 'OPTIONS', headers: { Origin: ext } });
    assert.equal(res.status, 204);

    res = await fetch(`${base}/v1/applications`, {
      method: 'POST', headers: { Origin: ext, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ title: 'SDE', company: 'Zeta', link: 'https://z.dev/1', status: 'Applied' }] }),
    });
    assert.deepEqual(await res.json(), { ok: true, added: 1, updated: 0 });
    res = await fetch(`${base}/v1/answers`, {
      method: 'POST', headers: { Origin: ext, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ question: 'Expected CTC', answer: '12 LPA' }] }),
    });
    assert.equal((await res.json()).added, 1);
    assert.equal(knowledge.readList('applications', dir)[0].company, 'Zeta');

    res = await fetch(`${base}/v1/answers`, {
      method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ question: 'x', answer: 'y' }] }),
    });
    assert.equal(res.status, 403);
    assert.equal(knowledge.readList('answers', dir).length, 1);

    res = await fetch(`${base}/v1/answers`, { method: 'POST', headers: { Origin: ext, 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('build-kb: reads the TypeScript project list and cleans READMEs', () => {
  const ts = `export type Project = { title: string }\n\nexport const projects: Project[] = [\n  {\n    title: "A \\"quoted\\" app",\n    description:\n      "Does things.",\n    image: "/i.webp",\n    link: "https://github.com/me/a-app",\n    tags: ["Go", 'Web'],\n  },\n  {\n    title: 'Second',\n    description: 'Two.',\n    link: "https://x.dev",\n    tags: [],\n  },\n]\n`;
  const p = parseProjects(ts);
  assert.equal(p.length, 2);
  assert.deepEqual(p[0], { title: 'A "quoted" app', description: 'Does things.', link: 'https://github.com/me/a-app', tags: ['Go', 'Web'] });
  assert.equal(p[1].title, 'Second');
  const md = cleanReadme('# App\n[![badge](https://b.svg)](https://x)\n<div align="center">Hi</div>\n```js\ncode()\n```\nSee [docs](https://d).');
  assert.doesNotMatch(md, /badge|code\(\)|<div|https/);
  assert.match(md, /See docs\./);
});

test('knowledge: the profile comes from CLAUDE.md sections, without contact details', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), [
    '# Workspace', 'Read chats.json first.', '',
    '## The job Asha wants', '- **Role:** lead generation', '',
    '## Candidate snapshot', '- Name: Asha · Delhi · +91-9876543210 · asha@example.com', '- LinkedIn: linkedin.com/in/asha', '- Highlights: won a pitch competition', '',
    '## How to help', '- Find openings.',
  ].join('\n'));
  const s = knowledge.contextFor('Why lead generation?', { dir });
  assert.match(s, /#### The job Asha wants\n- Role: lead generation/);
  assert.match(s, /won a pitch competition/);
  assert.doesNotMatch(s, /9876543210|asha@example|linkedin|How to help|chats\.json/);
  assert.match(s, /- Name: Asha · Delhi\n/, 'the name stays, so the model knows who the candidate is');

  fs.writeFileSync(path.join(dir, 'profile.md'), 'I am Asha, a sales fresher.');
  assert.match(knowledge.contextFor('anything', { dir }), /I am Asha, a sales fresher\./);
});

test('knowledge: a JobFill profile becomes facts, without contact details or matching rules', async () => {
  const dir = tmpDir();
  knowledge.setProfile({
    personal: { fullName: 'Asha Rao', city: 'Delhi', email: 'asha@example.com', phone: '+91 98765 43210', linkedin: 'https://linkedin.com/in/asha', website: 'asha.dev' },
    education: { degree: 'B.Tech', branch: 'CSE', college: 'ITER', startYear: '2022', graduationYear: '2026' },
    job: { expectedCTC: '300000', noticePeriod: 'Immediate', note: 'mail me at asha@example.com' },
    experience: [{ title: 'Android Developer (Intern)', company: 'Mobogage', start: 'May 2024', end: 'Jul 2024', type: 'internship' }],
    answers: { whyThisRole: 'I like research.' },
    rules: [{ match: ['x'], value: 'y' }],
  }, dir);
  const stored = fs.readFileSync(path.join(dir, 'profile.json'), 'utf8');
  assert.doesNotMatch(stored, /asha@example|98765|linkedin|rules|"website"/);
  const s = knowledge.contextFor('When can you join?', { dir });
  assert.match(s, /- Name: Asha Rao · Delhi/);
  assert.match(s, /Android Developer \(Intern\) at Mobogage, May 2024 – Jul 2024 \(internship\)/);
  assert.match(s, /Expected CTC: ₹3,00,000 a year \(₹25,000\/month\)/);
  assert.match(s, /Their own answer to "Why This Role": I like research\./);
  assert.throws(() => knowledge.setProfile([1], dir), /must be an object/);

  const server = await syncServer.start({ port: 0, dir });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/profile`, {
      method: 'POST', headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: { personal: { fullName: 'Asha B' } } }),
    });
    assert.equal(res.status, 200);
    assert.equal(knowledge.readProfile(dir).personal.fullName, 'Asha B');
  } finally {
    server.close();
  }
});
