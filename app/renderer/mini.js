'use strict';
// Hive mini player (MusicBee's Mini Player). Shows state the main window
// publishes and sends button presses back; playback logic stays in the main
// window.
(function () {
  const api = window.beehive;
  const $ = id => document.getElementById(id);
  const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  let state = null;
  let stateAt = 0;
  const fmt = s => { s = Math.max(0, Math.floor(Number(s) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function position() {
    if (!state) return 0;
    const p = Number(state.position) || 0;
    return state.playing ? Math.min(Number(state.duration) || p, p + (performance.now() - stateAt) / 1000) : p;
  }
  function paintTime() {
    if (!state) return;
    const d = Number(state.duration) || 0, p = position();
    $('time').textContent = d ? `${fmt(p)} / ${fmt(d)}` : '';
    $('fill').style.width = d ? `${Math.min(100, (p / d) * 100)}%` : '0';
  }
  function render(next) {
    state = next; stateAt = performance.now();
    if (!state) return;
    $('title').textContent = state.title || 'Nothing playing';
    $('artist').textContent = [state.artist, state.album].filter(Boolean).join(' — ');
    $('play').innerHTML = state.playing ? PAUSE : PLAY;
    $('love').classList.toggle('loved', !!state.loved);
    const cover = $('cover');
    if (state.cover) { cover.style.backgroundImage = `url("${String(state.cover).replace(/"/g, '%22')}")`; cover.textContent = ''; }
    else { cover.style.backgroundImage = ''; cover.textContent = '♪'; }
    if (state.accent) document.documentElement.style.setProperty('--accent', state.accent);
    $('pin').style.color = state.alwaysOnTop ? 'var(--text)' : '';
    paintTime();
  }

  const send = cmd => api.miniPlayerCommand(cmd);
  $('play').onclick = () => send({ action: 'toggle' });
  $('prev').onclick = () => send({ action: 'prev' });
  $('next').onclick = () => send({ action: 'next' });
  $('love').onclick = () => send({ action: 'love' });
  $('open').onclick = () => send({ action: 'show-main' });
  $('close').onclick = () => send({ action: 'close-mini' });
  $('pin').onclick = () => send({ action: 'pin' });
  $('bar').onclick = e => {
    if (!state?.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    send({ action: 'seek', seconds: ((e.clientX - r.left) / r.width) * state.duration });
  };
  api.onMiniPlayerState(render);
  api.getMiniPlayerState().then(render).catch(() => {});
  setInterval(paintTime, 500);
})();
