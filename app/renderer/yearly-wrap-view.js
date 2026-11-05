'use strict';

// Yearly Wrap inside the main window, built like Hive Mobile's: slides you
// move through (arrows, keys, wheel, dots), each lit by its cover, numbers
// that count up, the top albums fanned out like records, a year by month you
// can open, and a closing poster that saves or copies as a picture.
// The renderer mounts it with callbacks so everything opens in Hive itself.
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function hoursOf(seconds) { return Math.max(0, Number(seconds) || 0) / 3600; }
  function dayLine(seconds) {
    const days = Math.floor((Number(seconds) || 0) / 86400);
    if (days < 1) return '';
    const hours = Math.floor(((Number(seconds) || 0) % 86400) / 3600);
    return `That's ${days} ${days === 1 ? 'day' : 'days'}${hours ? `, ${hours} ${hours === 1 ? 'hour' : 'hours'}` : ''} of music.`;
  }
  function everyDays(year, plays) {
    if (!(plays > 1)) return '';
    const now = new Date();
    const end = now.getFullYear() === year ? now : new Date(year, 11, 31);
    const days = Math.max(1, Math.round((end - new Date(year, 0, 1)) / 86400000));
    const gap = Math.max(1, Math.round(days / plays));
    return gap <= 1 ? 'about every day' : `about every ${gap} days`;
  }
  function splitKey(key) { const [title = '', artist = ''] = String(key || '').split('\u0000'); return { title, artist }; }

  // Per-month detail from the play rows.
  function monthDetail(rows, year, month) {
    const inMonth = (rows || []).filter(r => { const d = new Date(Number(r.playedAt)); return d.getFullYear() === year && d.getMonth() === month; });
    const tally = (keyOf, metaOf) => {
      const m = new Map();
      for (const r of inMonth) { const k = keyOf(r); if (!k) continue; const e = m.get(k) || { ...metaOf(r), plays: 0, seconds: 0 }; e.plays++; e.seconds += Number(r.duration) || 0; m.set(k, e); }
      return [...m.values()].sort((a, b) => b.plays - a.plays || b.seconds - a.seconds).slice(0, 5);
    };
    return {
      plays: inMonth.length,
      seconds: inMonth.reduce((n, r) => n + (Number(r.duration) || 0), 0),
      tracks: tally(r => `${r.title}\u0000${r.artist}`, r => ({ title: r.title, artist: r.artist, album: r.album, cover: r.cover })),
      artists: tally(r => r.artist, r => ({ name: r.artist, cover: r.cover })),
      albums: tally(r => `${r.album}\u0000${r.artist}`, r => ({ album: r.album, artist: r.artist, cover: r.cover })),
    };
  }

  function mount(host, opts) {
    const { api, coverUrl, onPlayTrack, onOpenAlbum, onOpenArtist } = opts;
    let data = null, years = [], index = 0, slides = [], wheelLock = 0, alive = true;
    host.innerHTML = '';
    const root = document.createElement('section');
    root.className = 'wrapv';
    root.setAttribute('aria-label', 'Yearly Wrap');
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="wrapv-backdrop" aria-hidden="true"><div class="wrapv-bg a"></div><div class="wrapv-bg b"></div><div class="wrapv-veil"></div></div>
      <header class="wrapv-bar">
        <h1 class="wrapv-brand">Yearly Wrap</h1>
        <select class="wrapv-year" aria-label="Year"></select>
        <span class="wrapv-status" aria-live="polite"></span>
        <button type="button" class="wrapv-btn" data-act="copy">Copy image</button>
        <button type="button" class="wrapv-btn" data-act="save">Save image</button>
      </header>
      <nav class="wrapv-dots" aria-label="Slides"></nav>
      <div class="wrapv-track"></div>
      <button type="button" class="wrapv-nav prev" data-act="prev" aria-label="Previous slide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg></button>
      <button type="button" class="wrapv-nav next" data-act="next" aria-label="Next slide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button>
      <div class="wrapv-month hidden" role="dialog" aria-modal="false"></div>`;
    host.appendChild(root);
    const $ = s => root.querySelector(s);
    const track = $('.wrapv-track'), dots = $('.wrapv-dots'), yearSel = $('.wrapv-year'), status = $('.wrapv-status');
    const bgA = $('.wrapv-bg.a'), bgB = $('.wrapv-bg.b');
    let bgFront = bgA;
    const setStatus = t => { status.textContent = t || ''; if (t) setTimeout(() => { if (status.textContent === t) status.textContent = ''; }, 3200); };
    const img = (file, cls = '', alt = '') => file ? `<img class="${cls}" src="${esc(coverUrl(file))}" alt="${esc(alt)}" draggable="false">` : `<div class="${cls} wrapv-noart">♪</div>`;

    function build() {
      const d = data;
      const total = Number(d.totalSeconds) || 0;
      const top = d.topTrack ? { ...splitKey(d.topTrack.key), plays: d.topTrack.plays, album: d.topTrack.album, cover: d.topTrack.cover } : null;
      const artist = d.topArtists?.[0] || null;
      const albums = (d.topAlbums || []).slice(0, 5);
      const genre = d.topGenres?.[0] || null;
      const monthly = new Array(12).fill(0);
      for (const m of d.monthly || []) { const [y, mm] = String(m.month).split('-').map(Number); if (y === d.year && mm >= 1 && mm <= 12) monthly[mm - 1] += Number(m.seconds) || 0; }
      const maxMonth = Math.max(1, ...monthly);
      const bestMonth = monthly.indexOf(Math.max(...monthly));
      const estimated = d.estimated ? '<p class="wrapv-note">Some of this year is estimated from listening history saved before Hive kept a full record.</p>' : '';
      const s = [];
      if (!d.totalPlays) {
        s.push({ art: null, html: `<div class="wrapv-col"><div class="wrapv-eyebrow">Yearly Wrap</div><div class="wrapv-giant">${d.year}</div><h2 class="wrapv-title">Your Wrap fills in as you listen.</h2><p class="wrapv-sub">Play some music and come back: every song you finish counts.</p></div>` });
        return s;
      }
      s.push({ art: albums[0]?.cover || top?.cover, html: `<div class="wrapv-two">${albums.length ? `<div class="wrapv-fan" style="--n:${Math.min(3, albums.length)}">${albums.slice(0, 3).map((a, i) => `<button type="button" class="wrapv-fan-card" style="--k:${i}" data-act="album" data-album="${esc(a.album)}" data-artist="${esc(a.artist)}" aria-label="${esc(a.album)}">${img(a.cover, '', a.album)}</button>`).join('')}</div>` : ''}<div class="wrapv-col"><div class="wrapv-eyebrow rise" style="--i:0">Yearly Wrap</div><div class="wrapv-giant rise" style="--i:1">${d.year}</div><h2 class="wrapv-title rise" style="--i:2">Your year in music.</h2><p class="wrapv-sub rise" style="--i:3">Everything you played in Hive this year, kept on this computer.</p>${estimated}<button type="button" class="wrapv-cta rise" style="--i:4" data-act="next">Start</button></div></div>` });
      const h = hoursOf(total);
      s.push({ art: top?.cover, count: h >= 2 ? Math.round(h) : Math.round(total / 60), html: `<div class="wrapv-col"><div class="wrapv-eyebrow rise" style="--i:0">Listening time</div><div class="wrapv-giant rise" style="--i:1" data-count>0</div><h2 class="wrapv-title rise" style="--i:2">${h >= 2 ? 'hours with music.' : 'minutes with music.'}</h2><p class="wrapv-sub rise" style="--i:3">${esc(dayLine(total))}</p>
        <div class="wrapv-stats rise" style="--i:4"><div><strong>${Number(d.totalPlays || 0).toLocaleString()}</strong><span>plays</span></div><div><strong>${Number(d.uniqueArtists || 0).toLocaleString()}</strong><span>artists</span></div><div><strong>${Number(d.uniqueAlbums || 0).toLocaleString()}</strong><span>albums</span></div><div><strong>${Number(d.longestStreak || 0).toLocaleString()}</strong><span>days in a row, at most</span></div></div></div>` });
      if (top) s.push({ art: top.cover, html: `<div class="wrapv-two"><div class="wrapv-cover land" data-act="play-top" title="Play ${esc(top.title)}">${img(top.cover, 'wrapv-cover-img', top.album)}<span class="wrapv-cover-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div><div class="wrapv-col"><div class="wrapv-eyebrow rise" style="--i:0">Your top track</div><h2 class="wrapv-title big rise" style="--i:1">${esc(top.title)}</h2><p class="wrapv-sub rise" style="--i:2">${esc(top.artist)}${top.album ? ` · ${esc(top.album)}` : ''}</p><p class="wrapv-sub small rise" style="--i:3">Played ${Number(top.plays || 0).toLocaleString()} ${top.plays === 1 ? 'time' : 'times'}${everyDays(d.year, top.plays) ? `, ${everyDays(d.year, top.plays)}` : ''}.</p><button type="button" class="wrapv-cta rise" style="--i:4" data-act="play-top">Play it</button></div></div>` });
      if (artist) s.push({ art: artist.cover, html: `<div class="wrapv-two reverse"><div class="wrapv-col"><div class="wrapv-eyebrow rise" style="--i:0">The artist of your year</div><h2 class="wrapv-title big rise" style="--i:1">${esc(artist.name)}</h2><p class="wrapv-sub rise" style="--i:2">${Number(artist.plays || 0).toLocaleString()} plays${d.topArtists?.[1] ? `, then ${esc(d.topArtists[1].name)}${d.topArtists?.[2] ? ` and ${esc(d.topArtists[2].name)}` : ''}` : ''}.</p><button type="button" class="wrapv-cta rise" style="--i:3" data-act="artist" data-name="${esc(artist.name)}">Show ${esc(artist.name)}</button></div><div class="wrapv-artist land" data-act="artist" data-name="${esc(artist.name)}">${img(artist.cover, 'wrapv-artist-img', artist.name)}</div></div>` });
      if (albums.length) s.push({ art: albums[0].cover, html: `<div class="wrapv-two"><div class="wrapv-fan" style="--n:${albums.length}">${albums.map((a, i) => `<button type="button" class="wrapv-fan-card" style="--k:${i}" data-act="album" data-album="${esc(a.album)}" data-artist="${esc(a.artist)}" aria-label="${esc(a.album)}">${img(a.cover, '', a.album)}</button>`).join('')}</div><div class="wrapv-col"><div class="wrapv-eyebrow rise" style="--i:0">The records you returned to</div><h2 class="wrapv-title rise" style="--i:1">Your top albums.</h2><ol class="wrapv-rank rise" style="--i:2">${albums.map(a => `<li><button type="button" data-act="album" data-album="${esc(a.album)}" data-artist="${esc(a.artist)}"><strong>${esc(a.album)}</strong><span>${esc(a.artist)} · ${Number(a.plays || 0).toLocaleString()} plays</span></button></li>`).join('')}</ol></div></div>` });
      s.push({ art: albums[1]?.cover || albums[0]?.cover, html: `<div class="wrapv-col wide"><div class="wrapv-eyebrow rise" style="--i:0">When you listened</div><h2 class="wrapv-title rise" style="--i:1">${monthly[bestMonth] > 0 ? `${MONTHS[bestMonth]} was your month.` : 'Your year, by month.'}</h2>
        <div class="wrapv-months rise" style="--i:2">${monthly.map((sec, i) => `<button type="button" class="wrapv-month-bar${i === bestMonth && sec > 0 ? ' best' : ''}" data-act="month" data-month="${i}" ${sec > 0 ? '' : 'disabled'} title="${MONTHS[i]}: ${Math.round(sec / 3600)} hours"><span class="fill" style="--h:${Math.max(sec > 0 ? 4 : 0, Math.round(sec / maxMonth * 100))}%"></span><small>${MONTHS[i].slice(0, 3)}</small></button>`).join('')}</div>
        <p class="wrapv-sub small rise" style="--i:3">Click a month to look inside it.${d.topDay ? ` Your biggest day was ${esc(new Date(d.topDay.date + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric' }))}.` : ''}</p></div>` });
      const tile = (label, name, cover, act = '', extra = '') => `<button type="button" class="wrapv-tile" ${act ? `data-act="${act}" ${extra}` : 'disabled'}>${img(cover, 'wrapv-tile-img', name)}<span>${esc(label)}</span><strong>${esc(name || '—')}</strong></button>`;
      s.push({ art: albums[0]?.cover || top?.cover, poster: true, html: `<div class="wrapv-col wide center"><div class="wrapv-eyebrow rise" style="--i:0">That's your year</div><h2 class="wrapv-title rise" style="--i:1">The music stays with you.</h2>
        <div class="wrapv-poster rise" style="--i:2">${tile('Top track', top?.title, top?.cover, 'play-top')}${tile('Top artist', artist?.name, artist?.cover, artist ? 'artist' : '', artist ? `data-name="${esc(artist.name)}"` : '')}${tile('Top album', albums[0]?.album, albums[0]?.cover, albums[0] ? 'album' : '', albums[0] ? `data-album="${esc(albums[0].album)}" data-artist="${esc(albums[0].artist)}"` : '')}${tile('Top genre', genre?.name, genre?.cover, genre?.album ? 'album' : '', genre?.album ? `data-album="${esc(genre.album)}" data-artist="${esc(genre.artist || '')}"` : '')}</div>
        <p class="wrapv-sub small rise" style="--i:3">${Math.round(hoursOf(total)).toLocaleString()} hours, ${Number(d.totalPlays || 0).toLocaleString()} plays. Counted by Hive on this computer; no account needed.</p></div>` });
      return s;
    }

    function render() {
      slides = build();
      index = Math.min(index, slides.length - 1);
      track.innerHTML = slides.map((s, i) => `<div class="wrapv-slide${s.poster ? ' poster' : ''}" data-i="${i}" aria-hidden="true">${s.html}</div>`).join('');
      dots.innerHTML = slides.map((_, i) => `<button type="button" data-dot="${i}" aria-label="Slide ${i + 1} of ${slides.length}"></button>`).join('');
      go(index, true);
    }

    function setBackdrop(file) {
      const url = file ? `url("${String(coverUrl(file)).replace(/["\\\n]/g, encodeURIComponent)}")` : 'none';
      const back = bgFront === bgA ? bgB : bgA;
      if (bgFront.style.backgroundImage === url) return;
      back.style.backgroundImage = url;
      back.classList.add('on'); bgFront.classList.remove('on');
      bgFront = back;
    }

    function countUp(el, to) {
      if (!el) return;
      if (reduced()) { el.textContent = to.toLocaleString(); return; }
      const start = performance.now(), dur = 1300;
      const step = now => {
        if (!alive) return;
        const t = Math.min(1, (now - start) / dur);
        el.textContent = Math.round(to * (1 - Math.pow(1 - t, 3))).toLocaleString();
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    function go(i, instant = false) {
      if (!slides.length) return;
      index = Math.max(0, Math.min(slides.length - 1, i));
      track.style.transition = instant || reduced() ? 'none' : '';
      track.style.transform = `translateX(${-index * 100}%)`;
      track.querySelectorAll('.wrapv-slide').forEach((el, k) => { const on = k === index; el.classList.toggle('in', on); el.setAttribute('aria-hidden', String(!on)); el.inert = !on; });
      dots.querySelectorAll('button').forEach((b, k) => { b.classList.toggle('on', k === index); b.classList.toggle('past', k < index); });
      $('.wrapv-nav.prev').disabled = index === 0;
      $('.wrapv-nav.next').disabled = index === slides.length - 1;
      setBackdrop(slides[index].art);
      if (slides[index].count != null) countUp(track.querySelectorAll('.wrapv-slide')[index].querySelector('[data-count]'), slides[index].count);
      closeMonth();
    }

    function openMonth(m) {
      const det = data.months?.[m] || monthDetail(data.rows, data.year, m);
      const panel = $('.wrapv-month');
      const list = (title, items, row) => items.length ? `<section><h4>${title}</h4><ol>${items.map(row).join('')}</ol></section>` : '';
      panel.innerHTML = `<header><div><div class="wrapv-eyebrow">${data.year}</div><h3>${MONTHS[m]}</h3><p>${Math.round(det.seconds / 3600).toLocaleString()} hours, ${det.plays.toLocaleString()} plays</p></div><button type="button" class="wrapv-btn" data-act="close-month" aria-label="Close ${MONTHS[m]}">Close</button></header>
        <div class="wrapv-month-cols">${list('Tracks', det.tracks, t => `<li><button type="button" data-act="play-row" data-title="${esc(t.title)}" data-artist="${esc(t.artist)}">${img(t.cover, 'wrapv-mini', t.album)}<span><strong>${esc(t.title)}</strong><small>${esc(t.artist)} · ${t.plays} plays</small></span></button></li>`)}
        ${list('Artists', det.artists, a => `<li><button type="button" data-act="artist" data-name="${esc(a.name)}">${img(a.cover, 'wrapv-mini round', a.name)}<span><strong>${esc(a.name)}</strong><small>${a.plays} plays</small></span></button></li>`)}
        ${list('Albums', det.albums, a => `<li><button type="button" data-act="album" data-album="${esc(a.album)}" data-artist="${esc(a.artist)}">${img(a.cover, 'wrapv-mini', a.album)}<span><strong>${esc(a.album)}</strong><small>${esc(a.artist)} · ${a.plays} plays</small></span></button></li>`)}</div>`;
      panel.classList.remove('hidden');
      panel.querySelector('[data-act="close-month"]')?.focus({ preventScroll: true });
    }
    function closeMonth() { $('.wrapv-month')?.classList.add('hidden'); }

    // A picture of the current slide for sharing: the cover, the slide's words, Hive's mark.
    async function slideImage() {
      const s = slides[index];
      const W = 1080, H = 1350, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d');
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e0913c';
      g.fillStyle = '#0b0b0f'; g.fillRect(0, 0, W, H);
      const loadImg = src => new Promise(res => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
      const art = await loadImg(s.art ? coverUrl(s.art) : '');
      if (art) { g.save(); g.filter = 'blur(70px) saturate(1.4)'; g.globalAlpha = .55; g.drawImage(art, -200, -200, W + 400, H + 400); g.restore(); }
      const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, 'rgba(0,0,0,.15)'); grad.addColorStop(1, 'rgba(0,0,0,.7)'); g.fillStyle = grad; g.fillRect(0, 0, W, H);
      if (art) { g.save(); g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 60; g.shadowOffsetY = 20; const size = 620; const x = (W - size) / 2, y = 150; g.beginPath(); g.roundRect(x, y, size, size, 28); g.clip(); g.drawImage(art, x, y, size, size); g.restore(); }
      const slideEl = track.querySelectorAll('.wrapv-slide')[index];
      const eyebrow = slideEl.querySelector('.wrapv-eyebrow')?.textContent || 'Yearly Wrap';
      const giant = slideEl.querySelector('.wrapv-giant')?.textContent || '';
      const title = slideEl.querySelector('.wrapv-title')?.textContent || '';
      const sub = slideEl.querySelector('.wrapv-sub')?.textContent || '';
      g.textAlign = 'center';
      let y = art ? 870 : 420;
      g.fillStyle = accent; g.font = '600 38px Inter, system-ui, sans-serif'; g.fillText(eyebrow, W / 2, y); y += 70;
      if (giant) { g.fillStyle = '#fff'; g.font = '900 140px Inter, system-ui, sans-serif'; g.fillText(giant, W / 2, y + 90); y += 160; }
      g.fillStyle = '#fff'; g.font = '800 64px Inter, system-ui, sans-serif';
      const wrap = (text, max, lh, font) => { g.font = font; const words = String(text).split(/\s+/); let line = ''; for (const w of words) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > max && line) { g.fillText(line, W / 2, y); y += lh; line = w; } else line = t; } if (line) { g.fillText(line, W / 2, y); y += lh; } };
      wrap(title, 900, 74, '800 64px Inter, system-ui, sans-serif');
      g.fillStyle = 'rgba(255,255,255,.75)'; wrap(sub, 900, 46, '400 36px Inter, system-ui, sans-serif');
      g.fillStyle = 'rgba(255,255,255,.6)'; g.font = '600 30px Inter, system-ui, sans-serif'; g.fillText(`Hive · Yearly Wrap ${data.year}`, W / 2, H - 70);
      return c.toDataURL('image/png');
    }

    root.addEventListener('click', async e => {
      const t = e.target.closest('[data-act],[data-dot]');
      if (!t || !root.contains(t)) return;
      if (t.dataset.dot != null) return go(Number(t.dataset.dot));
      const act = t.dataset.act;
      if (act === 'next') return go(index + 1);
      if (act === 'prev') return go(index - 1);
      if (act === 'month') return openMonth(Number(t.dataset.month));
      if (act === 'close-month') return closeMonth();
      if (act === 'play-top' && data?.topTrack) { const k = splitKey(data.topTrack.key); return onPlayTrack?.(k.title, k.artist); }
      if (act === 'play-row') return onPlayTrack?.(t.dataset.title, t.dataset.artist);
      if (act === 'artist') return onOpenArtist?.(t.dataset.name);
      if (act === 'album') return onOpenAlbum?.(t.dataset.album, t.dataset.artist);
      if (act === 'save' || act === 'copy') {
        try {
          const url = await slideImage();
          if (act === 'copy') { await api.copyYearlyWrapImage(url); setStatus('Copied. Paste it anywhere.'); }
          else { const r = await api.saveYearlyWrapImage({ dataUrl: url, name: `Hive-Yearly-Wrap-${data.year}-${index + 1}.png` }); if (r?.ok) setStatus('Saved.'); else if (!r?.canceled) setStatus("Couldn't save the picture."); }
        } catch (err) { setStatus(`That didn't work: ${err?.message || err}`); }
      }
    });
    root.addEventListener('keydown', e => {
      if (e.target.closest('select,input,textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(index + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(index - 1); }
      else if (e.key === 'Home') { e.preventDefault(); go(0); }
      else if (e.key === 'End') { e.preventDefault(); go(slides.length - 1); }
      else if (e.key === 'Escape' && !$('.wrapv-month').classList.contains('hidden')) { e.preventDefault(); e.stopPropagation(); closeMonth(); }
    });
    root.addEventListener('wheel', e => {
      if (e.target.closest('.wrapv-month')) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) < 18) return;
      const now = Date.now(); if (now < wheelLock) return; wheelLock = now + 650;
      go(index + (d > 0 ? 1 : -1));
    }, { passive: true });
    yearSel.addEventListener('change', () => load(Number(yearSel.value)));

    async function load(year) {
      try {
        if (!years.length) years = (await api.getYearlyWrapYears()) || [];
        const current = new Date().getFullYear();
        if (!years.includes(current)) years = [current, ...years];
        years = [...new Set(years)].sort((a, b) => b - a);
        yearSel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
        const want = year || years[0];
        yearSel.value = String(want);
        data = await api.getYearlyWrapData(want);
        if (!alive) return;
        index = 0;
        render();
        root.focus({ preventScroll: true });
      } catch (err) {
        track.innerHTML = `<div class="wrapv-slide in"><div class="wrapv-col"><h2 class="wrapv-title">Yearly Wrap couldn't load.</h2><p class="wrapv-sub">${esc(err?.message || err)}</p></div></div>`;
      }
    }
    load(opts.year);
    return { destroy() { alive = false; host.innerHTML = ''; } };
  }

  if (typeof window !== 'undefined') window.HiveYearlyWrapView = { mount, monthDetail };
  if (typeof module !== 'undefined') module.exports = { monthDetail, dayLine, everyDays };
})();
