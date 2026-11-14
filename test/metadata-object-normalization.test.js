const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const rendererPath = path.join(__dirname, '..', 'app', 'renderer', 'renderer.js');
const scannerPath = path.join(__dirname, '..', 'app', 'workers', 'scanner-worker.js');
const renderer = fs.readFileSync(rendererPath, 'utf8');
const scanner = fs.readFileSync(scannerPath, 'utf8');

test('renderer has one object-safe text normalizer for comments and lyrics', () => {
  assert.match(renderer, /function normalizeMetadataText\(raw\)/);
  assert.match(renderer, /normalizeMetadataText\(t\?\.comment\)/);
  assert.match(renderer, /t\.comment\s*=\s*normalizeMetadataText\(t\.comment\)/);
  assert.doesNotMatch(renderer, /get:t=>String\(t\?\.comment \|\| ''\)/);
  // The smart-playlist field getters that normalise comment/lyrics moved to smart-rules.js, which is handed
  // normalizeMetadataText as an injected dependency (docs/ai/ARCHITECTURE.md).
  const smartRules = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'smart-rules.js'), 'utf8');
  assert.match(smartRules, /comment: t => normalizeMetadataText\(t\.comment\)/);
  assert.match(smartRules, /lyrics: t => normalizeMetadataText\(t\.lyrics\)/);
});

test('scanner normalizes object-shaped comments and lyrics before building track records', () => {
  assert.match(scanner, /function normalizeMetadataText\(raw\)/);
  assert.match(scanner, /comment:normalizeMetadataText\(common\.comment\)/);
  assert.match(scanner, /lyrics\s*=\s*normalizeMetadataText\(common\.lyrics\)/);
});

test('metadata normalizer rejects the literal object-coercion sentinel', () => {
  assert.ok(renderer.includes("return text.trim() === '[object Object]' ? '' : text;"));
  assert.ok(scanner.includes("return text.trim() === '[object Object]' ? '' : text;"));
});
