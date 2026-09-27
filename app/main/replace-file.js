'use strict';

// Replace `target` with the finished `temp` file (the last step of every
// metadata write). On Linux a rename replaces the file even while another
// process has it open. Windows refuses (EPERM/EBUSY/EACCES) while anything
// holds the file open -- Hive's own audio helper, but also briefly the Windows
// Search indexer, antivirus scans or Explorer thumbnails -- so retry there for
// a while before giving up with a message a user can act on.
const fs = require('fs');
const fsp = fs.promises;

const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function replaceFile(temp, target, {
  platform = process.platform,
  retryForMs = 20000,
  rename = (a, b) => fsp.rename(a, b),
  copyOver = async (a, b) => { await fsp.copyFile(a, b); await fsp.unlink(a); },
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const started = Date.now();
  for (let delay = 100; ; delay = Math.min(delay * 2, 2000)) {
    try {
      await rename(temp, target);
      return;
    } catch (err) {
      if (err?.code === 'EXDEV') { await copyOver(temp, target); return; }
      if (platform !== 'win32' || !LOCKED_CODES.has(err?.code)) throw err;
      if (Date.now() - started >= retryForMs) {
        const locked = new Error(`Could not save "${target}": the file is open in another program. Close it there and try again.`);
        locked.code = err.code;
        locked.cause = err;
        throw locked;
      }
      await sleep(delay);
    }
  }
}

module.exports = { replaceFile };
