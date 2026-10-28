'use strict';

// Likes for streamed songs (YouTube Music, Apple Music, Spotify, previews).
// They have no file to tag, so Hive keeps them in its settings as
// prefs.streamLoves, keyed by artist + title so the same song stays liked
// wherever it turns up, on the PC and on the phone:
//   { "<artist>|<title>": { loved, at, path, title, artist, album, ..., appliedAt } }
// An entry without `loved` is from before the phone shared them: liked.
// Unliking keeps the entry (loved:false) so the other side learns of it.
// `appliedAt` is when the like last reached a file of the same song here.

function norm(v) {
  return String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[\(\[](feat\.?|ft\.?|with)[^\)\]]*[\)\]]/g, ' ').replace(/[^a-z0-9\p{L}\p{N}]+|(?![a-z])\p{Script=Latin}/gu, '');
}

function streamLoveKey(t) {
  const artist = String(t?.artist || '').split(/,|&| feat\.? | ft\.? /i)[0];
  return `${norm(artist)}|${norm(t?.title)}`;
}

function isLoved(entry) { return !!entry && entry.loved !== false; }

const TEXT_FIELDS = ['path', 'title', 'artist', 'album', 'albumArtist', 'artworkUrl', 'cover', 'appleMusicUrl', 'spotifyUri'];

// Changes from another device, newest wins per song. Returns the new map and
// the keys that changed; `current` is left as it was.
function mergeStreamLoves(current, changes) {
  const loves = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) };
  const changed = [];
  for (const c of Array.isArray(changes) ? changes.slice(0, 2000) : []) {
    if (!c || typeof c !== 'object' || !String(c.title || '').trim()) continue;
    const key = streamLoveKey(c);
    if (key.endsWith('|') || key.startsWith('|')) continue;
    // A phone's clock running ahead can't make its like newer than anything to come.
    const at = Math.min(Number(c.at) || 0, Date.now());
    const existing = loves[key];
    if (!at || (existing && (Number(existing.at) || 0) >= at)) continue;
    const next = { ...(existing || {}), loved: !!c.loved, at };
    for (const f of TEXT_FIELDS) if (String(c[f] || '').trim() && !next[f]) next[f] = String(c[f]);
    if (Number(c.duration) > 0 && !(Number(next.duration) > 0)) next.duration = Number(c.duration);
    loves[key] = next;
    changed.push(key);
  }
  return { loves, changed };
}

module.exports = { streamLoveKey, isLoved, mergeStreamLoves };
