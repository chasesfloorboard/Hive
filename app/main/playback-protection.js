'use strict';

const path = require('path');

class PlaybackProtection {
  constructor() {
    this.protectedPath = '';
    this.waiters = new Map();
  }

  normalize(trackPath) {
    return trackPath ? path.resolve(String(trackPath)) : '';
  }

  protect(trackPath) {
    const nextPath = this.normalize(trackPath);
    if (this.protectedPath && this.protectedPath !== nextPath) this.release();
    this.protectedPath = nextPath;
  }

  release(trackPath = '') {
    const normalized = this.normalize(trackPath);
    if (!this.protectedPath) return;
    if (normalized && normalized !== this.protectedPath) return;
    this.protectedPath = '';
    const waiters = [...this.waiters.values()].flat();
    this.waiters.clear();
    waiters.forEach(resolve => resolve());
  }

  isProtected(trackPath) {
    const normalized = this.normalize(trackPath);
    return !!this.protectedPath && normalized === this.protectedPath;
  }

  waitForRelease(trackPath) {
    const normalized = this.normalize(trackPath);
    if (!normalized || !this.isProtected(normalized)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.waiters.get(normalized) || [];
      waiters.push(resolve);
      this.waiters.set(normalized, waiters);
    });
  }
}

module.exports = { PlaybackProtection };
