#!/usr/bin/env python3
import base64, hashlib, json, mimetypes, os, shutil, sys, tempfile
from pathlib import Path

# The bundled mutagen package is kept beside this helper so Beehive does not
# require a system Python package installation.
HERE = Path(__file__).resolve().parent
# The vendored mutagen package lives in resources/mutagen, a sibling of this
# resources/python/ directory -- not inside it. Insert the parent so the
# bundled copy is found instead of falling through to (and failing on) an
# unavailable system Python installation.
sys.path.insert(0, str(HERE.parent))

from mutagen import File
from mutagen.id3 import Frames, ID3, ID3NoHeaderError, TIT2, TPE1, TALB, TPE2, TCON, TDRC, TRCK, TPOS, COMM, TCOM, TIT1, TCOP, TPUB, TPE3, TBPM, USLT, TCMP, TXXX, APIC, POPM, SYLT, ID3TimeStamp, TSOA, TSOT, TSO2, TSOP, TSOC
from mutagen.flac import FLAC, Picture
from mutagen.mp4 import MP4, MP4Cover

TYPE_TO_ID3 = {
    'other': 0, 'file icon': 1, 'other file icon': 2, 'cover (front)': 3,
    'cover (back)': 4, 'leaflet page': 5, 'media': 6, 'lead artist': 7,
    'artist': 8, 'conductor': 9, 'band': 10, 'composer': 11, 'lyricist': 12,
    'recording location': 13, 'during recording': 14, 'during performance': 15,
    'movie/video screen capture': 16, 'video screen capture': 16, 'illustration': 18,
}
ID3_TO_LABEL = {
    0:'Other',1:'File Icon',2:'Other File Icon',3:'Cover (Front)',4:'Cover (Back)',
    5:'Leaflet Page',6:'Media',7:'Lead Artist',8:'Artist',9:'Conductor',10:'Band',
    11:'Composer',12:'Lyricist',13:'Recording Location',14:'During Recording',
    15:'During Performance',16:'Video Screen Capture',18:'Illustration'
}

STANDARD_MP3 = {
    'title': ('TIT2', TIT2), 'artist': ('TPE1', TPE1), 'album': ('TALB', TALB),
    'albumArtist': ('TPE2', TPE2), 'genre': ('TCON', TCON), 'year': ('TDRC', TDRC),
    'track': ('TRCK', TRCK), 'disk': ('TPOS', TPOS), 'comment': ('COMM', COMM),
    'composer': ('TCOM', TCOM), 'grouping': ('TIT1', TIT1), 'copyright': ('TCOP', TCOP),
    'publisher': ('TPUB', TPUB), 'conductor': ('TPE3', TPE3), 'bpm': ('TBPM', TBPM),
    'albumSort': ('TSOA', TSOA), 'titleSort': ('TSOT', TSOT), 'albumArtistSort': ('TSO2', TSO2),
    'artistSort': ('TSOP', TSOP), 'composerSort': ('TSOC', TSOC),
}
STANDARD_FLAC = {
    'title':'TITLE','artist':'ARTIST','album':'ALBUM','albumArtist':'ALBUMARTIST','genre':'GENRE',
    'year':'DATE','track':'TRACKNUMBER','disk':'DISCNUMBER','comment':'COMMENT','albumSort':'ALBUMSORT','titleSort':'TITLESORT','albumArtistSort':'ALBUMARTISTSORT','artistSort':'ARTISTSORT','composerSort':'COMPOSERSORT','composer':'COMPOSER',
    'grouping':'GROUPING','copyright':'COPYRIGHT','lyrics':'LYRICS','bpm':'BPM','publisher':'PUBLISHER',
    'conductor':'CONDUCTOR'
}
STANDARD_MP4 = {
    'title':'\xa9nam','artist':'\xa9ART','album':'\xa9alb','albumArtist':'aART','genre':'\xa9gen',
    'year':'\xa9day','comment':'\xa9cmt','composer':'\xa9wrt','grouping':'\xa9grp','copyright':'cprt',
    'publisher':'\xa9pub','bpm':'tmpo','track':'trkn','disk':'disk'
}


def first(v):
    if isinstance(v, list): return v[0] if v else ''
    return v

def norm_type(v):
    s = str(v or '').strip().lower()
    if s in ('3','cover (front)','album cover','front cover','front','cover','picturetype.cover_front','picturetype.cover front'): return 'Cover (Front)'
    if s in ('4','cover (back)','album cover (back)','back cover','back','picturetype.cover_back','picturetype.cover back'): return 'Cover (Back)'
    # Mutagen's enum string representation is e.g. PictureType.LEAFLET_PAGE.
    enum_key = s.replace('picturetype.', '').replace('_', ' ')
    enum_labels = {
        'cover front':'Cover (Front)', 'cover back':'Cover (Back)', 'leaflet page':'Leaflet Page',
        'media':'Media', 'lead artist':'Lead Artist', 'artist':'Artist', 'conductor':'Conductor',
        'band':'Band', 'composer':'Composer', 'lyricist':'Lyricist', 'recording location':'Recording Location',
        'during recording':'During Recording', 'during performance':'During Performance',
        'video screen capture':'Video Screen Capture', 'illustration':'Illustration', 'other':'Other'
    }
    if enum_key in enum_labels: return enum_labels[enum_key]
    return ID3_TO_LABEL.get(TYPE_TO_ID3.get(s, -1), str(v or 'Other') or 'Other')

def type_id(v): return TYPE_TO_ID3.get(str(v or '').strip().lower(), 0)

# Mutagen keys APIC frames by description alone. That means two perfectly valid
# ID3 pictures with the same (often empty) description would overwrite each
# other in the bundled Mutagen version. Keep the user's visible description
# unchanged while giving colliding APIC frames an invisible, stable suffix.
# This lets Beehive embed front + back + leaflet + any other picture types in
# one MP3 without one silently replacing another.
_APIC_HIDDEN_SUFFIX = '\u200b'

def visible_apic_desc(desc):
    return str(desc or '').replace(_APIC_HIDDEN_SUFFIX, '')

def unique_apic_desc(id3, desc):
    base = visible_apic_desc(desc)
    candidate = base
    while f'APIC:{candidate}' in id3:
        candidate += _APIC_HIDDEN_SUFFIX
    return candidate

def read_bytes(p):
    return bytes(p.data) if hasattr(p, 'data') else bytes(p)

def picture_json(data, ptype, mime, desc, index, width=0, height=0):
    return {
        'index': index, 'type': norm_type(ptype), 'mime': mime or 'image/jpeg', 'description': visible_apic_desc(desc),
        'width': int(width or 0), 'height': int(height or 0),
        'dataBase64': base64.b64encode(data).decode('ascii') if data else '',
    }

