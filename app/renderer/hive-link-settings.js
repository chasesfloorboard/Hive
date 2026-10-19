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

  document.getElementById('settings-tab-connections')?.addEventListener('click', renderDevices);
  renderDevices();
})();
