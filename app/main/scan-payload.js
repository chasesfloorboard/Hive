'use strict';

// The main process keeps the complete scanner record for the on-disk cache and
// SQLite.  The renderer only needs the normalized library fields and the small
// compatibility/custom-tag surface used by views.  In particular, nativeTags
// is intentionally not crossed the renderer boundary: it is reread from the
// audio file when the tag editor opens.
const RENDERER_TRACK_FIELDS = [
  'id','path','title','artist','album','albumArtist','year','genre','composer','publisher',
  'conductor','comment','grouping','copyright','originalArtist','originalAlbum','originalYear',
  'language','mood','occasion','keywords','quality','tempo','isrc','barcode','track','trackCount',
  'disk','discCount','duration','sampleRate','bitrate','bitDepth','channels','codec','cover','covers',
  'loved','lyrics','rating','ratingRaw','ratingHydrated','startTime','endTime','customTags',
  'fileMtimeMs','fileCtimeMs','fileSize','addedAt','playCount','skipCount','lastPlayedAt',
  'loveHydrated','loveCheckedMtimeMs','loveCheckedSize','loveScanVersion','metadataScanVersion','artworkScanVersion'
];

function rendererTrackPayload(track) {
  if (!track || typeof track !== 'object') return track;
  const out = {};
  for (const key of RENDERER_TRACK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(track, key)) out[key] = track[key];
  }
  return out;
}

module.exports = { rendererTrackPayload, RENDERER_TRACK_FIELDS };
