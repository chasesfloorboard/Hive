const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { readWavMusicBeeTags: readSharedWavMusicBeeTags } = require('./wav-id3');

let mm;
let metadataLib;
const AUDIO_EXTS = new Set(['.mp3','.flac','.m4a','.m4b','.mp4','.aac','.wav','.aiff','.aif','.ogg','.oga','.opus','.wma','.asf','.ape','.wv','.mp2','.mpc','.dsf','.dff','.mka','.mkv','.webm','.spx']);

function readId3Size(buf) {
  if (buf.length < 10 || buf.toString('ascii',0,3) !== 'ID3') return 0;
  return ((buf[6]&0x7f)<<21)|((buf[7]&0x7f)<<14)|((buf[8]&0x7f)<<7)|(buf[9]&0x7f);
}
function musicBeePopmStars(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const map = {13:.5,1:1,54:1.5,64:2,118:2.5,128:3,186:3.5,196:4,242:4.5,255:5};
  if (map[n] !== undefined) return map[n];
  return Math.max(0, Math.min(5, Math.round((n/255)*10)/2));
}
function musicBeePopmByte(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? Math.round(n) : 0;
}
async function readMp3PopmRaw(filePath) {
  try {
    const fd = await fsp.open(filePath,'r');
    try {
      const head = Buffer.alloc(10);
      const {bytesRead} = await fd.read(head,0,10,0);
      if (bytesRead < 10 || head.toString('ascii',0,3) !== 'ID3') return 0;
      const major = head[3], flags = head[5], tagSize = readId3Size(head);
      if (tagSize <= 0 || tagSize > 64*1024*1024) return 0;
      const payload = Buffer.alloc(tagSize);
      await fd.read(payload,0,tagSize,10);
      let pos = 0;
      if (major >= 3 && (flags & 0x40) && payload.length >= 4) {
        const extSize = major >= 4
          ? ((payload[0]&0x7f)<<21)|((payload[1]&0x7f)<<14)|((payload[2]&0x7f)<<7)|(payload[3]&0x7f)
          : payload.readUInt32BE(0);
        pos = major >= 4 ? extSize : 4 + extSize;
        if (pos > payload.length) pos = 0;
      }
      let musicBee = 0, any = 0;
      while (pos < payload.length) {
        if (major === 2) {
          if (pos+6 > payload.length) break;
          const id = payload.toString('ascii',pos,pos+3);
          const size = (payload[pos+3]<<16)|(payload[pos+4]<<8)|payload[pos+5];
          if (!/^[A-Z0-9]{3}$/.test(id) || size <= 0 || pos+6+size > payload.length) break;
          if (id === 'POP') {
            const frame = payload.subarray(pos+6,pos+6+size), nul = frame.indexOf(0);
            if (nul >= 0 && nul+1 < frame.length) {
              const email = frame.subarray(0,nul).toString('latin1').trim().toLowerCase();
              const raw = musicBeePopmByte(frame[nul+1]);
              any = Math.max(any,raw); if (email === 'musicbee') musicBee = Math.max(musicBee,raw);
            }
          }
          pos += 6+size;
        } else {
          if (pos+10 > payload.length) break;
          const id = payload.toString('ascii',pos,pos+4), b = payload.subarray(pos+4,pos+8);
          const size = major >= 4 ? ((b[0]&0x7f)<<21)|((b[1]&0x7f)<<14)|((b[2]&0x7f)<<7)|(b[3]&0x7f) : b.readUInt32BE(0);
          if (/^\x00{4}$/.test(id)) {
            let next = pos;
            while (next < payload.length && payload[next] === 0) next++;
            if (next + 10 <= payload.length) {
              const nextId = payload.toString('ascii', next, next + 4);
              const nb = payload.subarray(next + 4, next + 8);
              const nextSize = major >= 4
                ? ((nb[0]&0x7f)<<21)|((nb[1]&0x7f)<<14)|((nb[2]&0x7f)<<7)|(nb[3]&0x7f)
                : nb.readUInt32BE(0);
              if (/^[A-Z0-9]{4}$/.test(nextId) && nextSize > 0 && next + 10 + nextSize <= payload.length) {
                pos = next;
                continue;
              }
            }
            break;
          }
          if (!/^[A-Z0-9]{4}$/.test(id) || size < 0 || pos+10+size > payload.length) break;
          if (id === 'POPM') {
            const frame = payload.subarray(pos+10,pos+10+size), nul = frame.indexOf(0);
            if (nul >= 0 && nul+1 < frame.length) {
              const email = frame.subarray(0,nul).toString('latin1').trim().toLowerCase();
              const raw = musicBeePopmByte(frame[nul+1]);
              any = Math.max(any,raw); if (email === 'musicbee') musicBee = Math.max(musicBee,raw);
            }
          }
          pos += 10+size;
        }
      }
      return musicBee || any || 0;
    } finally { await fd.close(); }
  } catch { return 0; }
}


