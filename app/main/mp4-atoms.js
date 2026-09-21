'use strict';

// Minimal MP4/M4A (ISO BMFF) atom reader/writer used to read and rewrite the
// iTunes-style freeform ('----') tags Hive uses for MusicBee Love sync.
// Pure Buffer functions — no Electron or main.js process state.

function mp4Atom(buffer, offset) {
  if (offset + 8 > buffer.length) return null;
  const size = buffer.readUInt32BE(offset), type = buffer.toString('latin1', offset + 4, offset + 8);
  if (size === 0) return {offset,size:buffer.length-offset,type,header:8,end:buffer.length};
  if (size === 1) { if(offset+16>buffer.length)return null; const n=Number(buffer.readBigUInt64BE(offset+8)); if(!Number.isSafeInteger(n)||n<16||offset+n>buffer.length)return null; return {offset,size:n,type,header:16,end:offset+n}; }
  if (size < 8 || offset + size > buffer.length) return null;
  return {offset,size,type,header:8,end:offset+size};
}
function mp4Children(buffer, atom) {
  let p=atom.offset+atom.header+(atom.type==='meta'?4:0), out=[];
  while(p+8<=atom.end){const a=mp4Atom(buffer,p);if(!a||a.end>atom.end)break;out.push(a);p=a.end;} return out;
}
function mp4FindPath(buffer, atom, types, i=0) { if(i>=types.length)return atom; for(const c of mp4Children(buffer,atom)) if(c.type===types[i]) {const f=mp4FindPath(buffer,c,types,i+1);if(f)return f;} return null; }
function mp4AtomWithPayload(type,payload){const b=Buffer.alloc(8+payload.length);b.writeUInt32BE(b.length,0);b.write(type,4,4,'latin1');payload.copy(b,8);return b;}
function mp4FullBoxAtom(type,payload){return mp4AtomWithPayload(type,Buffer.concat([Buffer.alloc(4),payload]));}
function makeMp4FreeformLoveAtom(loved){const mean=mp4FullBoxAtom('mean',Buffer.from('com.apple.iTunes'));const name=mp4FullBoxAtom('name',Buffer.from('LOVE RATING'));const data=mp4AtomWithPayload('data',Buffer.concat([Buffer.from([0,0,0,1]),Buffer.alloc(4),Buffer.from(loved?'L':'0')]));return mp4AtomWithPayload('----',Buffer.concat([mean,name,data]));}
function parseMp4FreeformName(buffer,atom){if(atom.type!=='----')return null;let mean='',name='';for(const c of mp4Children(buffer,atom)){if(c.type==='mean'||c.type==='name'){const start=c.offset+c.header+4;const text=buffer.subarray(start,c.end).toString('utf8').replace(/\0+$/g,'');if(c.type==='mean')mean=text;else name=text;}}return {mean,name};}
function assertMp4MetaStructure(buffer, meta){
  const prefix = buffer.subarray(meta.offset + meta.header, meta.offset + meta.header + 4);
  if (prefix.length !== 4) throw new Error('MP4/M4A meta atom is truncated.');
  const firstChild = mp4Atom(buffer, meta.offset + meta.header + 4);
  if (!firstChild || firstChild.type !== 'hdlr') throw new Error('MP4/M4A metadata container is invalid; refusing to modify the file.');
}
function rebuildMp4Parent(buffer,parent,oldChild,newChild){
  // `meta` is an ISO BMFF FullBox: its first four payload bytes are version/flags
  // and are NOT a child atom. Build 255 dropped those bytes while rebuilding
  // moov/udta/meta, which made every ilst entry look like a numeric key and
  // could discard/obscure unrelated metadata. Preserve the FullBox header and
  // rebuild only the actual child atom.
  const fullBoxPrefix = parent.type === 'meta' ? buffer.subarray(parent.offset + parent.header, parent.offset + parent.header + 4) : Buffer.alloc(0);
  if (parent.type === 'meta' && fullBoxPrefix.length !== 4) throw new Error('MP4/M4A meta atom is truncated.');
  const childBase = parent.offset + parent.header + fullBoxPrefix.length;
  const oldPayload = buffer.subarray(parent.offset + parent.header + fullBoxPrefix.length, parent.end);
  const rel = oldChild.offset - childBase;
  if (rel < 0 || rel + oldChild.size > oldPayload.length) throw new Error('MP4/M4A metadata child is outside its parent.');
  const before = oldPayload.subarray(0, rel), after = oldPayload.subarray(rel + oldChild.size);
  return mp4AtomWithPayload(parent.type, Buffer.concat([fullBoxPrefix, before, newChild, after]));
}

module.exports = {
  mp4Atom,
  mp4Children,
  mp4FindPath,
  mp4AtomWithPayload,
  mp4FullBoxAtom,
  makeMp4FreeformLoveAtom,
  parseMp4FreeformName,
  assertMp4MetaStructure,
  rebuildMp4Parent,
};
