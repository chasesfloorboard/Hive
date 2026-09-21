'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAX_LOG_BYTES = 200 * 1024;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_WARNINGS = 100;

function clampText(value, maxBytes = MAX_LOG_BYTES) {
  const text = String(value ?? '');
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return `${buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8')}\n[truncated to ${Math.round(maxBytes / 1024)} KiB]`;
}

function redactDiagnosticText(value, roots = []) {
  let text = String(value ?? '');
  const normalizedRoots = roots.map(root => String(root || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const root of normalizedRoots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(escaped.replace(/[\\/]$/, '') + '(?:[\\/][^\\s"\'<>]*)*', 'gi'), '<music-library-path>');
  }
  text = text.replace(/\/home\/[^\s"'<>]+\/Music(?:[\/][^\s"'<>]*)*/gi, '<music-library-path>');
  text = text.replace(/(?:[A-Z]:[\\/])[^\s"'<>]+[\\/]Music(?:[\\/][^\s"'<>]*)*/gi, '<music-library-path>');
  text = text.replace(/(?:Bearer|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|shared[_-]?secret|api[_-]?key)\s*[:=]\s*[^\s,}]+/gi, '$1=<redacted>');
  return text;
}

function formatSection(section) {
  const status = String(section?.status || 'INFO').toUpperCase();
  return [`[${status}] ${String(section?.name || 'Diagnostic')}`, clampText(section?.body || '', MAX_LOG_BYTES)].join('\n');
}

function formatDiagnosticReport(data = {}) {
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const session = data.session || {};
  const header = [
    'Hive Diagnostic Report',
    '=======================',
    `Generated: ${new Date().toISOString()}`,
    `Hive version: ${data.version || 'unknown'}`,
    `Build: ${data.build || 'unknown'}`,
    `Session started: ${session.startedAt || 'not started'}`,
    `Session ended: ${session.endedAt || 'point-in-time'}`,
    `Session elapsed: ${Number.isFinite(Number(session.elapsedMs)) ? `${Math.round(Number(session.elapsedMs) / 1000)} seconds` : 'unknown'}`,
    '',
    'This report was generated locally by Hive. It is not uploaded automatically.',
    'Music-library paths and sensitive credential-like values are redacted.',
    ''
  ];
  const body = sections.map(formatSection).join('\n\n');
  const warningText = warnings.length ? `\n\n[WARNINGS]\n${warnings.slice(0, MAX_WARNINGS).map(w => `- ${String(w)}`).join('\n')}` : '';
  const report = `${header.join('\n')}\n${body}${warningText}\n\nEND OF REPORT\n`;
  return Buffer.from(report, 'utf8').subarray(0, MAX_REPORT_BYTES).toString('utf8');
}

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

async function runProbe(command, args = [], timeout = 2500) {
  try {
    const result = await execFileAsync(command, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 });
    return { ok: true, text: clampText(`${result.stdout || ''}${result.stderr || ''}`, 32 * 1024).trim() || 'No output.' };
  } catch (err) {
    return { ok: false, text: err?.code === 'ENOENT' ? 'Not installed / not found.' : (err?.message || String(err)) };
  }
}

function createDiagnosticsController(options = {}) {
  const {
    userDataDir = os.tmpdir(), version = 'unknown', build = 'unknown',
    getRuntime = async () => ({}), getLogs = async () => ({}), getAudits = async () => [],
    writeReport = async (filePath, text) => { await fsp.writeFile(filePath, text, { encoding: 'utf8', mode: 0o600 }); return filePath; },
    openPath = async () => '', onStart = async () => {}, onFinish = async () => {}
  } = options;
  let activeSession = null;

  function status() {
    return activeSession ? { active: true, startedAt: activeSession.startedAt, sessionId: activeSession.sessionId } : { active: false, startedAt: null, sessionId: null };
  }

  function startSession() {
    if (activeSession) return status();
    activeSession = { sessionId: `${Date.now()}-${process.pid}`, startedAt: new Date().toISOString(), startedMs: Date.now(), events: [] };
    try { onStart(activeSession); } catch {}
    return status();
  }

  async function collectReport(session) {
    const warnings = [];
    const sections = [];
    const events = Array.isArray(session.events) ? session.events : [];
    if (events.length) sections.push({ name: 'Diagnostic action timeline', status: 'INFO', body: clampText(events.map(e => `${e.at}	${e.phase}${e.detail ? `	${e.detail}` : ''}`).join('\n'), MAX_LOG_BYTES) });
    let runtime = {};
    let logs = {};
    let audits = [];
    try { runtime = await getRuntime(); } catch (err) { warnings.push(`Runtime snapshot failed: ${err?.message || String(err)}`); }
    try { logs = await getLogs(); } catch (err) { warnings.push(`Log collection failed: ${err?.message || String(err)}`); }
    try { audits = await getAudits(); } catch (err) { warnings.push(`Audit collection failed: ${err?.message || String(err)}`); }

    const roots = Array.isArray(runtime?.libraryRoots) ? runtime.libraryRoots : [];
    sections.push({ name: 'Runtime', status: 'PASS', body: redactDiagnosticText(JSON.stringify({
      platform: process.platform, arch: process.arch, node: process.version, hostname: os.hostname(),
      uptimeSeconds: Math.round(os.uptime()), loadAverage: os.loadavg(), memory: {
        total: os.totalmem(), free: os.freemem(), process: process.memoryUsage()
      }, app: runtime
    }, null, 2), roots) });

    const current = logs?.crash || logs?.startup || logs?.combined || '';
    const scan = logs?.scan || '';
    if (current) sections.push({ name: 'Hive session log (recent)', status: 'INFO', body: redactDiagnosticText(clampText(current), roots) });
    if (scan) sections.push({ name: 'Library scan log (recent)', status: 'INFO', body: redactDiagnosticText(clampText(scan), roots) });

    for (const audit of Array.isArray(audits) ? audits : []) {
      const body = redactDiagnosticText(JSON.stringify(audit, null, 2), roots);
      sections.push({ name: audit?.name || 'Audit', status: audit?.status || 'INFO', body });
    }

    const probes = await Promise.all([
      ['Host: uname', 'uname', ['-a']],
      ['Host: GStreamer', 'gst-launch-1.0', ['--version']],
      ['Host: GStreamer playbin3', 'gst-inspect-1.0', ['playbin3']],
      ['Host: PipeWire', 'wpctl', ['--version']],
      ['Host: PipeWire CLI', 'pw-cli', ['--version']]
    ].map(async ([name, command, args]) => [name, await runProbe(command, args)]));
    for (const [name, result] of probes) {
      sections.push({ name, status: result.ok ? 'PASS' : 'WARN', body: result.text });
      if (!result.ok) warnings.push(`${name}: ${result.text}`);
    }

    return { session, sections, warnings };
  }

  async function finishSession() {
    const session = activeSession ? { ...activeSession } : { sessionId: `point-${Date.now()}-${process.pid}`, startedAt: null, startedMs: Date.now() };
    const endedAt = new Date().toISOString();
    const collected = await collectReport({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt,
      elapsedMs: session.startedMs ? Date.now() - session.startedMs : 0,
      events: Array.isArray(session.events) ? session.events.slice() : []
    });
    const dir = path.join(userDataDir, 'reports', 'diagnostics');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const reportPath = path.join(dir, `hive-diagnostic-${stamp()}.txt`);
    const text = formatDiagnosticReport({ version, build, session: collected.session, sections: collected.sections, warnings: collected.warnings });
    await writeReport(reportPath, text);
    try { onFinish(session); } catch {}
    activeSession = null;
    return { active: false, reportPath, warnings: collected.warnings };
  }

  async function openReportFolder() {
    const dir = path.join(userDataDir, 'reports', 'diagnostics');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const error = await openPath(dir);
    return { dir, error: error || '' };
  }

  function mark(phase, detail = null) {
    if (!activeSession) return { active: false };
    activeSession.events.push({ at: new Date().toISOString(), phase: String(phase || 'UNKNOWN'), detail: detail == null ? '' : String(detail) });
    if (activeSession.events.length > 500) activeSession.events.splice(0, activeSession.events.length - 500);
    return { active: true };
  }

  return { startSession, finishSession, getStatus: status, openReportFolder, mark };
}

module.exports = { redactDiagnosticText, formatDiagnosticReport, createDiagnosticsController, runProbe };
