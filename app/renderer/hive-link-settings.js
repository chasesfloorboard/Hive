'use strict';

// Settings › Connections › Hive Mobile: show a pairing code for the phone app
// and list the phones already paired. The tray menu has "Pair phone…" too,
// but GNOME hides tray icons unless an AppIndicator extension is installed.
(() => {
  const api = window.beehive;
  const btn = document.getElementById('hive-link-pair-btn');
  const codeRow = document.getElementById('hive-link-code');
  const codeValue = document.getElementById('hive-link-code-value');
  const codeDetail = document.getElementById('hive-link-code-detail');
  const devicesEl = document.getElementById('hive-link-devices');
  if (!api?.hiveLinkPair || !btn) return;

  let countdown = null;
  let poll = null;

  async function renderDevices() {
    const devices = (await api.hiveLinkDevices().catch(() => [])) || [];
    devicesEl.replaceChildren(...devices.map(device => {
      const row = document.createElement('div');
      row.className = 'settings-row';
      const text = document.createElement('span');
      text.className = 'settings-row-text';
      const label = document.createElement('span');
      label.className = 'settings-row-label';
      label.textContent = device.name || 'Phone';
      const hint = document.createElement('span');
      hint.className = 'settings-hint';
      hint.textContent = `Paired ${new Date(device.pairedAt).toLocaleDateString()} · last seen ${new Date(device.lastSeen).toLocaleString()}`;
      text.append(label, hint);
      const control = document.createElement('span');
      control.className = 'settings-row-control';
      const unpair = document.createElement('button');
      unpair.className = 'sidebar-add';
      unpair.type = 'button';
      unpair.textContent = 'Unpair';
      unpair.addEventListener('click', async () => { await api.hiveLinkUnpair(device.id); renderDevices(); });
      control.append(unpair);
      row.append(text, control);
      return row;
    }));
  }

  btn.addEventListener('click', async () => {
    const pairing = await api.hiveLinkPair().catch(() => null);
    if (!pairing) { codeDetail.textContent = 'Hive Link is not running. Restart Hive and try again.'; codeRow.hidden = false; return; }
    codeValue.textContent = pairing.code;
    codeRow.hidden = false;
    const where = (pairing.addresses || []).map(a => `${a.address}${a.tailscale ? ' (Tailscale)' : ''}`).join(', ');
    clearInterval(countdown);
    const tick = () => {
      const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
      codeDetail.textContent = left > 0
        ? `Works for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. This PC: ${where || 'port ' + pairing.port}`
        : 'Expired. Press Pair phone for a new code.';
      if (left === 0) { clearInterval(countdown); codeValue.textContent = ''; renderDevices(); }
    };
    tick();
    countdown = setInterval(tick, 1000);
    // A phone that pairs shows up in the list within a few seconds.
    let polls = 0;
    clearInterval(poll);
    poll = setInterval(() => { renderDevices(); if (++polls > 60) clearInterval(poll); }, 5000);
  });

  const remote = document.getElementById('hive-link-remote');
  if (remote && api.hiveLinkRemoteControl) {
    api.hiveLinkRemoteControl().then(on => { remote.checked = !!on; }).catch(() => {});
    remote.addEventListener('change', () => { api.hiveLinkRemoteControl(remote.checked).catch(() => {}); });
  }

  // ---- From your phone: what the phone did, waiting to be applied here ----

  const inboxRow = document.getElementById('hive-link-inbox');
  const inboxSummary = document.getElementById('hive-link-inbox-summary');
  const inboxList = document.getElementById('hive-link-inbox-list');
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  function describe(summary) {
    const parts = [];
    if (summary.loves) parts.push(plural(summary.loves, 'Favorites change'));
    if (summary.plays) parts.push(plural(summary.plays, 'play'));
    return parts.length ? `${parts.join(' and ')} waiting. Nothing changes here until you apply them.` : '';
  }

  function showSummary(summary) {
    if (!inboxRow) return;
    const any = summary && (summary.loves || summary.plays);
    inboxRow.hidden = !any;
    if (!any) { inboxList.hidden = true; inboxList.replaceChildren(); return; }
    inboxSummary.textContent = describe(summary);
  }

  function line(main, detail) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const text = document.createElement('span');
    text.className = 'settings-row-text';
    const label = document.createElement('span');
    label.className = 'settings-row-label';
    label.textContent = main;
    const hint = document.createElement('span');
    hint.className = 'settings-hint';
    hint.textContent = detail;
    text.append(label, hint);
    row.append(text);
    return row;
  }

  async function renderInboxList() {
    const box = await api.hiveLinkInbox().catch(() => ({ loves: [], plays: [] }));
    const rows = [];
    for (const l of box.loves.slice(0, 200)) {
      rows.push(line(`${l.loved ? '♥ Add to' : '♡ Remove from'} Favorites: ${l.track.title}`, `${l.track.artist}${l.track.album ? ' · ' + l.track.album : ''} · ${l.device}, ${new Date(l.at).toLocaleString()}`));
    }
    // Plays by song, most played first.
    const bySong = new Map();
    for (const p of box.plays) {
      const g = bySong.get(p.id) || { track: p.track, n: 0, last: 0 };
      g.n++; g.last = Math.max(g.last, p.playedAt);
      bySong.set(p.id, g);
    }
    for (const g of [...bySong.values()].sort((a, b) => b.n - a.n).slice(0, 200)) {
      rows.push(line(`▶ ${g.track.title}: ${plural(g.n, 'play')}`, `${g.track.artist} · last ${new Date(g.last).toLocaleString()}`));
    }
    if (bySong.size > 200 || box.loves.length > 200) rows.push(line('…and more', 'Apply or discard to take care of all of them.'));
    inboxList.replaceChildren(...rows);
  }

  if (inboxRow && api.hiveLinkInbox) {
    document.getElementById('hive-link-inbox-review')?.addEventListener('click', async () => {
      inboxList.hidden = !inboxList.hidden;
      if (!inboxList.hidden) await renderInboxList();
    });
    document.getElementById('hive-link-inbox-apply')?.addEventListener('click', async () => {
      inboxSummary.textContent = 'Applying…';
      const r = await api.hiveLinkApplyInbox({}).catch(err => ({ error: err?.message || String(err) }));
      if (r?.error) { inboxSummary.textContent = `Couldn't apply: ${r.error}`; return; }
      showSummary(r);
      if (inboxRow.hidden) {
        // A last word on what happened, where the row was.
        inboxRow.hidden = false;
        inboxSummary.textContent = `Applied ${plural(r.lovesApplied || 0, 'Favorites change')} and ${plural(r.playsApplied || 0, 'play')}.`;
        setTimeout(() => api.hiveLinkInbox().then(b => showSummary({ loves: b.loves.length, plays: b.plays.length })), 6000);
      }
    });
    document.getElementById('hive-link-inbox-discard')?.addEventListener('click', async () => {
      if (!confirm('Discard everything waiting from your phone? It stays on the phone, but won\'t be sent here again.')) return;
      showSummary(await api.hiveLinkDiscardInbox({}).catch(() => null));
    });
    api.onHiveLinkInbox?.(summary => { showSummary(summary); if (!inboxList.hidden) renderInboxList(); });
    api.hiveLinkInbox().then(b => showSummary({ loves: b.loves.length, plays: b.plays.length })).catch(() => {});
  }

  document.getElementById('settings-tab-connections')?.addEventListener('click', renderDevices);
  renderDevices();
})();
