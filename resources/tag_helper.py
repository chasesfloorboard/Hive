#!/usr/bin/env python3
import base64, json, mimetypes, os, shutil, sys, tempfile
from pathlib import Path

# The bundled mutagen package is kept beside this helper so Beehive does not
# require a system Python package installation.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from mutagen import File
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TALB, TPE2, TCON, TYER, TDRC, TRCK, TPOS, COMM, TCOM, TIT1, TCOP, TPUB, TPE3, TBPM, USLT, TCMP, TXXX, APIC, POPM, SYLT, ID3TimeStamp, TSOA, TSOT, TSO2, TSOP, TSOC
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
    'albumArtist': ('TPE2', TPE2), 'genre': ('TCON', TCON), 'year': ('TYER', TYER),
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

def read_artwork(path):
    ext = Path(path).suffix.lower()
    pics=[]
    if ext == '.flac':
        f=FLAC(path)
        for i,p in enumerate(f.pictures):
            pics.append(picture_json(bytes(p.data), p.type, p.mime, p.desc, i, p.width, p.height))
    elif ext == '.mp3':
        try: tag=ID3(path)
        except ID3NoHeaderError: tag=None
        if tag:
            for i,p in enumerate(tag.getall('APIC')):
                pics.append(picture_json(bytes(p.data), p.type, p.mime, p.desc, i))
    elif ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path); covers=(f.tags or {}).get('covr',[]) if f.tags else []
        for i,p in enumerate(covers):
            data=bytes(p)
            mime='image/png' if getattr(p,'imageformat',None) == MP4Cover.FORMAT_PNG else 'image/jpeg'
            pics.append(picture_json(data, 'Cover (Front)' if i == 0 else 'Other', mime, '', i))
    else:
        f=File(path)
        if f and getattr(f,'pictures',None):
            for i,p in enumerate(f.pictures):
                pics.append(picture_json(bytes(p.data), getattr(p,'type',0), getattr(p,'mime','image/jpeg'), getattr(p,'desc',''), i))
    # Some FLAC/MP3 files created by older tools contain a single primary
    # picture with the generic type 0 (Other). Treat the first picture as the
    # main Album Cover for Beehive's editor when no explicit front-cover type
    # exists. This is a read-side normalization only; saving it through the
    # Tags-tab cover action writes the proper native front-cover type.
    if pics and not any(p.get('type') == 'Cover (Front)' for p in pics):
        pics[0]['type'] = 'Cover (Front)'
    return pics

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
    for frame in list(tag.getall('COMM')):
        if (frame.desc or '') == '' and (frame.lang or '').lower() in ('eng','und',''):
            try: tag.delall(frame.HashKey)
            except Exception: pass
    if str(value) != '': tag.add(COMM(encoding=3, lang='eng', desc='', text=[str(value)]))

def set_uslt(tag, value):
    for frame in list(tag.getall('USLT')):
        if (frame.desc or '') == '' and (frame.lang or '').lower() in ('eng','und',''):
            try: tag.delall(frame.HashKey)
            except Exception: pass
    if str(value) != '': tag.add(USLT(encoding=3, lang='eng', desc='', text=str(value)))

def write_mp3(path, tags):
    try: id3=ID3(path)
    except ID3NoHeaderError: id3=ID3()
    for key,(fid,cls) in STANDARD_MP3.items():
        if key not in tags: continue
        value=tags[key]
        if key == 'comment': set_comm(id3,value)
        elif key == 'year': set_text_frame(id3,'TYER',TYER,value)
        else: set_text_frame(id3,fid,cls,value)
    if 'lyrics' in tags: set_uslt(id3,tags['lyrics'])
    if 'compilation' in tags:
        id3.delall('TCMP')
        if str(tags['compilation']) == '1': id3.add(TCMP(encoding=3, text=['1']))
        # Remove only the legacy alias Beehive used to create; leave unrelated TXXX data intact.
        remove_txxx(id3,'compilation')
    native_sort = {'TSOA': TSOA, 'TSOT': TSOT, 'TSO2': TSO2, 'TSOP': TSOP, 'TSOC': TSOC}
    for k,v in tags.items():
        if k in STANDARD_MP3 or k in ('lyrics','compilation'): continue
        if k in native_sort:
            set_text_frame(id3, k, native_sort[k], v)
            continue
        if k == 'p_count' or k.startswith('custom') or k.startswith('BEEHIVE_') or k in ('NO_LYRICS','LYRICS_SYNC','START_TIME','END_TIME'):
            set_txxx(id3,k,v)
        elif len(k) == 4 and k.isupper():
            # Advanced editor frame IDs. Use known frame classes where possible;
            # otherwise retain/write a TXXX rather than corrupting an ID3 frame.
            set_txxx(id3,k,v)
    id3.save(path, v2_version=3, v1=0)

def write_flac(path, tags):
    f=FLAC(path)
    for key,field in STANDARD_FLAC.items():
        if key in tags:
            val=tags[key]
            if val is None or str(val)=='':
                if f.tags and field in f.tags: del f.tags[field]
            else: f[field]=str(val)
    if 'compilation' in tags:
        if str(tags['compilation']) == '1': f['COMPILATION']='1'
        else:
            if f.tags and 'COMPILATION' in f.tags: del f.tags['COMPILATION']
    flac_special = {'TSOA':'ALBUMSORT','TSOT':'TITLESORT','TSO2':'ALBUMARTISTSORT','TSOP':'ARTISTSORT','TSOC':'COMPOSERSORT'}
    for k,v in tags.items():
        if k in STANDARD_FLAC or k=='compilation': continue
        field = flac_special.get(k, str(k).upper())
        if str(v)=='':
            if f.tags and field in f.tags: del f.tags[field]
        else: f[field]=str(v)
    f.save()

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