def read_artwork(path, include_data=True):
    ext = Path(path).suffix.lower()
    pics=[]
    def add_picture(data, ptype, mime, desc, index, width=0, height=0):
        if include_data:
            pics.append(picture_json(data, ptype, mime, desc, index, width, height))
        else:
            pics.append({'index': index, 'type': norm_type(ptype), 'mime': mime or 'image/jpeg', 'description': visible_apic_desc(desc), 'width': int(width or 0), 'height': int(height or 0)})
    if ext == '.flac':
        f=FLAC(path)
        for i,p in enumerate(f.pictures):
            add_picture(bytes(p.data), p.type, p.mime, p.desc, i, p.width, p.height)
    elif ext == '.mp3':
        try: tag=ID3(path)
        except ID3NoHeaderError: tag=None
        if tag:
            for i,p in enumerate(tag.getall('APIC')):
                add_picture(bytes(p.data), p.type, p.mime, p.desc, i)
    elif ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path); covers=(f.tags or {}).get('covr',[]) if f.tags else []
        for i,p in enumerate(covers):
            data=bytes(p)
            mime='image/png' if getattr(p,'imageformat',None) == MP4Cover.FORMAT_PNG else 'image/jpeg'
            add_picture(data, 'Cover (Front)' if i == 0 else 'Other', mime, '', i)
    else:
        f=File(path)
        if f and getattr(f,'pictures',None):
            for i,p in enumerate(f.pictures):
                add_picture(bytes(p.data), getattr(p,'type',0), getattr(p,'mime','image/jpeg'), getattr(p,'desc',''), i)
    # Some FLAC/MP3 files created by older tools contain a single primary
    # picture with the generic type 0 (Other). Treat the first picture as the
    # main Album Cover for Beehive's editor when no explicit front-cover type
    # exists. This is a read-side normalization only; saving it through the
    # Tags-tab cover action writes the proper native front-cover type.
    #
    # Real bug, reproduced live: this used to fire whenever NO picture was
    # Front-typed, regardless of what the first picture's REAL type actually
    # was. Removing the front cover from a file that had both Front and Back
    # covers correctly deleted the Front picture on disk, but the remaining
    # genuine Back cover then got relabeled as "Cover (Front)" here -- which
    # made performRemoveFrontArtwork's own verification step (which checks
    # whether anything is still typed Front) conclude the removal had
    # FAILED and report an error, even though it had actually succeeded.
    # Only apply the fallback to a picture whose real type is genuinely
    # generic/unspecified ("Other"), matching this heuristic's documented
    # intent above -- never override an explicit non-Front type like Back.
    if pics and pics[0].get('type') == 'Other' and not any(p.get('type') == 'Cover (Front)' for p in pics):
        pics[0]['type'] = 'Cover (Front)'
    return pics

def read_artwork_metadata(path):
    return read_artwork(path, include_data=False)

def artwork_contains_hash(path, wanted_hash):
    wanted = str(wanted_hash or '').lower()
    if not wanted:
        return False
    ext = Path(path).suffix.lower()
    if ext == '.flac':
        f=FLAC(path); data_list=[bytes(p.data) for p in f.pictures]
    elif ext == '.mp3':
        try: tag=ID3(path)
        except ID3NoHeaderError: tag=None
        data_list=[bytes(p.data) for p in tag.getall('APIC')] if tag else []
    elif ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path); data_list=[bytes(p) for p in ((f.tags or {}).get('covr',[]) if f.tags else [])]
    else:
        f=File(path); data_list=[bytes(p.data) for p in (getattr(f,'pictures',None) or [])]
    return any(hashlib.sha256(data).hexdigest().lower() == wanted for data in data_list)

def remove_txxx(tag, desc):
    wanted=str(desc).strip().lower()
    for frame in list(tag.getall('TXXX')):
        if str(frame.desc or '').strip().lower() == wanted:
            try: tag.delall(frame.HashKey)
            except Exception: pass

def set_txxx(tag, desc, value):
    remove_txxx(tag, desc)
    if str(value) != '': tag.add(TXXX(encoding=3, desc=str(desc), text=[str(value)]))

def set_text_frame(tag, frame_id, cls, value):
    tag.delall(frame_id)
    if str(value) != '': tag.add(cls(encoding=3, text=[str(value)]))

def set_comm(tag, value):
    # Only replace the conventional empty-description English comment. Other
    # COMM frames are preserved byte-for-byte by TagLib-like editing semantics.
    # The lang comparison must strip() before lower()-ing: a real file was
    # found with lang == '   ' (raw whitespace, not a valid ISO 639-2 code,
    # presumably written by whatever tool embedded the original content) --
    # that failed to match '' and was silently left behind as a second,
    # stale frame every time this ran, since Hive is the single authoritative
    # writer for its own default-language field and never intended to keep a
    # duplicate around just because its language tag was malformed.
    for frame in list(tag.getall('COMM')):
        if (frame.desc or '') == '' and (frame.lang or '').strip().lower() in ('eng','und',''):
            try: tag.delall(frame.HashKey)
            except Exception: pass
    if str(value) != '': tag.add(COMM(encoding=3, lang='eng', desc='', text=[str(value)]))

def set_uslt(tag, value):
    # See set_comm's comment: the lang comparison must strip() before
    # lower()-ing, or a frame with a malformed (but not meaningfully
    # different) language code -- e.g. '   ', 'XXX', or '\x00\x00\x00', all
    # found in real files -- is wrongly treated as a distinct, intentionally
    # separate lyrics frame and left behind as a stale duplicate instead of
    # being replaced.
    def is_default_lang(raw):
        cleaned = (raw or '').strip().lower()
        # 'xxx' is a common placeholder some tools write for "no real
        # language set" (not a genuine ISO 639-2 code); null bytes and other
        # non-alphabetic junk are caught by the isalpha() check.
        return cleaned in ('eng', 'und', '', 'xxx') or not cleaned.isalpha()
    for frame in list(tag.getall('USLT')):
        if (frame.desc or '') == '' and is_default_lang(frame.lang):
            try: tag.delall(frame.HashKey)
            except Exception: pass
    if str(value) != '': tag.add(USLT(encoding=3, lang='eng', desc='', text=str(value)))

def parse_lrc_entries(value):
    """Return [(text, milliseconds), ...] for ordinary LRC timestamp lines."""
    import re
    source = str(value or '').replace('\r\n', '\n').replace('\r', '\n')
    stamp_re = re.compile(r'\[(?:(\d+):)?(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]')
    entries = []
    for line in source.split('\n'):
        matches = list(stamp_re.finditer(line))
        if not matches: continue
        text = stamp_re.sub('', line).strip()
        for m in matches:
            hours = int(m.group(1) or 0)
            minutes = int(m.group(2) or 0)
            seconds = int(m.group(3) or 0)
            fraction = m.group(4) or ''
            ms = hours * 3600000 + minutes * 60000 + seconds * 1000
            if fraction:
                ms += int((fraction + '000')[:3])
            entries.append((text, ms))
    entries.sort(key=lambda x: x[1])
    return entries

def plain_from_lrc(value):
    import re
    source = str(value or '').replace('\r\n', '\n').replace('\r', '\n')
    # Matches a timestamp token in either LRC's line-level [mm:ss.xx] form or
    # enhanced/word-level LRC's inline <mm:ss.xx> karaoke form, with either a
    # period or comma as the fractional separator. Previously this only
    # matched the bracket form with a period/colon separator; any other
    # real-world variant silently passed through unchanged (this function is
    # what USLT -- the "standard" embedded lyrics tag -- is written from),
    # so a provider using one of these leaked raw synced text with visible
    # timestamps into the file being embedded as "plain" lyrics.
    stamp_re = re.compile(r'[\[<](?:(?:\d+):)?\d{1,3}:\d{2}(?:[.,:]\d{1,3})?[\]>]')
    lines = (re.sub(r'\s{2,}', ' ', stamp_re.sub('', line)).strip() for line in source.split('\n'))
    return '\n'.join(line for line in lines if line)

