#!/usr/bin/env node
// `npm test`: run every tests/*.test.js with Node's built-in test runner.
// Listing the files here (instead of a glob) keeps it working on every OS and Node 18+.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dir, f));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
