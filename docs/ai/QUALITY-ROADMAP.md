# Hive Quality Roadmap — getting to Apple-level professionalism

> A living plan we execute against, not a one-off writeup. Grounded in three code audits ("scourges")
> run 2026-11-13: performance, reliability, and security/native. Update the checkboxes as we go.

## The thesis
The gap between Hive and a pro app (Apple Music, MusicBee, Strawberry) is **not talent — it's systematic
discipline applied to the whole surface, instead of fixing what we happen to notice.** Every scourge found
the same shape: the *right* pattern in some places and the *wrong* one three files away. Pro codebases make
the wrong version impossible to reach.

## Where we're inferior (honest, evidence-based)
1. **Inconsistency is the core amateur tell.** Atomic writes were safe in `LoveFiles`/`TagYears`, unsafe
   (silent data loss) in six other stores. Stream teardown was guarded in some Hive Link routes, fd-leaking
   in others. One network call wrapped in `runCatching`, the five beside it not (→ the offline crash).
2. **The monoliths are the existential risk.** `main.js` (~7k) and `renderer.js` (~16k) share scope across
   unrelated concerns, so a change's blast radius is the whole file. The changelog's 8+ volume rewrites are
   the proof. **Splitting these is the single highest-leverage move.**
3. **The quality floor is claimed, not proven.** No systematic testing of offline/flaky network, huge
   libraries (100k+), corrupt files, low memory, process death, concurrency, or long soak sessions. We find
   bugs by *using* the app; Apple finds them before shipping.
4. **Security was bolted on.** Hive Link (exposed over Tailscale) accepts the token over plain HTTP and has
   a pairing race. No threat model.

## Long-term stress verdict (as of 2026-11-13)
| Dimension | Verdict |
|---|---|
| Crash-time data integrity | **Now good** (atomic writes landed); was fragile |
| Huge libraries (100k+) | Partly addressed; unproven past ~30k |
| Memory over multi-day sessions | **Unknown** — no soak testing |
| Concurrency / races | **Fragile** — one real race fixed, more likely lurk |
| Maintainability as features grow | **The time bomb** — the monolith entangles further each feature |

## The disciplines (phased execution plan)

### Phase 1 — Stop the bleeding (DONE this session)
- [x] Perf scourge: delta-persist, payload/stats caches, grid-chunking, disc split.
- [x] Reliability scourge: one atomic-write helper per codebase used everywhere; offline-crash guard at the
      DiscoveryVm seam; cache-store `mutate()` race fix; DB-worker timeout; safe streaming; crash dialog.
- [x] Security scourge: playback-crash clamp; exported-session command lockdown; caught+fixed a win32
      data-loss regression; plugin-hang termination.

### Phase 2 — One enforced way per concern (IN PROGRESS)
- [x] Durable file writes: shared `writeTextAtomic` (mobile `:core`) / `atomicReplace` (desktop).
- [ ] Extract the durable-persistence helpers out of `main.js` into their own module (`atomic-file.js`) —
      first monolith-split increment, unit-tested in isolation. **← starting now**
- [ ] A test/lint that fails if raw `fs.writeFile`/`writeText` is used for a user-data store.
- [ ] Do the same consolidation for: network calls (one client with timeouts + non-cancelling catch),
      stream-to-response (one helper — done in hive-link, generalize), IPC error envelope.

### Phase 3 — Kill the monoliths (#10/#11 — the biggest lever)
- [ ] `main.js` seams: durable-files · library-scan+cache · DB-worker lifecycle · GStreamer bridge ·
      Hive Link wiring · window+tray · IPC-by-domain. Extract one at a time, DI'd, each with its own test.
- [ ] `renderer.js` seams: sidebar/nav · now-playing+queue · album/library views · settings · theme ·
      tag-editor · plugin host. Same incremental, tested approach.
- [ ] Target: no single file over ~2k lines; every module testable without booting Electron.

### Phase 4 — Test the hard stuff (not just the happy path)
- [ ] Migration tests on every schema change (mobile Room auto-migrations are currently untested — a bad
      one wipes playlists/favorites/ratings).
- [ ] Fuzz/property tests on parsers: tags, Hive Link wire format, M3U, weird/unicode/long filenames.
- [ ] Soak test: run for hours, assert memory/handles/timers stay bounded.
- [ ] Chaos tests: kill mid-write, offline, drive-yank, low-memory, rapid input.
- [ ] Synthetic 100k-track library generator + a browse/scan/play pass over it.
- [ ] Concurrency tests for every shared-state read-modify-write.

### Phase 5 — Observability + release discipline
- [ ] Productionize `CrashLog` into a private, on-device (or self-hosted, per the no-data-leaves rule)
      aggregate so bugs surface from telemetry, not from the user stumbling on them. Track a crash-free rate.
- [ ] Release checklist (generalize the Electron-upgrade one): soak → big-library → offline →
      upgrade/downgrade → e2e → ship. Beta channel is already built.
- [ ] Threat-model Hive Link: TLS required when available, least-privilege routes, rate-limited pairing
      bound to the expected device, private-interface restriction. (Needs supervised phone-connection testing.)

### Phase 6 — Design the edge states first
- [ ] Every screen gets empty/loading/error/**offline** states by default, designed not bolted on. The
      "crashes when offline" bug is the anti-pattern; "degrade gracefully" is the reflex.

## Operating principle
Institutionalize the scourge: each release, audit one rotating dimension (perf, reliability, security, a11y,
memory), adversarially verify findings, fix the root cause, and **integrate the fix into a module** — never
bolt another special case onto a monolith. That loop *is* the Apple discipline.
