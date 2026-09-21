// Small inline SVG icon set for the playback bar (no emoji, no external deps).
// Every icon uses currentColor so it inherits button text color / hover states.
(function () {
  const ICONS = {
    prev: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h2v12H4z"/><path d="M20 6l-8 6 8 6z"/><path d="M13 6l-8 6 8 6z"/></svg>`,

    next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 6h2v12h-2z"/><path d="M4 6l8 6-8 6z"/><path d="M11 6l8 6-8 6z"/></svg>`,

    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,

    pause: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>`,

    heartOutline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 20.2S3.9 15.4 3.9 9.6C3.9 6.6 6.1 4.6 8.7 4.6c1.9 0 3.3 1.1 3.3 1.1s1.4-1.1 3.3-1.1c2.6 0 4.8 2 4.8 5 0 5.8-8.1 10.6-8.1 10.6z"/></svg>`,

    heartFilled: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.2S3.9 15.4 3.9 9.6C3.9 6.6 6.1 4.6 8.7 4.6c1.9 0 3.3 1.1 3.3 1.1s1.4-1.1 3.3-1.1c2.6 0 4.8 2 4.8 5 0 5.8-8.1 10.6-8.1 10.6z"/></svg>`,

    shuffleOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h14"/><polyline points="15.5 4.5 18 7 15.5 9.5"/><path d="M4 17h14"/><polyline points="15.5 14.5 18 17 15.5 19.5"/></svg>`,

    shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3c2 0 2.9.8 4 2.3"/><path d="M4 17h3c2 0 2.9-.8 4-2.3l3.6-5.4c1.1-1.5 2-2.3 4-2.3H20"/><polyline points="17.2 4.3 20.2 7 17.2 9.7"/><path d="M13.3 14.7l.7 1c1.1 1.5 2 2.3 4 2.3H20"/><polyline points="17.2 14.3 20.2 17 17.2 19.7"/></svg>`,

    repeatOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.5V9a4 4 0 0 1 4-4H19"/><polyline points="16 2 19 5 16 8"/><path d="M20.5 13.5V15a4 4 0 0 1-4 4H5"/><polyline points="8 22 5 19 8 16"/><line x1="4" y1="4" x2="20" y2="20"/></svg>`,

    repeatAll: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.5V9a4 4 0 0 1 4-4H19"/><polyline points="16 2 19 5 16 8"/><path d="M20.5 13.5V15a4 4 0 0 1-4 4H5"/><polyline points="8 22 5 19 8 16"/></svg>`,

    repeatOne: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 10.5V9a4 4 0 0 1 4-4H19"/><polyline points="16 2 19 5 16 8"/><path d="M20.5 13.5V15a4 4 0 0 1-4 4H5"/><polyline points="8 22 5 19 8 16"/><path d="M12 9v6"/><path d="M10.5 10.5L12 9l1.5 1.5"/></svg>`,

    volMute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><line x1="16.5" y1="9.5" x2="21.5" y2="14.5"/><line x1="21.5" y1="9.5" x2="16.5" y2="14.5"/></svg>`,

    volLow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16.3 9.8a4 4 0 0 1 0 4.4"/></svg>`,

    volHigh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none"/><path d="M16.3 9.8a4 4 0 0 1 0 4.4"/><path d="M18.8 7.3a7.5 7.5 0 0 1 0 9.4"/></svg>`,

    chevronLeft: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"/></svg>`,

    chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`,
    queue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M5 12h14M5 18h9"/><circle cx="18" cy="18" r="2.2" fill="currentColor" stroke="none"/></svg>`,

    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,

    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,

    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.2"/><path d="M16 16l4.5 4.5"/></svg>`,

    edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.8-10.8a2.1 2.1 0 0 0-4-4L4 16v4z"/><path d="M13.8 6.2l4 4"/></svg>`,

    tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h9l7 7-8 8-8-8V5z"/><circle cx="8" cy="9" r="1.2" fill="currentColor" stroke="none"/></svg>`,

    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3.8l2.55 5.17 5.71.83-4.13 4.03.98 5.69L12 16.83l-5.11 2.69.98-5.69-4.13-4.03 5.71-.83L12 3.8z"/></svg>`,

    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14"/><path d="M9 7V4.5h6V7"/><path d="M7 7l.8 13h8.4L17 7"/><path d="M10 11v5M14 11v5"/></svg>`,

    lyrics: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`,

    align: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 7h14M8 12h8M5 17h14"/></svg>`,

    settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.72 1.72-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2.44v-.18a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.72-1.72.06-.06A1.7 1.7 0 0 0 8.4 15a1.7 1.7 0 0 0-1.56-1.03H6.66v-2.44h.18A1.7 1.7 0 0 0 8.4 10a1.7 1.7 0 0 0-.34-1.88L8 8.06l1.72-1.72.06.06A1.7 1.7 0 0 0 11.66 6h.18v-.18h2.44V6a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06L19 8.88l-.06.06A1.7 1.7 0 0 0 18.6 10a1.7 1.7 0 0 0 1.56 1.03h.18v2.44h-.18A1.7 1.7 0 0 0 19.4 15z"/></svg>`
  };

  window.BeehiveIcons = ICONS;
})();
