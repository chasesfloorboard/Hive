# Hive In-App Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings-based diagnostic session that non-technical testers can start, exercise manually, and finish into a privacy-conscious local report without using a terminal.

**Architecture:** Add one focused main-process diagnostics module for session lifecycle, bounded evidence collection, redaction, and report formatting. Wire it through the existing preload bridge and Logs settings panel; reuse existing Hive session logs and audits instead of creating competing logging systems.

**Tech Stack:** Electron main/preload, vanilla renderer HTML/CSS/JS, Node.js `fs`, `os`, `child_process`, existing Hive diagnostics/audit APIs, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-16-hive-in-app-diagnostics-design.md`

## Global Constraints

- Do not require a terminal or shell command for the user-facing diagnostic flow.
- Do not upload diagnostics automatically.
- Never include full track metadata, tag contents, authentication tokens, Spotify credentials, or complete music-library listings.
- Redact configured music roots and music-library paths from copied logs.
- Diagnostic collection must not alter playback, library tags, favorites, queue, settings, or provider state.
- Preserve existing Hive UI and themed Settings/log surfaces.
- Never use `npm audit fix --force` or forced dependency churn.
- Development build artifacts use `Hive-1.0.0-pre-release-buildNN-purpose.zip` and remain in Editor Builds.

---

### Task 1: Diagnostic collector and lifecycle

**Files:**
- Create: `app/main/diagnostics.js`
- Test: `test/build216-in-app-diagnostics.test.js`

**Interfaces:**
- Produces `createDiagnosticsController(options)` with `startSession()`, `finishSession(options)`, `getStatus()`, and `openReportFolder()`.
- Produces `redactDiagnosticText(text, roots)` and `formatDiagnosticReport(data)` for deterministic tests.

- [ ] **Step 1: Write failing tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactDiagnosticText, formatDiagnosticReport, createDiagnosticsController } = require('../app/main/diagnostics');

test('diagnostic redaction removes music-library paths', () => {
  const input = 'file=/home/tester/Music/Secret Album/track.flac home=/home/tester';
  const out = redactDiagnosticText(input, ['/home/tester/Music']);
  assert.equal(out.includes('Secret Album/track.flac'), false);
  assert.equal(out.includes('/home/tester/Music'), false);
});

test('report formatter emits session and collection status without raw paths', () => {
  const text = formatDiagnosticReport({
    version: '1.0.0-rc.1', build: '216', session: { startedAt: '2026-09-16T00:00:00.000Z', endedAt: '2026-09-16T00:01:00.000Z' },
    sections: [{ name: 'Runtime', status: 'PASS', body: 'rss=123' }],
    warnings: []
  });
  assert.match(text, /Hive Diagnostic Report/);
  assert.match(text, /Runtime/);
  assert.doesNotMatch(text, /Secret Album/);
});

test('session lifecycle starts and finishes', async () => {
  const controller = createDiagnosticsController({ collect: async () => ({ sections: [], warnings: [] }), writeReport: async () => '/tmp/report.txt' });
  assert.equal(controller.getStatus().active, false);
  const started = controller.startSession();
  assert.equal(started.active, true);
  const finished = await controller.finishSession();
  assert.equal(finished.active, false);
  assert.equal(finished.reportPath, '/tmp/report.txt');
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run: `node --test test/build216-in-app-diagnostics.test.js`
Expected: FAIL because `app/main/diagnostics.js` does not exist yet.

- [ ] **Step 3: Implement the collector**

Implement the controller with these exact behaviors:

```js
function createDiagnosticsController({ userDataDir, version, build, getRuntime, getLogs, getAudits, execProbe, collect, writeReport, openPath }) { /* ... */ }
```

`startSession()` stores only timestamp/session id and returns `{active:true, startedAt, sessionId}`. `finishSession()` gathers bounded evidence, redacts paths, formats the report, writes `reports/diagnostics/hive-diagnostic-YYYYMMDD-HHMMSS.txt` with mode `0600`, and returns `{active:false, reportPath, warnings}`. If no session is active, it still creates a point-in-time report. Optional collection failures become warnings.

Use `execFile`-style command invocation with short timeouts for `uname -a`, `gst-launch-1.0 --version`, `gst-inspect-1.0 playbin3`, `wpctl --version`, and `pw-cli --version`; do not invoke through a shell.

Redact configured library roots and common `/home/<user>/Music/...` paths from copied log text. Cap each copied log section at 200 KiB and the final report at 2 MiB.

- [ ] **Step 4: Run the targeted test and verify it passes**

Run: `node --test test/build216-in-app-diagnostics.test.js`
Expected: PASS.

- [ ] **Step 5: Run syntax validation**

Run: `node --check app/main/diagnostics.js`
Expected: exit 0.

---

### Task 2: Main-process IPC bridge

**Files:**
- Modify: `app/main/main.js`
- Modify: `app/main/preload.js`
- Test: `test/build216-in-app-diagnostics.test.js`

**Interfaces:**
- IPC channels: `diagnostics:start`, `diagnostics:finish`, `diagnostics:status`, `diagnostics:open-folder`.
- Renderer bridge: `window.beehive.startDiagnostics()`, `finishDiagnostics()`, `getDiagnosticsStatus()`, `openDiagnosticsFolder()`.

- [ ] **Step 1: Extend failing/static tests**

```js
test('preload exposes the in-app diagnostic bridge', () => {
  const preload = require('fs').readFileSync(require('path').join(__dirname, '..', 'app/main/preload.js'), 'utf8');
  for (const name of ['startDiagnostics', 'finishDiagnostics', 'getDiagnosticsStatus', 'openDiagnosticsFolder']) assert.match(preload, new RegExp(name));
});