def set_sylt(tag, value):
    tag.delall('SYLT')
    entries = parse_lrc_entries(value)
    if not entries: return
    tag.add(SYLT(encoding=3, lang='eng', format=2, desc='', type=1, text=entries))

def apply_id3_fields(id3, tags):
    """Write ordinary tag fields onto an already-open ID3-like tags object.

    Shared by write_mp3 (a real .mp3's ID3 object) and WAV's write_metadata/
    write_tags branches: mutagen.wave.WAVE's .tags is also a real ID3Tags
    instance (the "id3 " RIFF chunk), so a bare `tags[key] = str(v)` raises
    "not a Frame instance" for WAV exactly like it would for a raw .mp3 --
    both need proper Frame objects, unlike FLAC/MP4's plain dict-of-strings
    tag containers.
    """
    for key,(fid,cls) in STANDARD_MP3.items():
        if key not in tags: continue
        value=tags[key]
        if key == 'comment': set_comm(id3,value)
        else: set_text_frame(id3,fid,cls,value)
    if 'lyrics' in tags:
        # USLT is the plain-lyrics tag every player reads, so it must never
        # contain raw [mm:ss.xx] timestamps regardless of what was passed in --
        # strip them unconditionally. A real ID3 SYLT frame carries the timed
        # text instead, and only gets written when the user explicitly chose
        # synced mode; plain mode removes SYLT so a user can genuinely replace
        # synchronized lyrics with plain text.
        lyrics = str(tags.get('lyrics') or '')
        set_uslt(id3, plain_from_lrc(lyrics))
        sync_mode = str(tags.get('LYRICS_SYNC') or '').strip().lower()
        if sync_mode == 'synced':
            set_sylt(id3, lyrics)
        elif sync_mode == 'unsynced':
            id3.delall('SYLT')
    if 'compilation' in tags:
        id3.delall('TCMP')
        if str(tags['compilation']) == '1': id3.add(TCMP(encoding=3, text=['1']))
        # Remove only the legacy alias Beehive used to create; leave unrelated TXXX data intact.
        remove_txxx(id3,'compilation')
    native_sort = {'TSOA': TSOA, 'TSOT': TSOT, 'TSO2': TSO2, 'TSOP': TSOP, 'TSOC': TSOC}
    # Same reasoning as the FLAC writer's standard_fields guard: a stale raw
    # frame id in the advanced/custom tags (e.g. a leftover "USLT" from a
    # previous read) must never re-overwrite a frame the dedicated writers
    # above (set_uslt/set_sylt/set_text_frame) already wrote correctly.
    # Only reserve frame ids the semantic writers above actually wrote THIS
    # call (i.e. their semantic key was present in tags) -- otherwise a raw
    # frame id that happens to match a STANDARD_MP3 target (e.g. 'TDRC',
    # the year frame) but was passed without the 'year' key would be
    # silently dropped instead of written as the native frame it is.
    reserved_frame_ids = {fid for key,(fid,_cls) in STANDARD_MP3.items() if key in tags}
    if 'lyrics' in tags: reserved_frame_ids |= {'USLT', 'SYLT'}
    if 'compilation' in tags: reserved_frame_ids |= {'TCMP'}
    for k,v in tags.items():
        if k in STANDARD_MP3 or k in ('lyrics','compilation'): continue
        if k in native_sort:
            set_text_frame(id3, k, native_sort[k], v)
            continue
        if k == 'p_count' or k.startswith('custom') or k.startswith('BEEHIVE_') or k in ('NO_LYRICS','LYRICS_SYNC','START_TIME','END_TIME'):
            set_txxx(id3,k,v)
        elif str(k).upper().startswith('TXXX:'):
            set_txxx(id3, str(k)[5:], v)
        elif len(k) == 4 and k.isupper() and k in reserved_frame_ids:
            continue
        elif len(k) == 4 and k.isupper():
            # Tags (2) exposes native ID3 text frames by their real frame ID.
            # Mutagen knows the concrete class for standard T* frames, so write
            # those as genuine native frames rather than flattening them into TXXX.
            frame_cls = Frames.get(k)
            if frame_cls is not None and k.startswith('T'):
                try:
                    set_text_frame(id3, k, frame_cls, v)
                except Exception:
                    set_txxx(id3, k, v)
            else:
                # Unknown/non-text frames cannot safely be reconstructed from a
                # plain string. Preserve the user's file and expose those frames
                # read-only in the editor instead of fabricating binary metadata.
                pass
        else:
            # Any other named field (ReplayGain/R128 gain-peak tags, or any
            # other custom name that isn't a bare 4-char frame id) falls
            # through every branch above with nothing writing it -- it was
            # silently dropped. Store it the same way MusicBee/other taggers
            # do: a TXXX frame keyed by that literal name, matching how the
            # reader already surfaces arbitrary TXXX descriptions.
            set_txxx(id3, k, v)

def write_mp3(path, tags, save=True):
    try: id3=ID3(path)
    except ID3NoHeaderError: id3=ID3()
    apply_id3_fields(id3, tags)
    if save: id3.save(path, v2_version=4, v1=0)
    return id3

def write_flac(path, tags, save=True):
    f=FLAC(path)
    for key,field in STANDARD_FLAC.items():
        if key in tags:
            val=tags[key]
            # FLAC has no dedicated synced-lyrics container (unlike MP3's SYLT
            # frame), so the single LYRICS comment must never carry raw
            # [mm:ss.xx] timestamps -- strip them unconditionally.
            if key == 'lyrics' and val is not None: val = plain_from_lrc(val)
            if val is None or str(val)=='':
                if f.tags and field in f.tags: del f.tags[field]
            else: f[field]=str(val)
    if 'compilation' in tags:
        if str(tags['compilation']) == '1': f['COMPILATION']='1'
        else:
            if f.tags and 'COMPILATION' in f.tags: del f.tags['COMPILATION']
    flac_special = {'TSOA':'ALBUMSORT','TSOT':'TITLESORT','TSO2':'ALBUMARTISTSORT','TSOP':'ARTISTSORT','TSOC':'COMPOSERSORT'}
    # A stale duplicate in the advanced/custom tags (e.g. a leftover raw
    # "LYRICS" entry from a previous read) must never re-overwrite a field the
    # standard loop above already wrote correctly from its own dedicated
    # input -- whichever key happened to iterate last would otherwise silently
    # win, undoing the user's actual edit.
    standard_fields = set(STANDARD_FLAC.values())
    for k,v in tags.items():
        if k in STANDARD_FLAC or k=='compilation': continue
        field = flac_special.get(k, str(k).upper())
        if field in standard_fields: continue
        if str(v)=='':
            if f.tags and field in f.tags: del f.tags[field]
        else: f[field]=str(v)
    if save: f.save()
    return f

def mp4_value(key, value):
    if key in ('track','disk'):
        s=str(value); parts=s.split('/',1)
        try: n=int(parts[0] or 0); total=int(parts[1]) if len(parts)>1 and parts[1] else 0
        except: n,total=0,0
        return [(n,total)]
    if key=='bpm':
        try:return [int(float(value))]
        except:return [0]
    return [str(value)]

