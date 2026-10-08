#!/usr/bin/env node
// `npm run test:electron`: the tests that need a real Electron (image shrinking,
// the OS keychain, OCR in the Electron process). Needs a desktop session.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jobai-et-')), 'report.txt');
env.JOBAI_TEST_OUT = report;

const result = spawnSync(electron, [path.join(__dirname, '..', 'tests', 'electron', 'main.js')], { env, stdio: 'inherit' });
if (fs.existsSync(report)) console.log(fs.readFileSync(report, 'utf8'));
else console.error('Electron produced no test report (is a desktop session available?).');
process.exit(result.status === null ? 1 : result.status);