def write_mp4(path,tags):
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
        atom=f'----:com.apple.iTunes:{k}'
        if str(v)=='': f.tags.pop(atom,None)
        else: f.tags[atom]=[str(v).encode('utf-8')]
    f.save()

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
        id3.delall('APIC'); id3.save(v2_version=3, v1=0); return
    if ext in ('.m4a','.mp4','.m4b'):
        f = MP4(path)
        if f.tags is not None: f.tags.pop('covr', None); f.save()
        return
    raise RuntimeError(f'Native artwork editing is not implemented for {ext or "this format"}.')

def modify_artwork(path, op):
    ext=Path(path).suffix.lower(); action=str(op.get('action','')).lower(); index=int(op.get('index',-1))
    image=op.get('imagePath'); ptype=norm_type(op.get('pictureType','Cover (Front)')); desc=str(op.get('comment','') or '')
    if ext=='.flac':
        f=FLAC(path); old=list(f.pictures)
        if action=='add': old.append(make_flac_picture(image,ptype,desc))
        elif action in ('replace','update'):
            if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
            if action=='replace': old[index]=make_flac_picture(image,ptype,desc)
            else:
                old[index].type=type_id(ptype); old[index].desc=desc
        elif action=='delete':
            if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
            del old[index]
        else: raise RuntimeError('Unknown artwork action.')
        f.clear_pictures()
        for p in old: f.add_picture(p)
        f.save(); return
    if ext=='.mp3':
        try:id3=ID3(path)
        except ID3NoHeaderError:id3=ID3()
        old=list(id3.getall('APIC'))
        if action=='add':
            # ADD must never use the replacement path. In particular, a blank
            # comment is common for album art, so make the APIC description
            # unique without changing what Beehive displays to the user.
            id3.add(make_apic(image,ptype,desc,id3))
            id3.save(v2_version=3, v1=0); return
        elif action in ('replace','update'):
            if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
            if action=='replace':
                existing_desc = visible_apic_desc(old[index].desc)
                replacement = make_apic(image,ptype,existing_desc)
                # Preserve this picture's existing storage key where possible.
                replacement.desc = old[index].desc
                old[index]=replacement
            else:
                old[index].type=type_id(ptype); old[index].desc=old[index].desc if old[index].desc else unique_apic_desc(id3, desc)
        elif action=='delete':
            if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
            del old[index]
        else: raise RuntimeError('Unknown artwork action.')
        id3.delall('APIC')
        for p in old: id3.add(p)
        id3.save(v2_version=3, v1=0); return
    if ext in ('.m4a','.mp4','.m4b'):
        f=MP4(path); tags=f.tags or {}; old=list(tags.get('covr',[]))
        if action=='add': old.append(MP4Cover(Path(image).read_bytes(), imageformat=MP4Cover.FORMAT_PNG if Path(image).suffix.lower()=='.png' else MP4Cover.FORMAT_JPEG))
        elif action=='replace':
            if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
            old[index]=MP4Cover(Path(image).read_bytes(), imageformat=MP4Cover.FORMAT_PNG if Path(image).suffix.lower()=='.png' else MP4Cover.FORMAT_JPEG)
        elif action=='delete':
            if not (0<=index<len(old)): raise RuntimeError('Artwork item no longer exists.')
            del old[index]
        elif action=='update':
            # MP4 covr has no standard per-picture type/comment fields; keep image unchanged.
            pass
        else: raise RuntimeError('Unknown artwork action.')
        if f.tags is None:f.add_tags()
        f.tags['covr']=old
        f.save(); return
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


def read_compilation(path):
    ext = Path(path).suffix.lower()
    if ext == '.mp3':
        try: tag = ID3(path)
        except ID3NoHeaderError: return '0'
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
        return '1' if bool(value and value[0]) else '0'
    try:
        f = File(path, easy=False)
        if f and getattr(f, 'tags', None):
            for key in ('COMPILATION','compilation'):
                value = f.tags.get(key)
                if value is not None and str(first(value)).strip() == '1': return '1'
    except Exception:
        pass
    return '0'

def write_tags(path,tags):
    ext=Path(path).suffix.lower()
    if ext=='.mp3': write_mp3(path,tags)
    elif ext=='.flac': write_flac(path,tags)
    elif ext in ('.m4a','.mp4','.m4b'): write_mp4(path,tags)
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
    if op=='protected_metadata_fingerprint': return {'fingerprint': protected_metadata_fingerprint(path)}
    if op=='read_compilation': return {'compilation': read_compilation(path)}
    if op=='write_tags': write_tags(path,req.get('tags') or {}); return {'ok':True}
    if op=='modify_artwork': modify_artwork(path,req.get('operation') or {}); return {'ok':True,'pictures':read_artwork(path)}
    if op=='clear_artwork': clear_artwork(path); return {'ok':True,'pictures':read_artwork(path)}
    if op=='replace_front': replace_front(path,req.get('imagePath'),req.get('pictureType','Cover (Front)'),req.get('comment','')); return {'ok':True,'pictures':read_artwork(path)}
    if op=='remove_front': remove_front(path); return {'ok':True,'pictures':read_artwork(path)}
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