def write_mp4(path,tags,save=True):
    f=MP4(path)
    if f.tags is None: f.add_tags()
    for key,atom in STANDARD_MP4.items():
        if key not in tags: continue
        v=tags[key]
        if v is None or str(v)=='': f.tags.pop(atom,None)
        else: f.tags[atom]=mp4_value(key,v)
    if 'compilation' in tags:
        if str(tags['compilation'])=='1': f.tags['cpil']=[True]
        else: f.tags.pop('cpil',None)
    for k,v in tags.items():
        if k in STANDARD_MP4 or k=='compilation': continue
        # MP4 has no dedicated synced-lyrics atom (unlike MP3's SYLT frame),
        # so the freeform lyrics atom must never carry raw [mm:ss.xx]
        # timestamps -- strip them unconditionally.
        if k == 'lyrics' and v is not None: v = plain_from_lrc(v)
        atom=f'----:com.apple.iTunes:{k}'
        if str(v)=='': f.tags.pop(atom,None)
        else: f.tags[atom]=[str(v).encode('utf-8')]
    if save: f.save()
    return f

def make_flac_picture(image_path, ptype, desc):
    data=Path(image_path).read_bytes(); mime=mimetypes.guess_type(image_path)[0] or 'image/jpeg'
    p=Picture(); p.type=type_id(ptype); p.mime=mime; p.desc=str(desc or ''); p.data=data
    try:
        from PIL import Image
        with Image.open(image_path) as im: p.width,p.height=im.size
    except Exception: pass
    return p

def make_apic(image_path, ptype, desc, id3=None):
    data=Path(image_path).read_bytes(); mime=mimetypes.guess_type(image_path)[0] or 'image/jpeg'
    storage_desc = unique_apic_desc(id3, desc) if id3 is not None else visible_apic_desc(desc)
    return APIC(encoding=3, mime=mime, type=type_id(ptype), desc=storage_desc, data=data)

def artwork_fingerprint(path):
    """Return a stable fingerprint of embedded artwork without exposing image bytes."""
    import hashlib
    ext = Path(path).suffix.lower()
    rows = []
    if ext == '.flac':
        f = FLAC(path)
        pics = f.pictures or []
        for p in pics:
            rows.append((int(getattr(p, 'type', 0) or 0), str(getattr(p, 'mime', '') or ''), str(getattr(p, 'desc', '') or ''), hashlib.sha256(bytes(p.data)).hexdigest()))
    elif ext == '.mp3':
        try: tag = ID3(path)
        except ID3NoHeaderError: tag = None
        if tag:
            for p in tag.getall('APIC'):
                rows.append((int(getattr(p, 'type', 0) or 0), str(getattr(p, 'mime', '') or ''), visible_apic_desc(getattr(p, 'desc', '')), hashlib.sha256(bytes(p.data)).hexdigest()))
    elif ext in ('.m4a','.mp4','.m4b'):
        f = MP4(path)
        for p in ((f.tags or {}).get('covr', []) if f.tags else []):
            rows.append(('', 'image/png' if getattr(p, 'imageformat', None) == MP4Cover.FORMAT_PNG else 'image/jpeg', '', hashlib.sha256(bytes(p)).hexdigest()))
    else:
        f = File(path, easy=False)
        for p in (getattr(f, 'pictures', None) or []) if f else []:
            rows.append((int(getattr(p, 'type', 0) or 0), str(getattr(p, 'mime', '') or ''), str(getattr(p, 'desc', '') or ''), hashlib.sha256(bytes(p.data)).hexdigest()))
    # Mutagen does not guarantee stable frame order across a save/reload --
    # sort so this fingerprint reflects the same-set-of-pictures question it's
    # meant to answer, not incidental frame ordering (see CLAUDE.md/session
    # notes on the P_count-write "artwork changed" false positive).
    rows.sort()
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()

def protected_metadata_fingerprint(path):
    """Return a canonical fingerprint of all metadata except embedded artwork.

    Artwork operations are deliberately isolated: Love, Rating, ordinary tags,
    custom fields, lyrics, etc. must survive an artwork-only edit unchanged.
    """
    import hashlib
    ext = Path(path).suffix.lower()
    rows = []
    if ext == '.flac':
        f = FLAC(path)
        for key in sorted((f.tags or {}).keys()):
            vals = f.tags.getall(key) if hasattr(f.tags, 'getall') else f.tags.get(key, [])
            rows.append((str(key), [str(v) for v in vals]))
    elif ext == '.mp3':
        try: tag = ID3(path)
        except ID3NoHeaderError: tag = ID3()
        for key in sorted(tag.keys()):
            if str(key).startswith('APIC:'):
                continue
            rows.append((str(key), [str(frame) for frame in tag.getall(key.split(':',1)[0])] if ':' not in key else [str(tag[key])]))
    elif ext in ('.m4a','.mp4','.m4b'):
        f = MP4(path)
        for key in sorted((f.tags or {}).keys()):
            if key == 'covr':
                continue
            value = (f.tags or {}).get(key)
            rows.append((str(key), [str(v) for v in value] if isinstance(value, list) else str(value)))
    else:
        f = File(path, easy=False)
        tags = getattr(f, 'tags', None) if f else None
        if tags:
            for key in sorted(tags.keys(), key=str):
                if str(key).lower().startswith('apic') or str(key).lower() == 'covr':
                    continue
                rows.append((str(key), str(tags[key])))
    payload = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()

def clear_artwork(path):
    ext = Path(path).suffix.lower()
    if ext == '.flac':
        f = FLAC(path); f.clear_pictures(); f.save(); return
    if ext == '.mp3':
        try: id3 = ID3(path)
        except ID3NoHeaderError: return
        id3.delall('APIC'); id3.save(v2_version=4, v1=0); return
    if ext in ('.m4a','.mp4','.m4b'):
        f = MP4(path)
        if f.tags is not None: f.tags.pop('covr', None); f.save()
        return
    raise RuntimeError(f'Native artwork editing is not implemented for {ext or "this format"}.')

def apply_artwork_flac(f, op):
    action=str(op.get('action','')).lower()
    image=op.get('imagePath')
    ptype=norm_type(op.get('pictureType','Cover (Front)'))
    desc=str(op.get('comment','') or '')
    old=list(f.pictures)
    if action=='add':
        wanted=hashlib.sha256(Path(image).read_bytes()).hexdigest() if image else ''
        if not any(hashlib.sha256(bytes(p.data)).hexdigest() == wanted for p in old):
            old.append(make_flac_picture(image,ptype,desc))
    elif action in ('replace','update'):
        index=int(op.get('index',-1))
        if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
        if action=='replace': old[index]=make_flac_picture(image,ptype,desc)
        else:
            old[index].type=type_id(ptype); old[index].desc=desc
    elif action=='delete':
        index=int(op.get('index',-1))
        if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
        del old[index]
    elif action=='remove_front':
        indexes=[i for i,p in enumerate(old) if norm_type(getattr(p,'type',0))=='Cover (Front)']
        if not indexes and old: indexes=[0]
        old=[p for i,p in enumerate(old) if i not in set(indexes)]
    elif action=='remove_all':
        old=[]
    elif action=='write':
        front_indexes=[i for i,p in enumerate(old) if norm_type(getattr(p,'type',0))=='Cover (Front)']
        if front_indexes:
            old[front_indexes[0]]=make_flac_picture(image,ptype,desc)
        else:
            old.insert(0,make_flac_picture(image,ptype,desc))
    elif action=='replace_slot':
        target_type=norm_type(op.get('slotType','Other'))
        occurrence=max(1,int(op.get('occurrence',1) or 1)); seen=0; index=-1
        for i,p in enumerate(old):
            if norm_type(getattr(p,'type',0)) != target_type: continue
            seen += 1
            if seen == occurrence: index=i; break
        if index < 0: raise RuntimeError('Artwork item no longer exists.')
        old[index]=make_flac_picture(image,ptype,desc)
    else:
        raise RuntimeError('Unknown artwork action.')
    f.clear_pictures()
    for picture in old: f.add_picture(picture)
    return f

