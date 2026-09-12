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

    chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>`
  };

  window.BeehiveIcons = ICONS;
})();
