'use strict';

class TaskManager {
  constructor() {
    this.queues = new Map();
    this.running = new Map();
    this.seq = 0;
  }
  enqueue(kind, fn, options = {}) {
    const priority = Number(options.priority ?? 50);
    const task = { id: String(++this.seq), kind, fn, priority, createdAt: Date.now(), cancelled: false };
    if (!this.queues.has(kind)) this.queues.set(kind, []);
    this.queues.get(kind).push(task);
    this.queues.get(kind).sort((a,b) => b.priority - a.priority || a.createdAt - b.createdAt);
    this.pump(kind);
    return { id: task.id, cancel: () => { task.cancelled = true; } };
  }
  async pump(kind) {
    if (this.running.get(kind)) return;
    const queue = this.queues.get(kind);
    if (!queue?.length) return;
    const task = queue.shift();
    if (task.cancelled) return this.pump(kind);
    this.running.set(kind, task);
    try { await task.fn({ id: task.id, kind, cancelled: () => task.cancelled }); }
    catch (err) { task.error = err; }
    finally { this.running.delete(kind); this.pump(kind); }
  }
  status() {
    const queued = [];
    for (const [kind, q] of this.queues) queued.push({ kind, queued: q.length, running: this.running.get(kind)?.id || null });
    return queued;
  }
}

module.exports = { TaskManager };