def apply_artwork_mp3(id3, op):
    action=str(op.get('action','')).lower()
    image=op.get('imagePath')
    ptype=norm_type(op.get('pictureType','Cover (Front)'))
    desc=str(op.get('comment','') or '')
    old=list(id3.getall('APIC'))
    if action=='add':
        wanted=hashlib.sha256(Path(image).read_bytes()).hexdigest() if image else ''
        if not any(hashlib.sha256(bytes(p.data)).hexdigest() == wanted for p in old):
            id3.add(make_apic(image,ptype,desc,id3))
    elif action in ('replace','update'):
        index=int(op.get('index',-1))
        if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
        if action=='replace':
            existing_desc=visible_apic_desc(old[index].desc)
            replacement=make_apic(image,ptype,existing_desc)
            replacement.desc=old[index].desc
            old[index]=replacement
        else:
            old[index].type=type_id(ptype); old[index].desc=old[index].desc if old[index].desc else unique_apic_desc(id3,desc)
        id3.delall('APIC')
        for picture in old: id3.add(picture)
    elif action=='delete':
        index=int(op.get('index',-1))
        if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
        del old[index]; id3.delall('APIC')
        for picture in old: id3.add(picture)
    elif action=='remove_front':
        front_indexes=[i for i,p in enumerate(old) if norm_type(p.type)=='Cover (Front)']
        if not front_indexes and old: front_indexes=[0]
        keep=[p for i,p in enumerate(old) if i not in set(front_indexes)]
        id3.delall('APIC')
        for picture in keep: id3.add(picture)
    elif action=='remove_all':
        id3.delall('APIC')
    elif action=='write':
        front_indexes=[i for i,p in enumerate(old) if norm_type(p.type)=='Cover (Front)']
        if front_indexes:
            existing_desc=visible_apic_desc(old[front_indexes[0]].desc)
            replacement=make_apic(image,ptype,existing_desc)
            replacement.desc=old[front_indexes[0]].desc
            old[front_indexes[0]]=replacement
        else:
            old.insert(0,make_apic(image,ptype,desc,id3))
        id3.delall('APIC')
        for picture in old: id3.add(picture)
    elif action=='replace_slot':
        target_type=norm_type(op.get('slotType','Other'))
        occurrence=max(1,int(op.get('occurrence',1) or 1)); seen=0; index=-1
        for i,p in enumerate(old):
            if norm_type(p.type) != target_type: continue
            seen += 1
            if seen == occurrence: index=i; break
        if index < 0: raise RuntimeError('Artwork item no longer exists.')
        existing_desc=visible_apic_desc(old[index].desc)
        replacement=make_apic(image,ptype,existing_desc)
        replacement.desc=old[index].desc
        old[index]=replacement
        id3.delall('APIC')
        for picture in old: id3.add(picture)
    else:
        raise RuntimeError('Unknown artwork action.')
    return id3

def apply_artwork_mp4(f, op):
    action=str(op.get('action','')).lower()
    image=op.get('imagePath')
    old=list((f.tags or {}).get('covr',[]))
    def cover(path):
        return MP4Cover(Path(path).read_bytes(), imageformat=MP4Cover.FORMAT_PNG if Path(path).suffix.lower()=='.png' else MP4Cover.FORMAT_JPEG)
    if action=='add':
        wanted=hashlib.sha256(Path(image).read_bytes()).hexdigest() if image else ''
        if not any(hashlib.sha256(bytes(p)).hexdigest() == wanted for p in old): old.append(cover(image))
    elif action=='replace':
        index=int(op.get('index',-1))
        if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
        old[index]=cover(image)
    elif action=='delete':
        index=int(op.get('index',-1))
        if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
        del old[index]
    elif action=='remove_front':
        if old: old=old[1:]
    elif action=='remove_all': old=[]
    elif action=='write':
        if old: old[0]=cover(image)
        else: old.append(cover(image))
    elif action=='replace_slot':
        target_type=norm_type(op.get('slotType','Other'))
        occurrence=max(1,int(op.get('occurrence',1) or 1)); candidates=[]
        for i in range(len(old)):
            visible='Cover (Front)' if i==0 else 'Other'
            if visible == target_type: candidates.append(i)
        if occurrence > len(candidates): raise RuntimeError('Artwork item no longer exists.')
        old[candidates[occurrence-1]]=cover(image)
    elif action=='update':
        pass
    else: raise RuntimeError('Unknown artwork action.')
    if f.tags is None: f.add_tags()
    f.tags['covr']=old
    return f

def write_metadata(path, tags, artwork=None):
    """Apply ordinary tags and one artwork operation to the same opened file.

    This is the album-editor fast path: a single native parse and a single
    container save per file instead of rewriting the same audio file once for
    tags and again for artwork.
    """
    ext=Path(path).suffix.lower()
    artwork = artwork or None
    if ext=='.mp3':
        obj=write_mp3(path,tags,save=False)
        if artwork: apply_artwork_mp3(obj,artwork)
        obj.save(v2_version=4,v1=0)
        return
    if ext=='.flac':
        obj=write_flac(path,tags,save=False)
        if artwork: apply_artwork_flac(obj,artwork)
        obj.save()
        return
    if ext in ('.m4a','.mp4','.m4b'):
        obj=write_mp4(path,tags,save=False)
        if artwork: apply_artwork_mp4(obj,artwork)
        obj.save()
        return
    if ext=='.wav':
        # WAV's Mutagen tags object (the "id3 " RIFF chunk) is a real ID3Tags
        # instance, same as a bare .mp3 -- it needs proper Frame objects, not
        # the plain dict-of-strings the generic fallback below assumes. See
        # apply_id3_fields.
        from mutagen.wave import WAVE
        f=WAVE(path)
        tag=f.tags or f.add_tags() or f.tags
        apply_id3_fields(tag, tags)
        if artwork: apply_artwork_mp3(tag, artwork)
        f.save(v2_version=4)
        return
    if artwork:
        raise RuntimeError(f'Native artwork editing is not implemented for {ext or "this format"}.')
    # Preserve the existing generic Mutagen path for supported formats such as
    # OGG/Opus/AIFF (real plain dict-of-strings tag containers). MP3 and WAV
    # are both handled explicitly above because their tags are ID3 Frame
    # objects, not plain strings.
    f=File(path, easy=False)
    if f is None: raise RuntimeError(f'Unsupported audio format: {ext}')
    if getattr(f,'tags',None) is None:
        try:f.add_tags()
        except Exception: pass
    for k,v in tags.items():
        key='COMPILATION' if k=='compilation' else {'albumArtist':'ALBUMARTIST','year':'DATE','track':'TRACKNUMBER','disk':'DISCNUMBER'}.get(k,k.upper())
        if str(v)=='':
            try:f.tags.pop(key,None)
            except:pass
        else:f.tags[key]=str(v)
    f.save()