test('main registers the diagnostic IPC channels', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'app/main/main.js'), 'utf8');
  for (const name of ['diagnostics:start', 'diagnostics:finish', 'diagnostics:status', 'diagnostics:open-folder']) assert.match(main, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
```

- [ ] **Step 2: Run the targeted test and verify the new assertions fail**

Run: `node --test test/build216-in-app-diagnostics.test.js`
Expected: the bridge/channel assertions fail before wiring is added.

- [ ] **Step 3: Wire the controller into main/preload**

Instantiate one controller after the existing logging helpers are available. Pass existing `beehiveLogDir`, current session-log access, library-root configuration, `runSecurityAudit`, `runEnvironmentAudit`, and a lightweight runtime snapshot callback. Do not expose raw database records or full track arrays.

Register the four IPC handlers and expose the four preload methods. `diagnostics:finish` accepts no sensitive user data; it only finalizes the server-side session.

- [ ] **Step 4: Run the targeted tests**

Run: `node --test test/build216-in-app-diagnostics.test.js`
Expected: PASS.

- [ ] **Step 5: Run project static checks**

Run: `npm run check`
Expected: exit 0.

---

### Task 3: Settings UI and manual-test workflow

**Files:**
- Modify: `app/renderer/index.html`
- Modify: `app/renderer/renderer.js`
- Modify: `app/renderer/styles.css`
- Test: `test/build216-in-app-diagnostics.test.js`

**Interfaces:**
- UI ids: `settings-diagnostics-start`, `settings-diagnostics-finish`, `settings-diagnostics-open`, `settings-diagnostics-status`.

- [ ] **Step 1: Write failing UI wiring assertions**

```js
test('Settings Logs surface contains the diagnostic controls', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'app/renderer/index.html'), 'utf8');
  for (const id of ['settings-diagnostics-start', 'settings-diagnostics-finish', 'settings-diagnostics-open', 'settings-diagnostics-status']) assert.match(html, new RegExp(id));
});

