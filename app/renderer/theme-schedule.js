'use strict';
// Scheduled theme (Settings → Appearance): which of two themes should show at
// a given time of day. Pure time logic only; renderer.js applies the theme.
// Loaded as a plain script (window.HiveThemeSchedule) and by the tests via
// require().
(function (root) {
  // "HH:MM" -> minutes since midnight, or null if it isn't a valid time.
  function minutesOf(hhmm) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  // 'day' or 'night' at `minutes` since midnight. Day runs from dayStart up
  // to nightStart and wraps past midnight when dayStart is the later time.
  function periodAt(minutes, dayStart, nightStart) {
    if (dayStart === nightStart) return 'day';
    if (dayStart < nightStart) return minutes >= dayStart && minutes < nightStart ? 'day' : 'night';
    return minutes >= dayStart || minutes < nightStart ? 'day' : 'night';
  }

  // Milliseconds from `date` until the next day/night switch.
  function msUntilNextSwitch(date, dayStart, nightStart) {
    const now = date.getHours() * 60 + date.getMinutes();
    const intoMinute = date.getSeconds() * 1000 + date.getMilliseconds();
    const waits = [dayStart, nightStart].map(t => ((t - now + 1440) % 1440) || 1440);
    return Math.min(...waits) * 60000 - intoMinute;
  }

  const DEFAULTS = Object.freeze({ enabled: false, dayStart: '06:00', nightStart: '17:30', dayTheme: '', nightTheme: '' });

  const api = { minutesOf, periodAt, msUntilNextSwitch, DEFAULTS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HiveThemeSchedule = api;
})(typeof window !== 'undefined' ? window : globalThis);