def modify_artwork(path, op):
    ext=Path(path).suffix.lower()
    if ext=='.flac':
        f=FLAC(path); apply_artwork_flac(f,op); f.save(); return
    if ext=='.mp3':
        try:id3=ID3(path)
        except ID3NoHeaderError:id3=ID3()
        apply_artwork_mp3(id3,op); id3.save(v2_version=4,v1=0); return
    if ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path); apply_artwork_mp4(f,op); f.save(); return
    raise RuntimeError(f'Native artwork editing is not implemented for {ext or "this format"}.')

def replace_front(path,image,ptype='Cover (Front)',comment=''):
    ext=Path(path).suffix.lower(); pics=read_artwork(path)
    idx=next((i for i,p in enumerate(pics) if p['type']=='Cover (Front)'), 0 if pics else -1)
    if idx>=0: modify_artwork(path,{'action':'replace','index':idx,'imagePath':image,'pictureType':'Cover (Front)','comment':comment})
    else: modify_artwork(path,{'action':'add','imagePath':image,'pictureType':'Cover (Front)','comment':comment})

def remove_front(path):
    pics=read_artwork(path)
    indexes=[p['index'] for p in pics if p['type']=='Cover (Front)']
    if not indexes and pics: indexes=[0]
    for idx in reversed(indexes): modify_artwork(path,{'action':'delete','index':idx})


def read_id3_fields(tag, requested):
    """Read requested fields from an already-open ID3-like tags object.

    Shared by .mp3 (a real .mp3's ID3 object) and .wav (mutagen.wave.WAVE's
    .tags, also a real ID3Tags instance -- see apply_id3_fields for the write
    side of this same WAV/ID3 gap). Extracted so WAV doesn't fall through to
    read_metadata_fields' generic dict-style fallback, which returns '' for
    every field on an ID3-backed tags object: real bug, reproduced live --
    performWriteMetadata's own post-write verification calls this to confirm
    a save landed, so it always failed for WAV with a false "verification
    failed" error even though the write itself succeeded.
    """
    out = {key: '' for key in requested}
    def text_value(value):
        if isinstance(value, list): value = value[0] if value else ''
        return str(value or '')
    frame_map = {key: fid for key, (fid, _cls) in STANDARD_MP3.items()}
    for key in requested:
        if key == 'lyrics':
            frames = tag.getall('USLT')
            if frames: out[key] = str(getattr(frames[0], 'text', '') or '')
        elif key == 'comment':
            frames = [f for f in tag.getall('COMM') if (f.desc or '') == '' and (f.lang or '').lower() in ('eng','und','')]
            if frames: out[key] = text_value(getattr(frames[0], 'text', ''))
        elif key in frame_map:
            frames = tag.getall(frame_map[key])
            if frames: out[key] = text_value(getattr(frames[0], 'text', ''))
        elif key in ('TSOT','TSOA','TSO2','TSOP','TSOC'):
            frames = tag.getall(key)
            if frames: out[key] = text_value(getattr(frames[0], 'text', ''))
        else:
            frames = tag.getall(key) if len(key) == 4 else []
            if frames: out[key] = text_value(getattr(frames[0], 'text', ''))
    return out

def read_metadata_fields(path, fields):
    """Read the requested ordinary metadata fields through the same Mutagen backend used for writes."""
    requested = [str(x) for x in (fields or [])]
    out = {key: '' for key in requested}
    ext = Path(path).suffix.lower()
    def text_value(value):
        if isinstance(value, list): value = value[0] if value else ''
        return str(value or '')
    if ext == '.mp3':
        try: tag = ID3(path)
        except ID3NoHeaderError: tag = ID3()
        return read_id3_fields(tag, requested)
    if ext == '.wav':
        from mutagen.wave import WAVE
        f = WAVE(path)
        if f.tags is None: return out
        return read_id3_fields(f.tags, requested)
    if ext == '.flac':
        f = FLAC(path)
        field_map = {key: field for key, field in STANDARD_FLAC.items()}
        for key in requested:
            field = field_map.get(key, key.upper())
            if key == 'lyrics': field = 'LYRICS'
            value = (f.tags or {}).get(field) if f.tags else None
            out[key] = text_value(value)
        return out
    if ext in ('.m4a','.mp4','.m4b'):
        f = MP4(path)
        tags = f.tags or {}
        atom_map = {key: atom for key, atom in STANDARD_MP4.items()}
        for key in requested:
            if key == 'lyrics':
                atom = '----:com.apple.iTunes:lyrics'
            else:
                atom = atom_map.get(key, f'----:com.apple.iTunes:{key}')
            value = tags.get(atom)
            if value is not None:
                if atom.startswith('----:') and isinstance(value, list) and value and isinstance(value[0], (bytes, bytearray)):
                    out[key] = bytes(value[0]).decode('utf-8', errors='replace')
                elif key in ('track','disk') and isinstance(value, list) and value:
                    pair = value[0]
                    try:
                        n, total = int(pair[0]), int(pair[1])
                        out[key] = f'{n}/{total}' if total else str(n)
                    except Exception:
                        out[key] = text_value(value)
                else:
                    out[key] = text_value(value)
        return out
    f = File(path, easy=False)
    tags = getattr(f, 'tags', None) if f else None
    if tags:
        for key in requested:
            value = tags.get(key)
            if value is None: value = tags.get(key.upper())
            out[key] = text_value(value)
    return out

def read_compilation(path):
    ext = Path(path).suffix.lower()
    if ext in ('.mp3', '.wav'):
        if ext == '.mp3':
            try: tag = ID3(path)
            except ID3NoHeaderError: return '0'
        else:
            # Same WAV/ID3 gap as read_metadata_fields -- WAV's tags object
            # is a real ID3Tags instance, TCMP lives there exactly like MP3.
            from mutagen.wave import WAVE
            f = WAVE(path)
            tag = f.tags
            if tag is None: return '0'
        frames = tag.getall('TCMP') if tag else []
        if frames and any(str(x).strip() == '1' for f in frames for x in getattr(f, 'text', [])):
            return '1'
        return '0'
    if ext == '.flac':
        f = FLAC(path)
        return '1' if str(first((f.get('COMPILATION') or [''])[0] if f.get('COMPILATION') else '')).strip() == '1' else '0'
    if ext in ('.m4a','.mp4','.m4b'):
        f = MP4(path)
        value = (f.tags or {}).get('cpil') if f.tags else None
        # Real bug, reproduced live: writing 'cpil' takes a list ([True], the
        # correct format mutagen expects -- see write_mp4), but re-parsing the
        # file fresh (a new MP4(path) object, not the same in-memory one) reads
        # a boolean MP4 atom back as a bare bool, not a list. value[0] on that
        # bare bool crashed with "'bool' object is not subscriptable" --
        # exactly the verification step performWriteMetadata always runs after
        # any M4A write that includes 'compilation', so every such save failed.
        if isinstance(value, (list, tuple)): value = value[0] if value else False
        return '1' if bool(value) else '0'
    try:
        f = File(path, easy=False)
        if f and getattr(f, 'tags', None):
            for key in ('COMPILATION','compilation'):
                value = f.tags.get(key)
                if value is not None and str(first(value)).strip() == '1': return '1'
    except Exception:
        pass
    return '0'


