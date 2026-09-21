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
  assert.match(renderer, /normalizeMetadataText\(t\.lyrics\)/);
  assert.match(renderer, /t\.comment\s*=\s*normalizeMetadataText\(t\.comment\)/);
  assert.match(renderer, /comment:normalizeMetadataText\(t\.comment\)/);
  assert.doesNotMatch(renderer, /get:t=>String\(t\?\.comment \|\| ''\)/);
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