test('renderer wires diagnostic actions', () => {
  const renderer = require('fs').readFileSync(require('path').join(__dirname, '..', 'app/renderer/renderer.js'), 'utf8');
  assert.match(renderer, /startDiagnostics/);
  assert.match(renderer, /finishDiagnostics/);
  assert.match(renderer, /openDiagnosticsFolder/);
});
```

- [ ] **Step 2: Run test and verify UI assertions fail**

Run: `node --test test/build216-in-app-diagnostics.test.js`
Expected: FAIL until the controls and handlers are present.

- [ ] **Step 3: Add the Settings card**

Place it inside the existing Logs panel, above the raw log viewer. Use Hive's existing button classes and no new native/un-themed popup. Copy:

```html
<div class="diagnostics-card">
  <div class="settings-section-title">Diagnostic session</div>
  <div class="settings-hint settings-section-copy">Start this before reproducing a problem. Hive records runtime evidence locally; it does not upload anything.</div>
  <div class="diagnostics-actions">
    <button id="settings-diagnostics-start" class="sidebar-add settings-primary-action" type="button">Start diagnostic session</button>
    <button id="settings-diagnostics-finish" class="sidebar-add" type="button" disabled>Finish &amp; save report</button>
    <button id="settings-diagnostics-open" class="sidebar-add" type="button">Open report folder</button>
  </div>
  <div id="settings-diagnostics-status" class="settings-status" aria-live="polite">No diagnostic session running.</div>
</div>
```

Add minimal themed spacing/status CSS using existing variables.

- [ ] **Step 4: Bind the controls**

On start, invoke `window.beehive.startDiagnostics()`, disable start, enable finish, and show the session timestamp. On finish, invoke `finishDiagnostics()`, restore the controls, show the saved report path, and offer the folder button. On open-folder, invoke the preload bridge and show any returned error without throwing. Refresh status when the Logs settings panel opens.

- [ ] **Step 5: Run tests and syntax checks**

Run: `node --test test/build216-in-app-diagnostics.test.js && node --check app/renderer/renderer.js`
Expected: PASS and exit 0.

---

### Task 4: Documentation and crash-course handoff

**Files:**
- Create: `docs/development-BUILD216-IN-APP-DIAGNOSTICS.md`
- Modify: `docs/TROUBLESHOOTING.md`
- Test: `test/build216-in-app-diagnostics.test.js`

- [ ] **Step 1: Document the exact manual workflow**

The build document must state that the tester needs no terminal: open Settings → Logs → Start diagnostic session, reproduce the supplied scenario, then Finish & save report. It must explain where the report is written and that Hive does not upload it.

- [ ] **Step 2: Add troubleshooting entry**

Add a short section telling users to use the in-app diagnostic session for playback, queue, Favorites, scanning, volume, artwork, MPRIS, startup, and performance problems, and to attach the generated report when requested.

- [ ] **Step 3: Add test assertions for documentation presence**

```js
test('Build 216 diagnostic documentation exists', () => {
  const fs = require('fs');
  const path = require('path');
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'docs/development-BUILD216-IN-APP-DIAGNOSTICS.md')), true);
});
```

- [ ] **Step 4: Run documentation/static test**

Run: `node --test test/build216-in-app-diagnostics.test.js && npm run check`
Expected: PASS.

---

### Task 5: Full validation and package Build 216

**Files:**
- Modify only validation/package metadata as required by the existing build workflow.
- Create: `/Hive/Development Builds/Editor Builds/Hive-1.0.0-pre-release-build216-in-app-diagnostics.zip`

- [ ] **Step 1: Run focused diagnostics tests**

Run: `node --test test/build216-in-app-diagnostics.test.js`
Expected: all Build 216 tests PASS.

- [ ] **Step 2: Run project checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: no new failures attributable to Build 216; record any existing environmental failure separately.

- [ ] **Step 4: Validate package contents**

Verify the new diagnostics module, Settings UI, documentation, tests, and executable `install.sh`/`run.sh` are present before zipping. Verify ZIP integrity with `unzip -t`.

- [ ] **Step 5: Package the exact Build 216 artifact**

Create `Hive-1.0.0-pre-release-build216-in-app-diagnostics.zip` in Editor Builds without overwriting earlier builds. Record SHA-256.

- [ ] **Step 6: Archive the exact artifact in the Hive Library**

Store the exact ZIP under `/Development Builds/Editor Builds/` while retaining the local package copy.

- [ ] **Step 7: Report validation honestly**

State which checks were static, which were runtime/package checks performed in this environment, and that the user's first real diagnostic-session run is the manual QA pass after installation.