def _rating_255(stars):
    return max(0, min(255, int(round((float(stars or 0) / 5.0) * 255.0))))

def _set_freeform_mp4(tags, name, value):
    key=f'----:com.apple.iTunes:{name}'
    if str(value) == '': tags.pop(key, None)
    else: tags[key]=[str(value).encode('utf-8')]

def _remove_freeform_mp4(tags, names):
    wanted={str(x).strip().upper() for x in names}
    for key in list(tags.keys()):
        if not str(key).startswith('----:com.apple.iTunes:'): continue
        name=str(key).split(':',3)[-1].strip().upper()
        if name in wanted: tags.pop(key, None)

def write_rating(path, stars):
    """Write Hive's portable rating using Mutagen only.

    This is intentionally the single metadata backend for rating writes. The
    Electron layer must not use FFmpeg, metaflac, or handwritten MP4 atom
    reconstruction for a one-field metadata edit.
    """
    value=max(0.0, min(5.0, float(stars or 0)))
    ext=Path(path).suffix.lower()
    if ext in ('.mp3','.wav'):
        if ext=='.mp3':
            try: tag=ID3(path)
            except ID3NoHeaderError: tag=ID3()
        else:
            from mutagen.wave import WAVE
            f=WAVE(path)
            tag=f.tags or f.add_tags() or f.tags
        # Replace only Hive's portable rating fields; unrelated POPM/TXXX data survives.
        for frame in list(tag.getall('POPM')):
            if str(getattr(frame,'email','')).strip().lower() == 'musicbee':
                try: tag.delall(frame.HashKey)
                except Exception: pass
        remove_txxx(tag,'FMPS_Rating')
        tag.add(__import__('mutagen.id3', fromlist=['POPM']).POPM(email='musicbee', rating=_rating_255(value), count=0))
        set_txxx(tag,'FMPS_Rating',str(value/5.0))
        if ext=='.mp3': tag.save(path, v2_version=4, v1=0)
        else: f.save()
        return
    if ext=='.flac':
        f=FLAC(path)
        f['FMPS_RATING']=str(value/5.0)
        f.save(); return
    if ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path)
        if f.tags is None: f.add_tags()
        _set_freeform_mp4(f.tags,'FMPS_Rating',str(value/5.0))
        f.save(); return
    f=File(path, easy=False)
    if f is None: raise RuntimeError(f'Unsupported audio format: {ext}')
    if getattr(f,'tags',None) is None:
        try: f.add_tags()
        except Exception: pass
    if f.tags is None: raise RuntimeError(f'No writable metadata container for {ext}')
    key='FMPS/Rating' if ext=='.wma' else 'FMPS_RATING'
    if value <= 0: f.tags.pop(key,None)
    else: f.tags[key]=str(value/5.0)
    f.save()

def write_pcount(path, count):
    """Write Hive's embedded play count using Mutagen only (canonical single writer).

    A dedicated portable field (P_COUNT / P_Count) rather than FFmpeg container
    reconstruction -- see docs/ai/HIVE-METADATA-BACKEND-CANON.md section 3.
    """
    value = max(0, min(0xFFFFFFFF, int(count or 0)))
    ext = Path(path).suffix.lower()
    if ext in ('.mp3', '.wav'):
        if ext == '.mp3':
            try: tag = ID3(path)
            except ID3NoHeaderError: tag = ID3()
        else:
            from mutagen.wave import WAVE
            f = WAVE(path)
            tag = f.tags or f.add_tags() or f.tags
        remove_txxx(tag, 'P_COUNT')
        set_txxx(tag, 'P_COUNT', str(value))
        if ext == '.mp3': tag.save(path, v2_version=4, v1=0)
        else: f.save()
        return
    if ext == '.flac':
        f = FLAC(path)
        f['P_COUNT'] = str(value)
        f.save(); return
    if ext in ('.m4a', '.mp4', '.m4b'):
        f = MP4(path)
        if f.tags is None: f.add_tags()
        _set_freeform_mp4(f.tags, 'P_COUNT', str(value))
        f.save(); return
    f = File(path, easy=False)
    if f is None: raise RuntimeError(f'Unsupported audio format: {ext}')
    if getattr(f, 'tags', None) is None:
        try: f.add_tags()
        except Exception: pass
    if f.tags is None: raise RuntimeError(f'No writable metadata container for {ext}')
    key = 'P_Count' if ext == '.wma' else 'P_COUNT'
    f.tags[key] = str(value)
    f.save()

def read_pcount(path):
    """Read Hive's embedded play count back through Mutagen, symmetric with write_pcount."""
    ext = Path(path).suffix.lower()
    if ext in ('.mp3', '.wav'):
        if ext == '.mp3':
            try: tag = ID3(path)
            except ID3NoHeaderError: return 0
        else:
            from mutagen.wave import WAVE
            f = WAVE(path); tag = f.tags
        if not tag: return 0
        for frame in tag.getall('TXXX'):
            if str(getattr(frame, 'desc', '')).strip().upper() == 'P_COUNT':
                vals = getattr(frame, 'text', []) or []
                if vals:
                    try: return max(0, int(str(vals[0]).strip()))
                    except Exception: return 0
        return 0
    if ext == '.flac':
        f = FLAC(path)
        for k in (f.tags or {}).keys():
            if str(k).strip().upper() == 'P_COUNT':
                vals = f.tags.get(k) or []
                if vals:
                    try: return max(0, int(str(vals[0]).strip()))
                    except Exception: return 0
        return 0
    if ext in ('.m4a', '.mp4', '.m4b'):
        f = MP4(path)
        for key, val in (f.tags or {}).items():
            if str(key).startswith('----:com.apple.iTunes:') and str(key).split(':', 3)[-1].strip().upper() == 'P_COUNT':
                raw = val[0] if isinstance(val, list) and val else val
                text = raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else str(raw or '')
                try: return max(0, int(text.strip()))
                except Exception: return 0
        return 0
    f = File(path, easy=False)
    for key, val in (getattr(f, 'tags', None) or {}).items():
        if str(key).strip().upper() == 'P_COUNT':
            raw = val[0] if isinstance(val, list) and val else val
            try: return max(0, int(str(raw).strip()))
            except Exception: return 0
    return 0

def is_beehive_love_field_name(value):
    return str(value or '').strip().upper() in {'LOVE RATING','LOVE','LOVERATING','MUSICBEE/LOVE RATING','MUSICBEE/LOVERATING','MUSICBEE LOVE RATING'}

