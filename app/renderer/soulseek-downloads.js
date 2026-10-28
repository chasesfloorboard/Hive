'use strict';

// Soulseek downloads in the window: the account in Settings › Connections,
// window.hiveSoulseek for the Download buttons (renderer.js), and the
// Downloads list: a pill above the player bar while something downloads,
// opening a panel with each album's songs and their progress.
(() => {
  const api = window.beehive;
  if (!api?.soulseekSettings) return;
  const $ = id => document.getElementById(id);
  const user = $('soulseek-username'), pass = $('soulseek-password'), quality = $('soulseek-quality');
  const status = $('soulseek-status'), save = $('soulseek-save'), signOut = $('soulseek-sign-out');
  let signedIn = false, jobs = [], panelOpen = false, seenFinished = new Set();

  const signedOutHint = status?.textContent || '';
  function showAccount(s) {
    signedIn = !!s?.signedIn;
    if (user && document.activeElement !== user) user.value = s?.username || '';
    if (quality) quality.value = s?.quality || 'lossless';
    if (pass) pass.placeholder = signedIn ? 'Saved' : '';
    if (save) save.textContent = signedIn ? 'Save' : 'Sign in';
    if (signOut) signOut.hidden = !signedIn;
    if (status && !status.dataset.busy) status.textContent = signedIn ? `Signed in as ${s.username}. Download on an album or song uses Soulseek.` : signedOutHint;
  }
  api.soulseekSettings().then(showAccount).catch(() => {});

  save?.addEventListener('click', async () => {
    status.dataset.busy = '1';
    status.textContent = 'Signing in…';
    save.disabled = true;
    try {
      // Kept only once Soulseek takes it, so a wrong password never leaves downloads pointing at Soulseek.
      const account = await api.soulseekSignIn({ username: user.value.trim(), password: pass.value });
      pass.value = '';
      delete status.dataset.busy;
      showAccount(account);
    } catch (err) {
      status.textContent = `Couldn't sign in: ${String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
      delete status.dataset.busy;
    } finally { save.disabled = false; }
  });
  signOut?.addEventListener('click', async () => { pass.value = ''; showAccount(await api.soulseekSignOut()); });
  quality?.addEventListener('change', () => { api.soulseekSettings({ quality: quality.value }).then(showAccount).catch(() => {}); });
  pass?.addEventListener('keydown', e => { if (e.key === 'Enter') save?.click(); });
  $('soulseek-downloads-open')?.addEventListener('click', () => { document.querySelector('#settings-modal .modal-close')?.click(); setPanel(true); });

  // ---- the Downloads list ----
  const finished = j => ['done', 'partial', 'failed'].includes(j.state);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const progress = j => j.songs.length ? (j.songs.filter(s => s.state === 'done').length + j.songs.filter(s => s.state === 'downloading').reduce((n, s) => n + s.percent / 100, 0)) / j.songs.length : 0;

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'soulseek-pill hidden';
  pill.setAttribute('aria-haspopup', 'dialog');
  pill.innerHTML = '<span class="soulseek-pill-ring" aria-hidden="true"></span><span class="soulseek-pill-text"></span>';
  const panel = document.createElement('section');
  panel.className = 'soulseek-panel hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Downloads');
  document.body.append(pill, panel);
  pill.addEventListener('click', () => setPanel(!panelOpen));

  function setPanel(open) {
    panelOpen = open;
    if (open) for (const j of jobs) if (finished(j)) seenFinished.add(j.id + j.at);
    render();
    if (open) panel.querySelector('button')?.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', e => { if (panelOpen && e.key === 'Escape') { setPanel(false); pill.focus(); } });
  document.addEventListener('pointerdown', e => { if (panelOpen && !panel.contains(e.target) && !pill.contains(e.target)) setPanel(false); });

  function render() {
    const active = jobs.filter(j => !finished(j));
    const unseen = jobs.filter(j => finished(j) && !seenFinished.has(j.id + j.at));
    const head = active.find(j => j.state === 'downloading' || j.state === 'searching') || active[0];
    const showPill = !!head || unseen.length > 0 || panelOpen;
    pill.classList.toggle('hidden', !showPill);
    if (head) {
      const done = head.songs.filter(s => s.state === 'done').length;
      pill.querySelector('.soulseek-pill-text').textContent = head.state === 'searching' ? `Looking for ${head.label}` : head.state === 'queued' ? `Waiting: ${head.label}` : `${head.label} · ${done} of ${head.songs.length}${active.length > 1 ? ` · ${active.length - 1} more` : ''}`;
      pill.style.setProperty('--p', String(Math.round(progress(head) * 100)));
      pill.classList.toggle('searching', head.state !== 'downloading');
    } else if (unseen.length) {
      pill.querySelector('.soulseek-pill-text').textContent = unseen[0].message + (unseen.length > 1 ? ` · ${unseen.length - 1} more` : '');
      pill.style.setProperty('--p', unseen[0].state === 'failed' ? '0' : '100');
      pill.classList.remove('searching');
    } else pill.querySelector('.soulseek-pill-text').textContent = 'Downloads';
    pill.classList.toggle('failed', !head && unseen[0]?.state === 'failed');
    pill.setAttribute('aria-expanded', String(panelOpen));
    // Above the player bar, however tall it is (or near the bottom when the player sits on top).
    const bar = document.getElementById('playbar')?.getBoundingClientRect();
    const above = bar && bar.height && bar.bottom > window.innerHeight - 8 ? window.innerHeight - bar.top + 14 : 24;
    pill.style.bottom = `${above}px`;
    panel.style.bottom = `${above + 42}px`;
    panel.classList.toggle('hidden', !panelOpen);
    if (!panelOpen) return;
    // Progress redraws the list: what was open stays open, and focus stays on its button.
    const focused = panel.contains(document.activeElement) ? { id: document.activeElement.closest('[data-id]')?.dataset.id, sk: document.activeElement.dataset?.sk } : null;
    panel.innerHTML = `<header class="soulseek-panel-head"><h3>Downloads</h3>${jobs.some(finished) ? '<button type="button" class="sidebar-add" data-sk="clear">Clear finished</button>' : ''}</header>
      <div class="soulseek-panel-list">${jobs.length ? jobs.map(j => {
        const p = Math.round(progress(j) * 100);
        const done = j.songs.filter(s => s.state === 'done').length;
        return `<details class="soulseek-job soulseek-${esc(j.state)}" data-id="${esc(j.id)}"${(openState.has(j.id) ? openState.get(j.id) : j === jobs.find(x => !finished(x))) ? ' open' : ''}>
          <summary><span class="soulseek-job-text"><span class="soulseek-job-title">${esc(j.label)}</span><span class="soulseek-job-meta">${esc(j.artist)}${j.artist ? ' · ' : ''}${esc(j.state === 'done' ? (j.songs.length === 1 ? 'Downloaded' : `All ${j.songs.length} songs downloaded`) : j.state === 'partial' ? `${done} of ${j.songs.length} songs downloaded` : finished(j) ? j.message : `${done} of ${j.songs.length} · ${j.message}`)}</span></span>
            ${finished(j) ? '' : `<button type="button" class="soulseek-job-cancel" data-sk="cancel" title="Stop" aria-label="Stop downloading ${esc(j.label)}">✕</button>`}</summary>
          <div class="soulseek-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><span style="width:${p}%"></span></div>
          <ol class="soulseek-songs">${j.songs.map(s => `<li class="soulseek-song soulseek-song-${esc(s.state)}"><span class="soulseek-song-title">${esc(s.title)}</span><span class="soulseek-song-state">${s.state === 'downloading' ? `${s.percent}%` : s.state === 'done' ? '✓' : s.state === 'missing' ? 'Not found' : ''}</span></li>`).join('')}</ol>
        </details>`;
      }).join('') : '<p class="soulseek-empty">Nothing downloading. Use Download on an Apple Music or Spotify album or song.</p>'}</div>`;
    if (focused?.sk) (focused.id ? panel.querySelector(`[data-id="${CSS.escape(focused.id)}"] [data-sk="${focused.sk}"]`) : panel.querySelector(`[data-sk="${focused.sk}"]`))?.focus({ preventScroll: true });
  }
  const openState = new Map();
  panel.addEventListener('toggle', e => { const d = e.target; if (d?.dataset?.id) openState.set(d.dataset.id, d.open); }, true);
  window.addEventListener('resize', () => { if (!pill.classList.contains('hidden')) render(); });
  panel.addEventListener('click', async e => {
    const b = e.target.closest('[data-sk]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.sk === 'clear') await api.soulseekClearFinished();
    if (b.dataset.sk === 'cancel') await api.soulseekCancel(b.closest('[data-id]')?.dataset.id);
  });

  api.onSoulseekJobs(list => { jobs = Array.isArray(list) ? list : []; render(); });
  api.soulseekJobs().then(list => { jobs = list || []; for (const j of jobs) if (finished(j)) seenFinished.add(j.id + j.at); render(); }).catch(() => {});

  // ---- for the Download buttons ----
  const albumKey = t => `${String(t.albumArtist || t.artist || '').split(/,|&| feat\.? /i)[0].trim().toLowerCase()}\u0000${String(t.album || '').toLowerCase()}`;
  const ms = d => { const n = Number(d) || 0; return n > 0 && n < 36000 ? Math.round(n * 1000) : Math.round(n); };
  window.hiveSoulseek = {
    ready: () => signedIn,
    open: () => setPanel(true),
    // Songs grouped by album: an album's songs come from one folder; a song on its own is looked for as a song.
    async download(tracks) {
      const groups = new Map();
      for (const t of tracks || []) { if (!t?.title) continue; const k = albumKey(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      for (const list of groups.values()) {
        const first = list[0];
        const artist = String(first.albumArtist || first.artist || '').split(/,|&| feat\.? /i)[0].trim();
        for (const part of first.album ? [list] : list.map(t => [t])) {
          const one = part.length === 1;
          await api.soulseekDownload({
            kind: one ? 'track' : 'album', artist, album: first.album || '', label: one ? part[0].title : first.album,
            tracks: part.map(t => ({ title: t.title, durationMs: ms(t.duration), loved: !!t.loved, streamPath: t.path || '' })),
          });
        }
      }
      setPanel(true);
    },
  };
})();