function decodeId3TextBytes(bytes, encoding) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!input.length) return '';
  if (encoding === 0) return input.toString('latin1');
  if (encoding === 3) return input.toString('utf8');
  if (encoding === 1) {
    if (input.length >= 2 && input[0] === 0xFE && input[1] === 0xFF) {
      const body = Buffer.from(input.subarray(2));
      for (let i=0; i+1<body.length; i+=2) { const a=body[i]; body[i]=body[i+1]; body[i+1]=a; }
      return body.toString('utf16le');
    }
    return input.toString('utf16le');
  }
  if (encoding === 2) {
    const body = Buffer.from(input);
    for (let i=0; i+1<body.length; i+=2) { const a=body[i]; body[i]=body[i+1]; body[i+1]=a; }
    return body.toString('utf16le');
  }
  return '';
}

function splitId3TextField(body, encoding) {
  const input = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (encoding === 0 || encoding === 3) {
    const nul = input.indexOf(0);
    return [input.subarray(0, nul >= 0 ? nul : input.length), input.subarray(nul >= 0 ? nul + 1 : input.length)];
  }
  if (encoding === 1 || encoding === 2) {
    let nul = -1;
    for (let i=0; i+1<input.length; i+=2) {
      if (input[i] === 0 && input[i+1] === 0) { nul=i; break; }
    }
    return [input.subarray(0, nul >= 0 ? nul : input.length), input.subarray(nul >= 0 ? nul + 2 : input.length)];
  }
  return [Buffer.alloc(0), Buffer.alloc(0)];
}

