'use strict';

// Canonical Beehive metadata model. File-format specific readers/writers can
// translate into this shape without making the UI care whether a value came
// from Vorbis comments, ID3, MP4 atoms, etc.
const ALIASES = {
  albumArtist: ['albumArtist','albumartist','album_artist','ALBUMARTIST','ALBUM ARTIST'],
  sortArtist: ['sortArtist','artistsort','artistSort','ARTISTSORT','ARTIST SORT'],
  sortAlbum: ['sortAlbum','albumsort','albumSort','ALBUMSORT','ALBUM SORT'],
  sortAlbumArtist: ['sortAlbumArtist','albumartistsort','albumArtistSort','ALBUMARTISTSORT','ALBUM ARTIST SORT'],
  musicBrainzArtistId: ['musicBrainzArtistId','musicbrainz_artistid','MUSICBRAINZ_ARTISTID'],
  musicBrainzReleaseId: ['musicBrainzReleaseId','musicbrainz_albumid','MUSICBRAINZ_ALBUMID'],
  musicBrainzRecordingId: ['musicBrainzRecordingId','musicbrainz_recordingid','MUSICBRAINZ_TRACKID'],
  musicBrainzReleaseGroupId: ['musicBrainzReleaseGroupId','musicbrainz_releasegroupid','MUSICBRAINZ_RELEASEGROUPID'],
  acoustId: ['acoustId','acoustid_id','ACOUSTID_ID']
};

function firstValue(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && String(source[key]) !== '') return source[key];
  }
  return '';
}

function canonicalize(input = {}) {
  const out = { ...input };
  for (const [canonical, keys] of Object.entries(ALIASES)) {
    const value = firstValue(input, keys);
    if (value !== '') out[canonical] = value;
  }
  if (out.albumArtist === undefined) out.albumArtist = '';
  if (out.sortArtist === undefined) out.sortArtist = '';
  if (out.sortAlbum === undefined) out.sortAlbum = '';
  if (out.sortAlbumArtist === undefined) out.sortAlbumArtist = '';
  if (out.year !== undefined && out.year !== '') out.year = Number.parseInt(String(out.year).slice(0,4), 10) || out.year;
  if (out.track !== undefined && out.track !== '') out.track = Number.parseInt(String(out.track), 10) || out.track;
  if (out.disc !== undefined && out.disc !== '') out.disc = Number.parseInt(String(out.disc), 10) || out.disc;
  return out;
}

module.exports = { canonicalize, ALIASES };
