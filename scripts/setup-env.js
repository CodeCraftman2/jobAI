#!/usr/bin/env node
// `npm run setup`: create .env from env.example if it does not exist yet.
// API keys are not put in .env; the app stores them in the OS keychain when
// you enter them in the setup wizard or Settings.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const target = path.join(root, '.env');
const example = path.join(root, 'env.example');

if (fs.existsSync(target)) {
  console.log('.env already exists, leaving it as it is.');
} else {
  fs.copyFileSync(example, target);
  console.log('Created .env from env.example.');
}
console.log('\nNext: run `npm start`. The setup wizard asks for your Gemini key');
console.log('(required) and an optional OpenRouter/Kilo key or curl command.');
console.log('Keys are saved to your OS keychain, not to .env.');