async function readId3Love(filePath) {
  try {
    const input = await fsp.readFile(filePath);
    if (input.length < 10 || input.toString('ascii',0,3) !== 'ID3') return false;
    const major = input[3] >= 4 ? 4 : 3, size = readId3Size(input);
    const payload = input.subarray(10, Math.min(input.length, 10 + size));
    let pos = 0, loved = false;
    while (pos + 10 <= payload.length) {
      const id = payload.toString('ascii',pos,pos+4);
      if (/^\x00{4}$/.test(id)) {
        let next = pos; while (next < payload.length && payload[next] === 0) next++;
        if (next + 10 <= payload.length && /^[A-Z0-9]{4}$/.test(payload.toString('ascii',next,next+4))) { pos = next; continue; }
        break;
      }
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const b = payload.subarray(pos+4,pos+8);
      const size2 = major >= 4 ? ((b[0]&0x7f)<<21)|((b[1]&0x7f)<<14)|((b[2]&0x7f)<<7)|(b[3]&0x7f) : b.readUInt32BE(0);
      if (size2 <= 0 || pos+10+size2 > payload.length) break;
      if (id === 'TXXX') {
        const frame = payload.subarray(pos+10,pos+10+size2);
        const encoding = frame[0];
        if (encoding === 0 || encoding === 1 || encoding === 2 || encoding === 3) {
          const [descBytes, valueBytes] = splitId3TextField(frame.subarray(1), encoding);
          const desc = decodeId3TextBytes(descBytes, encoding).replace(/^\uFEFF/, '').trim().toUpperCase();
          if (isBeehiveLoveFieldName(desc)) {
            const value = decodeId3TextBytes(valueBytes, encoding).replace(/^\uFEFF/, '').trim().toUpperCase();
            if (isFavoriteLoveValue(value)) loved = true;
          }
        }
      }
      pos += 10 + size2;
    }
    return loved;
  } catch {}
  return false;
}
async function readWavMusicBeeTags(filePath) {
  try {
    const fd = await fsp.open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const hr = await fd.read(header, 0, 12, 0);
      if (hr.bytesRead < 12 || header.toString('ascii',0,4) !== 'RIFF' || header.toString('ascii',8,12) !== 'WAVE') return {rating:0,loved:false};
      const stat = await fd.stat();
      let pos = 12, rating = 0, loved = false;
      while (pos + 8 <= stat.size) {
        const ch = Buffer.alloc(8); const r = await fd.read(ch,0,8,pos);
        if (r.bytesRead < 8) break;
        const id = ch.toString('ascii',0,4), size = ch.readUInt32LE(4);
        const start = pos + 8, end = start + size;
        if (end > stat.size || end < start) break;
        if ((id === 'id3 ' || id === 'ID3 ') && size >= 10 && size <= 32 * 1024 * 1024) {
          const tag = Buffer.alloc(size); await fd.read(tag,0,size,start);
          if (tag.toString('ascii',0,3) === 'ID3') {
            const major = tag[3] >= 4 ? 4 : 3, tagSize = readId3Size(tag);
            const payload = tag.subarray(10, Math.min(tag.length,10+tagSize));
            let p=0;
            while (p+10 <= payload.length) {
              const fid=payload.toString('ascii',p,p+4);
              if (/^\x00{4}$/.test(fid)) {
                let next=p; while(next<payload.length&&payload[next]===0)next++;
                if(next+10<=payload.length && /^[A-Z0-9]{4}$/.test(payload.toString('ascii',next,next+4))) { p=next; continue; }
                break;
              }
              if (!/^[A-Z0-9]{4}$/.test(fid)) break;
              const b=payload.subarray(p+4,p+8);
              const fs=major>=4?((b[0]&0x7f)<<21)|((b[1]&0x7f)<<14)|((b[2]&0x7f)<<7)|(b[3]&0x7f):b.readUInt32BE(0);
              if(fs<=0||p+10+fs>payload.length) break;
              const frame=payload.subarray(p+10,p+10+fs);
              if(fid==='POPM'){
                const nul=frame.indexOf(0);
                if(nul>=0&&nul+1<frame.length&&frame.subarray(0,nul).toString('latin1').trim().toLowerCase()==='musicbee') rating=Math.max(rating,musicBeePopmStars(musicBeePopmByte(frame[nul+1])));
              }
              if(fid==='TXXX'){
                const encoding=frame[0];
                if(encoding===0||encoding===1||encoding===2||encoding===3){
                  const [descBytes,valueBytes]=splitId3TextField(frame.subarray(1),encoding);
                  const desc=decodeId3TextBytes(descBytes,encoding).replace(/^\uFEFF/,'').trim().toUpperCase();
                  if(isBeehiveLoveFieldName(desc)){
                    const v=decodeId3TextBytes(valueBytes,encoding).replace(/^\uFEFF/,'').trim().toUpperCase();
                    if(isFavoriteLoveValue(v)) loved=true;
                  }
                }
              }
              p+=10+fs;
            }
          }
        }
        pos=end+(size&1);
      }
      return {rating,loved};
    } finally { await fd.close(); }
  } catch {}
  return {rating:0,loved:false};
}

async function extractAndCacheCovers(pictures, coversDir) {
  if (!pictures || !pictures.length) return [];
  const seen = new Set(), out = [];
  for (const picture of pictures) {
    if (!picture || !picture.data || !Buffer.isBuffer(picture.data)) continue;
    const ext = String(picture.format || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const hash = crypto.createHash('sha1').update(picture.data).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);
    const fileName = `${hash}.${ext}`;
    const target = path.join(coversDir,fileName);
    try { await fsp.access(target); }
    catch { await fsp.mkdir(coversDir,{recursive:true}); await fsp.writeFile(target,picture.data); }
    out.push({file:fileName,type:picture.type || null,hash});
  }
  const rank = t => String(t||'').toLowerCase().includes('front') ? 0 : String(t||'').toLowerCase().includes('back') ? 1 : 2;
  out.sort((a,b)=>rank(a.type)-rank(b.type));
  return out;
}

function isFavoriteLoveValue(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'L' || v === 'Y' || v === 'YES' || v === 'TRUE' ||
    v === '1' || v === 'LOVE' || v === 'LOVED' ||
    v === 'FAVORITE' || v === 'FAVOURITE';
}

function isBeehiveLoveFieldName(value) {
  const v = String(value ?? '').trim().toUpperCase();
  return v === 'LOVE RATING' || v === 'LOVE' || v === 'LOVERATING' ||
    v === 'MUSICBEE/LOVE RATING' || v === 'MUSICBEE/LOVERATING';
}

