const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');

function assert(condition, message) { if (!condition) throw new Error(message); }

assert(/data-settings-tab="plugins"/.test(html), 'Settings must expose a dedicated Plugins tab.');
assert(/role="tablist"/.test(html), 'Settings tabs must expose an accessible tablist.');
assert(/role="tab"/.test(html) && /role="tabpanel"/.test(html), 'Settings tabs/panels need ARIA roles.');
assert(/plugin-import-btn/.test(html), 'Plugins settings need an import/install action.');
assert(/plugin-settings-modal/.test(renderer), 'Plugin settings renderer must provide a dedicated plugin settings modal.');
assert(/dataset\.pluginSettingsId/.test(renderer), 'Installed plugins must expose a per-plugin settings action.');
// The first-party Monstercat Visualizer plugin was removed -- it never worked
// under this app's CSP (plugins:run executes plugin code via
// `new Function(...)`, which requires 'unsafe-eval') and is being rewritten.
// See test/plugin-platform-v3.test.js for the "no first-party plugin bundled
// right now" assertion; this file only needs the Settings/Plugins UI itself.
assert(/Podcasts is a sidebar destination, not a default pinned top-bar tab/.test(renderer), 'Podcasts must remain unpinned by default.');
assert(/podcast-info/.test(renderer), 'Podcast no-lyrics state must have a dedicated info presentation.');
assert(/ArrowRight|ArrowLeft|Home|End/.test(renderer), 'Settings tabs need keyboard navigation.');
console.log('settings-visualizer-podcasts-overhaul: PASS');
