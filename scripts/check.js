'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = ['main.js', 'preload.js', 'scanner-worker.js', 'metadata-worker.js', 'discord-presence.js', 'mpris.js', 'wav-id3.js', 'src/renderer.js'];
for (const file of files) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (packageJson.version !== lockJson.version || packageJson.version !== lockJson.packages?.['']?.version) throw new Error('package.json and package-lock.json versions differ.');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
if (!/contextIsolation:\s*true/.test(main) || !/nodeIntegration:\s*false/.test(main) || !/sandbox:\s*true/.test(main)) throw new Error('Electron security boundary regression.');
if (!/contextBridge\.exposeInMainWorld/.test(preload)) throw new Error('Preload bridge missing.');
console.log(`Validated ${files.length} JavaScript entry points and Electron security flags.`);