def read_love(path):
    ext=Path(path).suffix.lower()
    aliases={'LOVE RATING','LOVE','LOVERATING','MUSICBEE/LOVE RATING','MUSICBEE/LOVERATING','MUSICBEE LOVE RATING'}
    if ext in ('.mp3','.wav'):
        if ext=='.mp3':
            try: tag=ID3(path)
            except ID3NoHeaderError: return False
        else:
            from mutagen.wave import WAVE
            f=WAVE(path); tag=f.tags
        if not tag: return False
        for frame in tag.getall('TXXX'):
            if str(getattr(frame,'desc','')).strip().upper() in aliases and any(str(v).strip().upper()=='L' for v in getattr(frame,'text',[]) or []): return True
        return False
    if ext=='.flac':
        f=FLAC(path); return any(str(k).strip().upper() in aliases and any(str(v).strip().upper()=='L' for v in (f.tags.get(k) or [])) for k in (f.tags or {}).keys())
    if ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path)
        for key,val in (f.tags or {}).items():
            if str(key).startswith('----:com.apple.iTunes:') and str(key).split(':',3)[-1].strip().upper() in aliases:
                if any((bytes(v).decode('utf-8','replace') if isinstance(v,(bytes,bytearray)) else str(v)).strip().upper()=='L' for v in (val or [])): return True
        return False
    f=File(path,easy=False)
    for key,val in (getattr(f,'tags',None) or {}).items():
        if str(key).strip().upper() in aliases and any(str(v).strip().upper()=='L' for v in (val if isinstance(val,list) else [val])): return True
    return False

def write_love(path, loved):
    """Write Hive's canonical LOVE RATING using the bundled Mutagen backend."""
    loved=bool(loved)
    ext=Path(path).suffix.lower()
    if ext in ('.mp3','.wav'):
        if ext=='.mp3':
            try: tag=ID3(path)
            except ID3NoHeaderError: tag=ID3()
        else:
            from mutagen.wave import WAVE
            f=WAVE(path); tag=f.tags or f.add_tags() or f.tags
        for frame in list(tag.getall('TXXX')):
            if is_beehive_love_field_name(getattr(frame,'desc','')):
                try: tag.delall(frame.HashKey)
                except Exception: pass
        if loved: set_txxx(tag,'LOVE RATING','L')
        if ext=='.mp3': tag.save(path, v2_version=4, v1=0)
        else: f.save()
        return
    if ext=='.flac':
        f=FLAC(path)
        for key in list((f.tags or {}).keys()):
            if str(key).strip().upper() in ('LOVE RATING','LOVE','LOVERATING','MUSICBEE/LOVE RATING','MUSICBEE/LOVERATING','MUSICBEE LOVE RATING'):
                del f.tags[key]
        if loved: f['LOVE RATING']='L'
        f.save(); return
    if ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path)
        if f.tags is None: f.add_tags()
        _remove_freeform_mp4(f.tags, ('LOVE RATING','LOVE','LOVERATING','MUSICBEE/LOVE RATING','MUSICBEE/LOVERATING','MUSICBEE LOVE RATING'))
        if loved: _set_freeform_mp4(f.tags,'LOVE RATING','L')
        f.save(); return
    f=File(path, easy=False)
    if f is None: raise RuntimeError(f'Unsupported audio format: {ext}')
    if getattr(f,'tags',None) is None:
        try: f.add_tags()
        except Exception: pass
    if f.tags is None: raise RuntimeError(f'No writable metadata container for {ext}')
    aliases=('LOVE RATING','LOVE','LOVERATING','MUSICBEE/LOVE RATING','MUSICBEE/LOVERATING','MUSICBEE LOVE RATING')
    for key in list(f.tags.keys()):
        if str(key).strip().upper() in aliases: f.tags.pop(key,None)
    if loved: f.tags['LOVE RATING']='L'
    f.save()

def write_tags(path,tags):
    ext=Path(path).suffix.lower()
    if ext=='.mp3': write_mp3(path,tags)
    elif ext=='.flac': write_flac(path,tags)
    elif ext in ('.m4a','.mp4','.m4b'): write_mp4(path,tags)
    elif ext=='.wav':
        # See write_metadata's .wav branch: WAV's tags object is a real
        # ID3Tags instance and needs apply_id3_fields, not the generic
        # dict-of-strings fallback below.
        from mutagen.wave import WAVE
        f=WAVE(path)
        tag=f.tags or f.add_tags() or f.tags
        apply_id3_fields(tag, tags)
        f.save(v2_version=4)
    else:
        f=File(path, easy=False)
        if f is None: raise RuntimeError(f'Unsupported audio format: {ext}')
        # Native Vorbis/APE-style mappings where available.
        if getattr(f,'tags',None) is None:
            try:f.add_tags()
            except Exception: pass
        for k,v in tags.items():
            if k=='compilation':
                key='COMPILATION'
            else:
                key={'albumArtist':'ALBUMARTIST','year':'DATE','track':'TRACKNUMBER','disk':'DISCNUMBER'}.get(k,k.upper())
            if str(v)=='':
                try:f.tags.pop(key,None)
                except:pass
            else:f.tags[key]=str(v)
        f.save()

def main(req):
    op=req.get('op'); path=req.get('path')
    if not path or not os.path.exists(path): raise RuntimeError('Track file not found.')
    if op=='read_artwork': return {'pictures':read_artwork(path)}
    if op=='read_artwork_metadata': return {'pictures':read_artwork_metadata(path)}
    if op=='artwork_contains_hash': return {'match':artwork_contains_hash(path, req.get('sha256'))}
    if op=='artwork_fingerprint': return {'fingerprint': artwork_fingerprint(path)}
    if op=='protected_metadata_fingerprint': return {'fingerprint': protected_metadata_fingerprint(path)}
    if op=='read_compilation': return {'compilation': read_compilation(path)}
    if op=='read_metadata_fields': return {'fields': read_metadata_fields(path, req.get('fields') or [])}
    if op=='write_tags': write_tags(path,req.get('tags') or {}); return {'ok':True}
    if op=='write_rating': write_rating(path,req.get('rating',0)); return {'ok':True}
    if op=='write_love': write_love(path,req.get('loved',False)); return {'ok':True}
    if op=='read_love': return {'loved': bool(read_love(path))}
    if op=='write_pcount': write_pcount(path,req.get('count',0)); return {'ok':True}
    if op=='read_pcount': return {'count': read_pcount(path)}
    if op=='write_metadata': write_metadata(path,req.get('tags') or {},req.get('artwork')); return {'ok':True}
    if op=='modify_artwork': modify_artwork(path,req.get('operation') or {}); return {'ok':True,'pictures':read_artwork_metadata(path)}
    if op=='clear_artwork': clear_artwork(path); return {'ok':True,'pictures':read_artwork_metadata(path)}
    if op=='replace_front': replace_front(path,req.get('imagePath'),req.get('pictureType','Cover (Front)'),req.get('comment','')); return {'ok':True,'pictures':read_artwork_metadata(path)}
    if op=='remove_front': remove_front(path); return {'ok':True,'pictures':read_artwork_metadata(path)}
    raise RuntimeError(f'Unknown operation: {op}')

if __name__=='__main__':
    # Persistent request/reply mode. Beehive keeps this process alive so bulk
    # metadata operations do not repeatedly pay Python startup/import costs.
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req=json.loads(line)
            out=main(req)
            print(json.dumps({'id': req.get('id'), 'ok': True, 'result': out}, separators=(',',':')), flush=True)
        except Exception as e:
            print(json.dumps({'id': req.get('id') if 'req' in locals() else None, 'ok': False, 'error': str(e)}), flush=True)
