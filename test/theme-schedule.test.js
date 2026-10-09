'use strict';
// Scheduled theme (Settings → Appearance): the pure time logic in
// app/renderer/theme-schedule.js that decides which theme should be showing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { minutesOf, periodAt, msUntilNextSwitch, DEFAULTS } = require('../app/renderer/theme-schedule');

const at = (h, m) => h * 60 + m;

test('defaults are Light from 6:00 AM and Dark from 5:30 PM', () => {
  assert.equal(DEFAULTS.dayStart, '06:00');
  assert.equal(DEFAULTS.nightStart, '17:30');
  assert.equal(DEFAULTS.enabled, false);
});

test('times parse, and invalid ones are rejected', () => {
  assert.equal(minutesOf('06:00'), 360);
  assert.equal(minutesOf('17:30'), 1050);
  assert.equal(minutesOf('7:05'), 425);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf('12:60'), null);
  assert.equal(minutesOf(''), null);
});

test('day 6:00 AM to 5:30 PM, night 5:30 PM to 6:00 AM, including across midnight', () => {
  const day = at(6, 0), night = at(17, 30);
  assert.equal(periodAt(at(5, 59), day, night), 'night');
  assert.equal(periodAt(at(6, 0), day, night), 'day');
  assert.equal(periodAt(at(12, 0), day, night), 'day');
  assert.equal(periodAt(at(17, 29), day, night), 'day');
  assert.equal(periodAt(at(17, 30), day, night), 'night');
  assert.equal(periodAt(at(23, 59), day, night), 'night');
  assert.equal(periodAt(at(0, 0), day, night), 'night');
});

test('a day period that wraps past midnight (e.g. a night-shift schedule) works too', () => {
  const day = at(20, 0), night = at(4, 0);
  assert.equal(periodAt(at(22, 0), day, night), 'day');
  assert.equal(periodAt(at(2, 0), day, night), 'day');
  assert.equal(periodAt(at(12, 0), day, night), 'night');
});

test('the next switch is timed to the minute it happens', () => {
  const day = at(6, 0), night = at(17, 30);
  assert.equal(msUntilNextSwitch(new Date(2026, 9, 8, 17, 0, 0, 0), day, night), 30 * 60000);
  assert.equal(msUntilNextSwitch(new Date(2026, 9, 8, 17, 29, 30, 0), day, night), 30000);
  assert.equal(msUntilNextSwitch(new Date(2026, 9, 8, 23, 0, 0, 0), day, night), 7 * 60 * 60000);
});
