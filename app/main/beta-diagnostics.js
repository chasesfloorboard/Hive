'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

async function readText(file) {
  try { return await fsp.readFile(file, 'utf8'); } catch { return ''; }
}

function finding(id, status, title, detail, severity = 'info') {
  return { id, status, title, detail, severity };
}

async function runSecurityAudit(root) {
  const main = await readText(path.join(root, 'app', 'main', 'main.js'));
  const preload = await readText(path.join(root, 'app', 'main', 'preload.js'));
  const html = await readText(path.join(root, 'app', 'renderer', 'index.html'));
  const packageText = await readText(path.join(root, 'package.json'));
  const findings = [];

  const checks = [
    ['context-isolation', /contextIsolation:\s*true/.test(main), 'Context isolation', 'Electron renderer context isolation is enabled.'],
    ['node-integration', /nodeIntegration:\s*false/.test(main), 'Node integration disabled', 'Renderer JavaScript cannot directly access Node.js APIs.'],
    ['sandbox', /sandbox:\s*true/.test(main), 'Renderer sandbox', 'Electron renderer sandbox is enabled.'],
    // This must fail loudly the moment script-src grants anything beyond
    // 'self' -- the previous check only confirmed 'self' was PRESENT, not
    // that nothing riskier (like 'unsafe-eval', currently granted for plugin
    // execution -- see index.html's CSP comment) was also granted. A check
    // that can silently pass next to a real eval hazard is worse than no
    // check at all.
    ['csp', (() => {
      const match = html.match(/Content-Security-Policy["'][^>]*content=["']([^"']*)["']/i);
      const policy = match ? match[1] : '';
      const scriptSrc = (policy.match(/script-src\s+([^;]+)/i) || [])[1] || '';
      return /'self'/.test(scriptSrc) && !/'unsafe-eval'|'unsafe-inline'/.test(scriptSrc);
    })(), 'Content Security Policy', 'The renderer declares a restrictive self-only script policy.'],
    ['csp-eval-hazard', !/script-src[^;]*'unsafe-eval'/i.test(html), 'No CSP eval grant', "script-src does not include 'unsafe-eval'."],
    ['preload-only-bridge', /contextBridge\.exposeInMainWorld\(['"]beehive['"]/.test(preload), 'Explicit preload bridge', 'Renderer privileged access is exposed through the Beehive preload bridge.'],
    ['no-eval', !/\beval\s*\(|new\s+Function\s*\(/.test(main + preload), 'No dynamic code execution', 'Main/preload do not contain eval() or new Function().'],
    ['private-app', /"private"\s*:\s*true/.test(packageText), 'Private package', 'The application package is marked private to avoid accidental npm publishing.'],
    ['license', /"license"\s*:\s*"MIT"/.test(packageText), 'License declared', 'The package declares its project license.'],
  ];
  for (const [id, ok, title, detail] of checks) findings.push(finding(id, ok ? 'PASS' : 'WARN', title, ok ? detail : `Expected hardening was not found: ${detail}`, ok ? 'info' : 'high'));

  const ipcNames = [...main.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  const duplicates = [...new Set(ipcNames.filter((name, i) => ipcNames.indexOf(name) !== i))];
  findings.push(finding('ipc-duplicates', duplicates.length ? 'FAIL' : 'PASS', 'Unique IPC registrations', duplicates.length ? `Duplicate IPC channels: ${duplicates.join(', ')}` : `${ipcNames.length} IPC registrations are unique.`, duplicates.length ? 'critical' : 'info'));

  const unsafeOpen = /setWindowOpenHandler/.test(main);
  findings.push(finding('window-open', unsafeOpen ? 'PASS' : 'WARN', 'Unexpected window creation', unsafeOpen ? 'Window-open handling is explicitly controlled.' : 'No setWindowOpenHandler guard was found; external window creation should be explicitly denied.', unsafeOpen ? 'info' : 'medium'));

  const navGuard = /will-navigate/.test(main);
  findings.push(finding('navigation-guard', navGuard ? 'PASS' : 'WARN', 'Unexpected navigation', navGuard ? 'Navigation is explicitly handled.' : 'No will-navigate guard was found; local app navigation should be explicitly controlled.', navGuard ? 'info' : 'medium'));

  const localFileGuard = /protocol\.handle\(['"]mbfile['"][\s\S]{0,1200}isPathInsideFolder/.test(main);
  findings.push(finding('local-file-boundary', localFileGuard ? 'PASS' : 'WARN', 'Local media boundary', localFileGuard ? 'The custom audio protocol is restricted to configured library folders.' : 'The custom audio protocol should reject paths outside configured library folders.', localFileGuard ? 'info' : 'high'));
  const temporaryHttps = /cover:loadTemporary[\s\S]{0,500}Temporary artwork URL must use HTTPS/.test(main);
  findings.push(finding('temporary-artwork-https', temporaryHttps ? 'PASS' : 'WARN', 'Temporary artwork transport', temporaryHttps ? 'Temporary artwork loading requires HTTPS.' : 'Temporary artwork loading should reject cleartext HTTP.', temporaryHttps ? 'info' : 'medium'));

  return { generatedAt: new Date().toISOString(), findings, score: scoreFindings(findings) };
}

function scoreFindings(findings) {
  if (!findings.length) return 100;
  const weights = { critical: 30, high: 18, medium: 8, info: 0 };
  const penalty = findings.reduce((n, f) => f.status === 'PASS' ? n : n + (weights[f.severity] || 2), 0);
  return Math.max(0, 100 - penalty);
}

async function runLibraryHealth(tracks = [], options = {}) {
  const list = Array.isArray(tracks) ? tracks : [];
  const concurrency = Math.max(4, Math.min(48, Number(options.concurrency) || 24));
  let cursor = 0;
  let missingFiles = 0, unreadableFiles = 0, missingTitle = 0, missingArtist = 0, missingAlbum = 0, missingArtwork = 0;
  const missing = [];
  const duplicates = new Map();

  for (const t of list) {
    const key = `${String(t.title || '').trim().toLowerCase()}\0${String(t.artist || '').trim().toLowerCase()}\0${Math.round(Number(t.duration) || 0)}`;
    if (!duplicates.has(key)) duplicates.set(key, []);
    duplicates.get(key).push(t.path);
    if (!String(t.title || '').trim()) missingTitle++;
    if (!String(t.artist || '').trim()) missingArtist++;
    if (!String(t.album || '').trim()) missingAlbum++;
    if (!t.hasArtwork && !t.artwork && !t.cover) missingArtwork++;
  }

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;
      const p = String(list[i]?.path || '');
      if (!p) { missingFiles++; continue; }
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) { missingFiles++; if (missing.length < 25) missing.push(path.basename(p)); }
      } catch (err) {
        if (err?.code === 'ENOENT') missingFiles++; else unreadableFiles++;
        if (missing.length < 25) missing.push(path.basename(p));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, list.length)) }, worker));

  const duplicateGroups = [...duplicates.values()].filter(group => group.length > 1).length;
  const status = missingFiles || unreadableFiles ? 'WARN' : 'PASS';
  return {
    generatedAt: new Date().toISOString(),
    tracks: list.length,
    missingFiles, unreadableFiles, missingTitle, missingArtist, missingAlbum, missingArtwork,
    duplicateGroups,
    missingSample: missing,
    status
  };
}

async function runEnvironmentAudit(root, paths = {}) {
  const findings = [];
  const logDir = paths.logDir || '';
  const tempDir = paths.tempDir || '';
  const libraryRoots = Array.isArray(paths.libraryRoots) ? paths.libraryRoots : [];
  const tempInsideLibrary = libraryRoots.some(r => {
    try { return tempDir && path.resolve(tempDir).startsWith(path.resolve(r) + path.sep); } catch { return false; }
  });
  findings.push(finding('temp-location', tempInsideLibrary ? 'FAIL' : 'PASS', 'Metadata temp location', tempInsideLibrary ? 'Temporary write space is inside a configured music folder.' : 'Temporary metadata space is outside configured music folders.', tempInsideLibrary ? 'critical' : 'info'));
  findings.push(finding('log-directory', logDir ? 'PASS' : 'WARN', 'Diagnostic log directory', logDir ? `Dedicated diagnostics: ${logDir}` : 'Dedicated diagnostic log directory is not configured.', logDir ? 'info' : 'medium'));

  const gst = path.join(root, 'app', 'native', 'gstreamer-player.c');
  try {
    const data = await fsp.readFile(gst);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    findings.push(finding('gstreamer-source', 'PASS', 'GStreamer source fingerprint', `SHA-256 ${hash}`, 'info'));
  } catch (err) {
    findings.push(finding('gstreamer-source', 'FAIL', 'GStreamer source fingerprint', err.message, 'high'));
  }

  const required = ['app/main/main.js', 'app/main/preload.js', 'app/renderer/renderer.js', 'resources/python/tag_helper.py', 'app/workers/database-worker.py', 'app/main/task-manager.js'];
  for (const rel of required) {
    try { await fsp.access(path.join(root, rel), fs.constants.R_OK); findings.push(finding(`file-${rel}`, 'PASS', `Required source: ${rel}`, 'Present and readable.')); }
    catch { findings.push(finding(`file-${rel}`, 'FAIL', `Required source: ${rel}`, 'Missing or unreadable.', 'high')); }
  }
  return { generatedAt: new Date().toISOString(), findings, score: scoreFindings(findings) };
}

module.exports = { runSecurityAudit, runLibraryHealth, runEnvironmentAudit, scoreFindings };