function mp4Atom(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const size = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  if (size === 0) return { offset, size: buffer.length - offset, type, header: 8, end: buffer.length };
  if (size === 1) {
    if (offset + 16 > buffer.length) return null;
    const n = Number(buffer.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(n) || n < 16 || offset + n > buffer.length) return null;
    return { offset, size: n, type, header: 16, end: offset + n };
  }
  if (size < 8 || offset + size > buffer.length) return null;
  return { offset, size, type, header: 8, end: offset + size };
}

function mp4Children(buffer, atom) {
  let p = atom.offset + atom.header + (atom.type === 'meta' ? 4 : 0);
  const out = [];
  while (p + 8 <= atom.end) {
    const child = mp4Atom(buffer, p);
    if (!child || child.end > atom.end) break;
    out.push(child);
    p = child.end;
  }
  return out;
}

function mp4FindPath(buffer, atom, types, index = 0) {
  if (index >= types.length) return atom;
  for (const child of mp4Children(buffer, atom)) {
    if (child.type !== types[index]) continue;
    const found = mp4FindPath(buffer, child, types, index + 1);
    if (found) return found;
  }
  return null;
}

function mp4FreeformName(buffer, atom) {
  if (atom.type !== '----') return null;
  let mean = '', name = '';
  for (const child of mp4Children(buffer, atom)) {
    if (child.type !== 'mean' && child.type !== 'name') continue;
    const start = child.offset + child.header + 4;
    const text = buffer.subarray(start, child.end).toString('utf8').replace(/\0+$/g, '');
    if (child.type === 'mean') mean = text;
    else name = text;
  }
  return { mean, name };
}

function readMp4LoveFromBuffer(input) {
  let p = 0;
  const top = [];
  while (p + 8 <= input.length) {
    const atom = mp4Atom(input, p);
    if (!atom) break;
    top.push(atom);
    p = atom.end;
  }
  const moov = top.find(a => a.type === 'moov');
  const ilst = moov && mp4FindPath(input, moov, ['udta', 'meta', 'ilst']);
  if (!ilst) return false;
  for (const child of mp4Children(input, ilst)) {
    const ff = mp4FreeformName(input, child);
    if (!ff || ff.mean.toLowerCase() !== 'com.apple.itunes' || !isBeehiveLoveFieldName(ff.name)) continue;
    const data = mp4Children(input, child).find(a => a.type === 'data');
    if (!data || data.offset + data.header + 8 > data.end) continue;
    const value = input.subarray(data.offset + data.header + 8, data.end).toString('utf8').trim().toUpperCase();
    if (isFavoriteLoveValue(value)) return true;
  }
  return false;
}

async function readMp4Love(filePath) {
  try {
    return readMp4LoveFromBuffer(await fsp.readFile(filePath));
  } catch {}
  return false;
}

function normalizeRating(raw, scale255=false, scaleNormalized=false) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'object') return normalizeRating(raw.rating ?? raw.text ?? raw.value, scale255, scaleNormalized);
  const text = String(raw).trim().toLowerCase();
  const frac = text.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  if (frac) return Math.max(0,Math.min(5,Math.round(Number(frac[1])*2)/2));
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Math.max(0,Math.min(5,Math.round(Number(pct[1])/10)/2));
  const n = Number(text.replace(/[^0-9.+-]/g,''));
  if (!Number.isFinite(n)) return 0;
  if (scale255) return musicBeePopmStars(n);
  if (scaleNormalized) return Math.max(0, Math.min(5, Math.round(n * 10) / 2));
  if (n > 0 && n < 1) return Math.max(0,Math.min(5,Math.round(n*10)/2));
  if (n <= 5) return Math.round(n*2)/2;
  if (n <= 100) return Math.max(0,Math.min(5,Math.round(n/10)/2));
  return musicBeePopmStars(n);
}

function scalarTagValue(tag) {
  const value = tag?.value;
  if (value === undefined || value === null) return null;
  let raw = tag?.value?.text ?? tag?.value?.value;
  if (raw === undefined || raw === null) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') raw = value;
    else return null;
  }
  if (typeof raw === 'object') return null;
  const s = String(raw);
  if (s.length > 65536) return null;
  return s;
}


function id3TextFrameValue(data) {
  if (!data || !data.length) return '';
  const encoding = data[0];
  const body = data.subarray(1);
  if (encoding === 0 || encoding === 3) {
    const nul = body.indexOf(0);
    return body.subarray(0, nul >= 0 ? nul : body.length).toString(encoding === 3 ? 'utf8' : 'latin1').trim();
  }
  if (encoding === 1 || encoding === 2) {
    let end = body.length;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) { end = i; break; }
    }
    try { return body.subarray(0, end).toString('utf16le').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
  }
  return '';
}

