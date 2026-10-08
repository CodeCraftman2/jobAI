#!/usr/bin/env node
// `npm run setup-ocr`: download the OCR language data ahead of time, the same
// way the Whisper model is fetched during setup. The app does this itself on
// first use; running it here just means the first screenshot is not slowed down.
const ocr = require('../src/services/ocr.service');

(async () => {
  console.log(`OCR data folder: ${ocr.dataDir()}`);
  const result = await ocr.install((line) => console.log(line));
  if (!result.ok) {
    console.error(`OCR setup failed: ${result.message}`);
    console.error('The app will try again the first time a screenshot needs OCR.');
    process.exit(1);
  }
  console.log('OCR is ready.');
})();
