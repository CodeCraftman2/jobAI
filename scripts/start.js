#!/usr/bin/env node
// Cross-platform launcher: `npm start` and `npm run dev` call this.
// Electron refuses to open a window if ELECTRON_RUN_AS_NODE is set (VS Code
// and some shells set it), so it is removed before starting. Works on
// Windows, macOS and Linux; the old `env -u` form only worked in bash.
const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const dev = process.argv.includes('--dev');

let electron;
try {
  electron = require('electron'); // path to the electron binary
} catch (_) {
  console.error('Electron is not installed. Run `npm install` first.');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = ['.'];
if (dev) args.push('--no-sandbox', '--disable-gpu');

const child = spawn(electron, args, { cwd: root, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code === null ? 1 : code));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