function nativeTagKey(item) {
  const id = String(item?.id ?? item?.key ?? item?.name ?? '').trim();
  if (!id) return '';
  const desc = String(item?.value?.description ?? '').trim();
  // TXXX fields are semantically identified by their description. Preserve the
  // native frame prefix so two unrelated frame types cannot collide.
  if (id.toUpperCase() === 'TXXX' && desc) return `TXXX:${desc}`;
  return id;
}

function collectNativeTags(native) {
  const out = {};
  for (const nativeItems of Object.values(native || {})) {
    for (const item of (Array.isArray(nativeItems) ? nativeItems : [])) {
      const key = nativeTagKey(item);
      if (!key) continue;
      const raw = item?.value;
      const values = Array.isArray(raw) ? raw.flat(Infinity) : [raw];
      const clean = values.map(v => {
        if (v === undefined || v === null) return null;
        if (Buffer.isBuffer(v)) return `<Buffer ${v.length} bytes>`;
        if (typeof v === 'object') {
          const text = v?.text ?? v?.value;
          if (text !== undefined && text !== null && typeof text !== 'object') return String(text);
          try { return JSON.stringify(v); } catch { return String(v); }
        }
        return String(v);
      }).filter(v => v !== null && v !== '');
      if (!clean.length) continue;
      if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = clean.length === 1 ? clean[0] : clean;
      else {
        const prior = Array.isArray(out[key]) ? out[key] : [out[key]];
        out[key] = [...prior, ...clean];
      }
    }
  }
  return out;
}

function parseWavId3Tag(tag, coversDir) {
  const result = {
    common: {}, native: {}, rating: 0, loved: false, covers: [],
    customTags: {}, lyrics: null
  };
  if (!Buffer.isBuffer(tag) || tag.length < 10 || tag.toString('ascii', 0, 3) !== 'ID3') return result;
  const version = tag[3] >= 4 ? 4 : 3;
  const tagSize = readId3Size(tag);
  const payload = tag.subarray(10, Math.min(tag.length, 10 + tagSize));
  let pos = 0;
  const pictures = [];
  while (pos + 10 <= payload.length) {
    const id = payload.toString('ascii', pos, pos + 4);
    if (/^\x00{4}$/.test(id)) break;
    const size = version >= 4
      ? ((payload[pos+4]&0x7f)<<21)|((payload[pos+5]&0x7f)<<14)|((payload[pos+6]&0x7f)<<7)|(payload[pos+7]&0x7f)
      : payload.readUInt32BE(pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id) || size <= 0 || pos + 10 + size > payload.length) break;
    const frame = payload.subarray(pos + 10, pos + 10 + size);
    if (id === 'TIT2') result.common.title = id3TextFrameValue(frame);
    else if (id === 'TPE1') result.common.artist = id3TextFrameValue(frame);
    else if (id === 'TPE2') result.common.albumartist = id3TextFrameValue(frame);
    else if (id === 'TALB') result.common.album = id3TextFrameValue(frame);
    else if (id === 'TDRC' || id === 'TYER') {
      const value = id3TextFrameValue(frame); const m = String(value).match(/\b(\d{4})\b/);
      if (m) result.common.year = Number(m[1]);
    } else if (id === 'TCON') result.common.genre = id3TextFrameValue(frame);
    else if (id === 'TCOM') result.common.composer = id3TextFrameValue(frame);
    else if (id === 'TPUB') result.common.publisher = id3TextFrameValue(frame);
    else if (id === 'TRCK') {
      const value = id3TextFrameValue(frame).split('/'); result.common.track = {no:Number(value[0]) || null, of:Number(value[1]) || null};
    } else if (id === 'TPOS') {
      const value = id3TextFrameValue(frame).split('/'); result.common.disk = {no:Number(value[0]) || null, of:Number(value[1]) || null};
    } else if (id === 'TXXX') {
      const encoding = frame[0]; const body = frame.subarray(1);
      let nul = -1;
      if (encoding === 0 || encoding === 3) nul = body.indexOf(0);
      else if (encoding === 1 || encoding === 2) {
        for (let i = 0; i + 1 < body.length; i += 2) if (body[i] === 0 && body[i+1] === 0) { nul = i; break; }
      }
      const desc = body.subarray(0, nul >= 0 ? nul : body.length).toString(encoding === 3 ? 'utf8' : encoding === 1 || encoding === 2 ? 'utf16le' : 'latin1').replace(/^\uFEFF/, '').trim();
      const valueStart = nul >= 0 ? (encoding === 1 || encoding === 2 ? nul + 2 : nul + 1) : 0;
      const value = body.subarray(valueStart).toString(encoding === 3 ? 'utf8' : encoding === 1 || encoding === 2 ? 'utf16le' : 'latin1').replace(/^\uFEFF/, '').trim();
      if (desc) result.customTags[desc.toUpperCase()] = value;
      if (isBeehiveLoveFieldName(desc) && isFavoriteLoveValue(value)) result.loved = true;
      if (desc.toUpperCase() === 'FMPS_RATING') result.rating = normalizeRating(value, false, true);
    } else if (id === 'POPM') {
      const nul = frame.indexOf(0);
      if (nul >= 0 && nul + 1 < frame.length) {
        const email = frame.subarray(0, nul).toString('latin1').trim().toLowerCase();
        if (email === 'musicbee') result.rating = musicBeePopmStars(musicBeePopmByte(frame[nul+1]));
      }
    } else if (id === 'USLT') {
      // Keep lyrics extraction intentionally conservative; WAV scanning should not decode audio.
      const text = frame.length > 4 ? frame.subarray(frame.lastIndexOf(0) + 1).toString('utf8').trim() : '';
      if (text) result.lyrics = text.slice(0, 262144);
    } else if (id === 'APIC') {
      let p = 1;
      const mimeEnd = frame.indexOf(0, p); if (mimeEnd < 0) { pos += 10 + size; continue; }
      const mime = frame.subarray(p, mimeEnd).toString('latin1') || 'image/jpeg';
      p = mimeEnd + 1 + 1;
      if (p > frame.length) { pos += 10 + size; continue; }
      const enc = frame[0];
      if (enc === 0 || enc === 3) { const descEnd = frame.indexOf(0, p); p = descEnd >= 0 ? descEnd + 1 : frame.length; }
      else if (enc === 1 || enc === 2) { let descEnd = -1; for (let i=p;i+1<frame.length;i+=2) if(frame[i]===0&&frame[i+1]===0){descEnd=i;break;} p=descEnd>=0?descEnd+2:frame.length; }
      if (p < frame.length) pictures.push({data:frame.subarray(p), format:mime});
    }
    pos += 10 + size;
  }
  return { ...result, pictures };
}

async function parseWavTrack(filePath, coversDir) {
  const fd = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12); const hr = await fd.read(header, 0, 12, 0);
    if (hr.bytesRead < 12 || header.toString('ascii',0,4) !== 'RIFF' || header.toString('ascii',8,12) !== 'WAVE') throw new Error('Invalid WAV');
    let pos = 12, fmt = null, dataSize = 0, id3Result = null;
    const stat = await fd.stat();
    while (pos + 8 <= stat.size) {
      const chunkHeader = Buffer.alloc(8); const r = await fd.read(chunkHeader, 0, 8, pos);
      if (r.bytesRead < 8) break;
      const id = chunkHeader.toString('ascii',0,4); const size = chunkHeader.readUInt32LE(4);
      const start = pos + 8; const next = start + size + (size & 1);
      if (next > stat.size || next < start) break;
      if (id === 'fmt ') {
        const n = Math.min(size, 40); const b = Buffer.alloc(n); await fd.read(b,0,n,start);
        if (n >= 16) fmt = {audioFormat:b.readUInt16LE(0), channels:b.readUInt16LE(2), sampleRate:b.readUInt32LE(4), byteRate:b.readUInt32LE(8), bits:b.readUInt16LE(14)};
      } else if (id === 'data' && !dataSize) {
        dataSize = size;
      } else if ((id === 'id3 ' || id === 'ID3 ') && size > 0 && size <= 32 * 1024 * 1024) {
        const b = Buffer.alloc(size); await fd.read(b,0,size,start); id3Result = parseWavId3Tag(b,coversDir);
      }
      pos = next;
    }
    id3Result = id3Result || {common:{},customTags:{},rating:0,loved:false,pictures:[],lyrics:null};
    let covers = [];
    try { covers = await extractAndCacheCovers(id3Result.pictures, coversDir); } catch { covers = []; }
    const common = id3Result.common || {};
    const duration = fmt?.byteRate && dataSize ? dataSize / fmt.byteRate : 0;
    const codec = fmt?.audioFormat === 1 ? 'PCM' : (fmt?.audioFormat ? `WAV ${fmt.audioFormat}` : 'WAV');
    return {
      id:crypto.createHash('md5').update(filePath).digest('hex'), path:filePath,
      title:common.title || path.basename(filePath,path.extname(filePath)), artist:common.artist || common.albumartist || 'Unknown Artist', album:common.album || 'Unknown Album',
      albumArtist:common.albumartist || common.artist || 'Unknown Artist', year:common.year || null, genre:common.genre || null, composer:common.composer || null,
      publisher:common.publisher || null, conductor:null, comment:null, grouping:null, copyright:null, originalArtist:null, originalAlbum:null, originalYear:null,
      language:null, mood:null, occasion:null, keywords:null, quality:null, tempo:null, isrc:null, barcode:null,
      track:common.track?.no || null, trackCount:common.track?.of || null, disk:common.disk?.no || null, discCount:common.disk?.of || null,
      duration, sampleRate:fmt?.sampleRate || null, bitrate:fmt?.byteRate ? fmt.byteRate * 8 : null, channels:fmt?.channels || null, codec,
      cover:covers.length ? covers[0].file : null, covers, loved:!!id3Result.loved, lyrics:id3Result.lyrics || null,
      rating:Number(id3Result.rating)||0, ratingRaw:Number(id3Result.rating)||0, ratingHydrated:true, startTime:'', endTime:'', customTags:id3Result.customTags || {}, nativeTags:Object.fromEntries(Object.entries(id3Result.customTags || {}).map(([k,v]) => [`TXXX:${k}`, v]))
    };
  } finally { await fd.close(); }
}

async function parseTrack(filePath, coversDir) {
  if (!mm) { mm = await import('music-metadata'); metadataLib = mm; }
  const parse = (options, timeoutMs) => new Promise(async (resolve,reject) => {
    let timer = setTimeout(()=>reject(new Error(`metadata parse timeout after ${timeoutMs}ms`)),timeoutMs);
    try { resolve(await metadataLib.parseFile(filePath,options)); }
    catch (e) { reject(e); }
    finally { clearTimeout(timer); }
  });

  let meta;
  try { meta = await parse({duration:true,skipCovers:false},15000); }
  catch {
    meta = await parse({duration:true,skipCovers:true},8000);
  }
  const common = meta.common || {}, format = meta.format || {}, native = meta.native || {};
  let covers = [];
  try { covers = await extractAndCacheCovers(common.picture,coversDir); } catch { covers = []; }

  let loved = false, rating = 0, ratingRaw = 0;
  // Beehive rating authority: only the exact fields Beehive writes are
  // allowed to determine the displayed rating. Never infer a rating from
  // provider/container metadata such as WM/PROVIDERRATING, common.rating,
  // generic RATING fields, or another application's POPM frame.
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') {
    const raw = await readMp3PopmRaw(filePath);
    ratingRaw = raw;
    rating = musicBeePopmStars(raw);
    loved = await readId3Love(filePath);
  } else if (ext === '.wav') {
    // music-metadata supplies the broad native/common inventory for WAV; keep
    // the direct ID3 reader authoritative for MusicBee Love/rating compatibility.
    const wavTags = await readSharedWavMusicBeeTags(filePath);
    rating = wavTags.rating;
    loved = wavTags.loved;
  } else if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') {
    // MusicBee/iTunes stores Love in an iTunes freeform atom named LOVERATING.
    // Do not depend on music-metadata's version-specific native-tag object shape;
    // read the atom directly so a valid embedded Love tag cannot be flattened or
    // renamed into an unrecognized field during a full library rescan.
    loved = await readMp4Love(filePath);
    for (const tagList of Object.values(native)) {
      for (const tag of (Array.isArray(tagList) ? tagList : [])) {
        const id = String(tag?.id||'').trim().toUpperCase();
        const desc = String(tag?.value?.description||'').trim().toUpperCase();
        const idTail = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1).trim() : id;
        if (isBeehiveLoveFieldName(desc) || isBeehiveLoveFieldName(idTail)) {
          const rawValue = tag?.value?.text ?? tag?.value?.value ?? tag?.value;
          const values = Array.isArray(rawValue) ? rawValue : [rawValue];
          if (values.some(value => isFavoriteLoveValue(value))) loved = true;
        }
        // For non-MP3 formats Beehive writes Strawberry-compatible FMPS only.
        if (id === 'FMPS_RATING' || desc === 'FMPS_RATING' || id === 'FMPS/RATING' || desc === 'FMPS/RATING') {
          const raw = tag?.value?.text ?? tag?.value?.value ?? tag?.value;
          rating = Math.max(rating, normalizeRating(raw, false, true));
        }
      }
    }
  }
  // Do not use music-metadata's synthesized common.rating as an authority.
  // A rescan must reflect actual embedded rating tags; synthesized values can
  // turn unrelated container metadata into a false 1-star rating (notably M4A).
  const readCustomText = wanted => {
    const target = String(wanted).toUpperCase();
    for (const tagList of Object.values(native)) for (const tag of (Array.isArray(tagList)?tagList:[])) {
      const id=String(tag?.id||'').toUpperCase(), desc=String(tag?.value?.description||'').toUpperCase();
      if (id===target || desc===target || id.includes(target) || desc.includes(target)) {
        const raw=tag?.value?.text ?? tag?.value?.value ?? tag?.value;
        if (raw!==undefined && raw!==null && typeof raw!=='object' && String(raw).trim()) return String(raw).trim().slice(0,65536);
      }
    }
    return '';
  };
  const startTime=readCustomText('START_TIME'), endTime=readCustomText('END_TIME');
  const customTags={};
  for (const tagList of Object.values(native)) for (const tag of (Array.isArray(tagList)?tagList:[])) {
    const id=String(tag?.id||'').toUpperCase(), desc=String(tag?.value?.description||'').trim(), val=scalarTagValue(tag);
    if (!id || val===null) continue;
    customTags[id]=val; if (desc) customTags[desc.toUpperCase()]=val;
  }
  // nativeTags is the lossless-ish native metadata inventory used by Hive's
  // library layer. Keep customTags backward-compatible for existing smart
  // playlists/UI, while preserving every native field name (including TXXX
  // descriptions and multi-valued fields) for future tag-editor use.
  const nativeTags = collectNativeTags(native);
  let lyrics = (common.lyrics && common.lyrics[0] && (common.lyrics[0].text || common.lyrics[0])) || null;
  if (lyrics !== null && lyrics !== undefined) { lyrics=String(lyrics); if (lyrics.length>262144) lyrics=lyrics.slice(0,262144); }

  return {
    id:crypto.createHash('md5').update(filePath).digest('hex'), path:filePath,
    title:common.title || path.basename(filePath,path.extname(filePath)),
    artist:common.artist || common.albumartist || 'Unknown Artist', album:common.album || 'Unknown Album',
    albumArtist:common.albumartist || common.artist || 'Unknown Artist', year:common.year || null,
    genre:(common.genre&&common.genre[0])||null, composer:(common.composer&&common.composer[0])||null,
    publisher:common.label || common.publisher || null, conductor:common.conductor || null,
    comment:(common.comment&&common.comment[0])||null, grouping:common.grouping||null, copyright:common.copyright||null,
    originalArtist:common.originalartist||null, originalAlbum:common.originalalbum||null, originalYear:common.originalyear||null,
    language:common.language||null, mood:common.mood||null, occasion:common.occasion||null, keywords:common.keywords||null,
    quality:common.quality||null, tempo:common.tempo||null, isrc:common.isrc||null, barcode:common.barcode||null,
    track:(common.track&&common.track.no)||null, trackCount:(common.track&&common.track.of)||null,
    disk:(common.disk&&common.disk.no)||null, discCount:(common.disk&&common.disk.of)||null,
    duration:format.duration||0, sampleRate:format.sampleRate||null, bitrate:format.bitrate||null, bitDepth:format.bitsPerSample||null,
    channels:format.numberOfChannels||null, codec:format.codec || path.extname(filePath).replace('.','').toUpperCase(),
    cover:covers.length?covers[0].file:null, covers, loved, lyrics, rating, ratingRaw, ratingHydrated:true, startTime,endTime,customTags,nativeTags
  };
}

process.on('message', async msg => {
  if (!msg || msg.type !== 'scan') return;
  try {
    const track = await parseTrack(msg.filePath,msg.coversDir);
    process.send?.({type:'result',id:msg.id,track});
  } catch (err) {
    process.send?.({type:'error',id:msg.id,error:String(err?.message || err)});
  }
});
process.on('uncaughtException', err => { process.send?.({type:'fatal',error:String(err?.stack||err)}); process.exit(1); });
process.on('unhandledRejection', err => { process.send?.({type:'fatal',error:String(err?.stack||err)}); process.exit(1); });
