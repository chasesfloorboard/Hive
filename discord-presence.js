const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let nodeDataChannel = null;
try { nodeDataChannel = require('node-datachannel'); } catch (e) {
  console.warn('[Discord] node-datachannel unavailable; loon cover proxy disabled:', e?.message || e);
}

// Discord accepts HTTPS image URLs in Rich Presence. Embedded artwork is local,
// so Beehive uses the same general temporary-proxy architecture as Music Presence:
// a short-lived loon-compatible URL, with the image only transferred when Discord
// actually requests it. No permanent upload is made.
const COVER_PROXY_HOST = 'proxy.musicpresence.io';
const COVER_PROXY_PORT = 443;
const COVER_PROXY_BASE = 'https://proxy.musicpresence.io/v0';
const COVER_PROXY_WS_PATH = '/v0/ws';
const COVER_PROXY_WS_URL = `wss://${COVER_PROXY_HOST}${COVER_PROXY_WS_PATH}`;

function pbVarint(n) {
  let x = BigInt(n);
  const out=[];
  while (x >= 0x80n) { out.push(Number((x & 0x7fn) | 0x80n)); x >>= 7n; }
  out.push(Number(x));
  return Buffer.from(out);
}
function pbField(num, wire, value) {
  return Buffer.concat([pbVarint((BigInt(num)<<3n)|BigInt(wire)), value]);
}
function pbString(num, value) { const b=Buffer.from(String(value),'utf8'); return pbField(num,2,Buffer.concat([pbVarint(b.length),b])); }
function pbBytes(num, value) { const b=Buffer.from(value); return pbField(num,2,Buffer.concat([pbVarint(b.length),b])); }
function pbU64(num, value) { return pbField(num,0,pbVarint(value)); }
function pbMessage(num, value) { return pbField(num,2,Buffer.concat([pbVarint(value.length),value])); }
function pbClientEmpty(id) { return pbMessage(1,pbU64(1,id)); }
function pbClientClose(id) { return pbMessage(4,pbU64(1,id)); }
function pbClientHeader(id,mime,size) { return pbMessage(2,Buffer.concat([pbU64(1,id),pbString(2,mime),pbU64(3,size),pbU64(4,24)])); }
function pbClientChunk(id,seq,data) { return pbMessage(3,Buffer.concat([pbU64(1,id),pbU64(2,seq),pbBytes(3,data)])); }
function readVarint(buf, off) { let x=0n, shift=0n, i=off; for(;i<buf.length;i++){ const b=buf[i]; x |= BigInt(b&0x7f)<<shift; if(!(b&0x80)) return [x,i+1]; shift+=7n; if(shift>70n) throw new Error('invalid protobuf varint'); } throw new Error('truncated protobuf varint'); }
function readMessage(buf) {
  const fields=[]; let i=0;
  while(i<buf.length){ const [tag,n]=readVarint(buf,i); i=n; const num=Number(tag>>3n), wire=Number(tag&7n); let value;
    if(wire===0){ const [v,e]=readVarint(buf,i); value=v; i=e; }
    else if(wire===2){ const [len,e]=readVarint(buf,i); i=e; const end=i+Number(len); value=buf.subarray(i,end); i=end; }
    else if(wire===5){ value=buf.subarray(i,i+4); i+=4; }
    else if(wire===1){ value=buf.subarray(i,i+8); i+=8; }
    else throw new Error('unsupported protobuf wire type');
    fields.push({num,wire,value});
  }
  return fields;
}
function firstField(fields,num){ return fields.find(f=>f.num===num)?.value; }
function firstString(fields,num){ const v=firstField(fields,num); return v ? Buffer.from(v).toString('utf8') : ''; }
function firstU64(fields,num){ const v=firstField(fields,num); return v == null ? 0 : Number(v); }
function parseServerMessage(buf) {
  const top=readMessage(buf);
  const hello=firstField(top,1), request=firstField(top,2), requestClosed=firstField(top,4), closed=firstField(top,5);
  if(hello) { const f=readMessage(hello); const constraints=firstField(f,4); let c={chunkSize:32768,maxContentSize:4*1024*1024,accepted:['image/png'],cacheDuration:24}; if(constraints){const cf=readMessage(constraints); c.chunkSize=firstU64(cf,1)||c.chunkSize; c.maxContentSize=firstU64(cf,2)||c.maxContentSize; c.accepted=cf.filter(x=>x.num===3).map(x=>Buffer.from(x.value).toString('utf8')); c.cacheDuration=firstU64(cf,4)||c.cacheDuration;} return {type:'hello',baseUrl:firstString(f,1),clientId:firstString(f,2),secret:firstField(f,3)||Buffer.alloc(0),constraints:c}; }
  if(request) { const f=readMessage(request); return {type:'request',id:firstU64(f,1),path:firstString(f,3)}; }
  if(requestClosed) { const f=readMessage(requestClosed); return {type:'requestClosed',id:firstU64(f,1),message:firstString(f,2)}; }
  if(closed) { const f=readMessage(closed); return {type:'close',reason:firstU64(f,1),message:firstString(f,2)}; }
  return {type:'other'};
}
function maskFrame(payload, opcode=2) {
  const b=Buffer.from(payload), key=crypto.randomBytes(4), len=b.length;
  let head;
  if(len<126) head=Buffer.from([0x80|opcode,0x80|len]);
  else if(len<=0xffff){head=Buffer.alloc(4);head[0]=0x80|opcode;head[1]=0xfe;head.writeUInt16BE(len,2);}
  else {head=Buffer.alloc(10);head[0]=0x80|opcode;head[1]=0xff;head.writeBigUInt64BE(BigInt(len),2);}
  const out=Buffer.alloc(b.length); for(let i=0;i<b.length;i++) out[i]=b[i]^key[i%4]; return Buffer.concat([head,key,out]);
}

class TemporaryCoverProxy {
  constructor(){
    this.ws=null;
    this.connected=false;
    this.connecting=null;
    this.clientId='';
    this.secret=null;
    this.baseUrl=COVER_PROXY_BASE;
    this.resource=null;
    this.constraints={chunkSize:32768,maxContentSize:4*1024*1024,accepted:['image/png'],cacheDuration:24};
    this.awaiting={};
    this._failPending=(e)=>{for(const k of Object.keys(this.awaiting)){try{this.awaiting[k].reject(e);}catch{}}this.awaiting={};};
  }
  async ensure(){
    if(this.connected) return true;
    if(!nodeDataChannel?.WebSocket) return false;
    if(this.connecting) return this.connecting;
    this.connecting=this._connect().finally(()=>{this.connecting=null;});
    return this.connecting;
  }
  _connect(){
    return new Promise((resolve,reject)=>{
      let ws=null, opened=false, settled=false, helloReceived=false;
      const fail=(err)=>{
        if(settled) return;
        settled=true;
        const error=err instanceof Error ? err : new Error(String(err));
        this._failPending(error);
        try{ws?.close();}catch{}
        this.ws=null;
        this.connected=false;
        this.clientId='';
        this.secret=null;
        console.warn('[Discord] Loon cover proxy unavailable:', error.message);
        reject(error);
      };
      const succeed=()=>{
        if(settled) return;
        settled=true;
        this.ws=ws;
        this.connected=true;
        resolve(true);
      };
      try {
        // node-datachannel is the native libdatachannel WebSocket transport.
        // It replaces the hand-written TLS/RFC6455 transport while the loon
        // protobuf/HMAC/resource protocol remains implemented here.
        ws=new nodeDataChannel.WebSocket(COVER_PROXY_WS_URL);
        if(typeof ws.onOpen==='function') ws.onOpen(()=>{ opened=true; console.info('[Discord] Loon cover proxy WebSocket connected'); });
        if(typeof ws.onError==='function') ws.onError(err=>{ if(!opened || !helloReceived) fail(new Error(String(err||'cover proxy websocket error'))); else this.disconnect(); });
        if(typeof ws.onClosed==='function') ws.onClosed(()=>{ if(!opened || !helloReceived) fail(new Error('cover proxy websocket closed before loon Hello')); else this.disconnect(); });
        if(typeof ws.onMessage==='function') ws.onMessage(payload=>{
          try {
            const buf=Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
            const msg=parseServerMessage(buf);
            if(msg.type==='hello'){
              this.clientId=msg.clientId;
              this.secret=msg.secret;
              this.baseUrl=String(msg.baseUrl||COVER_PROXY_BASE).replace(/\/$/,'');
              this.constraints=msg.constraints||this.constraints;
              const base=new URL(this.baseUrl);
              if(base.protocol!=='https:' || base.hostname!==COVER_PROXY_HOST) throw new Error(`unexpected cover proxy base URL: ${this.baseUrl}`);
              if(!this.clientId || !this.secret?.length) throw new Error('loon Hello did not provide client credentials');
              helloReceived=true;
              succeed();
            } else if(msg.type==='request') this._respond(msg);
            else if(msg.type==='requestClosed') console.info('[Discord] Loon cover proxy request closed:',msg.id,msg.message||'');
            else if(msg.type==='close') fail(new Error(`cover proxy server closed: ${msg.message||'unknown error'}`));
          } catch(e){ fail(e); }
        });
        if(typeof ws.connect==='function') ws.connect();
      } catch(e){ fail(e); }
    });
  }
  _sendBinary(data){
    if(!this.ws || !this.connected) throw new Error('cover proxy websocket is not connected');
    if(typeof this.ws.sendMessageBinary==='function') return this.ws.sendMessageBinary(Buffer.from(data));
    if(typeof this.ws.sendMessage==='function') return this.ws.sendMessage(Buffer.from(data));
    throw new Error('loon WebSocket transport has no binary send method');
  }
  _respond(req){
    const r=this.resource;
    if(!r || r.path!==req.path){try{this._sendBinary(pbClientEmpty(req.id));}catch{};return;}
    const data=r.data;
    const max=Number(this.constraints?.maxContentSize||4*1024*1024);
    if(data.length>max){try{this._sendBinary(pbClientEmpty(req.id));}catch{};return;}
    try {
      this._sendBinary(pbClientHeader(req.id,r.mime||'image/jpeg',data.length));
      const size=Math.max(1,Number(this.constraints?.chunkSize||32768));
      let seq=0;
      for(let i=0;i<data.length;i+=size) this._sendBinary(pbClientChunk(req.id,seq++,data.subarray(i,i+size)));
    } catch(e) {
      try{this._sendBinary(pbClientClose(req.id));}catch{}
      console.warn('[Discord] Loon cover response failed:',e?.message||e);
    }
  }
  async register(data,mime='image/jpeg'){
    if(!data || !data.length) return '';
    if(!await this.ensure()) return '';
    const pathPart=`cover/${crypto.randomBytes(12).toString('hex')}.${mime.includes('png')?'png':'jpg'}`;
    this.resource={path:pathPart,data:Buffer.from(data),mime};
    const mac=crypto.createHmac('sha256',this.secret).update(`${this.clientId}/${pathPart}`).digest().toString('base64url');
    return `${this.baseUrl}/${this.clientId}/${mac}/${pathPart}`;
  }
  disconnect(){
    this.connected=false;
    this.clientId='';
    this.secret=null;
    this.baseUrl=COVER_PROXY_BASE;
    const ws=this.ws;
    this.ws=null;
    if(ws) try{ws.close();}catch{}
    this._failPending(new Error('cover proxy disconnected'));
  }
}

class DiscordRichPresence {
  constructor({ getConfigPath, appName = 'Hive', resolveArtwork = null, resolveArtworkFallback = null } = {}) {
    this.getConfigPath = getConfigPath; this.appName = appName; this.socket=null; this.socketPath=null; this.connected=false; this.connecting=null; this.clientId=''; this.lastActivityKey=''; this.resolveArtwork=typeof resolveArtwork==='function'?resolveArtwork:null; this.resolveArtworkFallback=typeof resolveArtworkFallback==='function'?resolveArtworkFallback:null; this.coverProxy=new TemporaryCoverProxy(); this.artworkCache=new Map(); this.artworkResolveRunning=new Map();
  }
  readConfig(){try{return JSON.parse(fs.readFileSync(this.getConfigPath(),'utf8'))||{};}catch{return {};}}
  writeConfig(config){fs.mkdirSync(path.dirname(this.getConfigPath()),{recursive:true});const tmp=`${this.getConfigPath()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(config,null,2),'utf8');fs.renameSync(tmp,this.getConfigPath());}
  getSettings(){const c=this.readConfig();const saved=c.discordRichPresence||{};return {enabled:(saved.enabled===true || !!String(saved.clientId||'').trim()),clientId:String(c.discordRichPresence?.clientId||''),largeImageKey:String(c.discordRichPresence?.largeImageKey||''),largeImageText:String(c.discordRichPresence?.largeImageText||'Hive'),showAlbum:c.discordRichPresence?.showAlbum!==false,showArtist:c.discordRichPresence?.showArtist!==false,showProgress:c.discordRichPresence?.showProgress!==false};}
  saveSettings(patch={}){const c=this.readConfig(),old=this.getSettings();c.discordRichPresence={enabled:patch.enabled==null?old.enabled:!!patch.enabled,clientId:patch.clientId==null?old.clientId:String(patch.clientId).trim(),largeImageKey:patch.largeImageKey==null?old.largeImageKey:String(patch.largeImageKey).trim(),largeImageText:patch.largeImageText==null?old.largeImageText:String(patch.largeImageText).trim()||'Hive',showAlbum:patch.showAlbum==null?old.showAlbum:!!patch.showAlbum,showArtist:patch.showArtist==null?old.showArtist:!!patch.showArtist,showProgress:patch.showProgress==null?old.showProgress:!!patch.showProgress};this.writeConfig(c);if(!c.discordRichPresence.enabled)this.clear();return this.getSettings();}
  status(){return {enabled:this.getSettings().enabled,connected:this.connected,coverProxyConnected:this.coverProxy.connected,socketPath:this.socketPath||'',configured:!!this.getSettings().clientId};}
  candidateSockets(){const dirs=[];for(const d of [process.env.XDG_RUNTIME_DIR,process.env.TMPDIR,process.env.TMP,process.env.TEMP,appTempDir(),path.join(os.homedir(),'.config','discord')])if(d&&!dirs.includes(d))dirs.push(d);const paths=[];for(const d of dirs)for(let i=0;i<10;i++)paths.push(path.join(d,`discord-ipc-${i}`));return paths;}
  async connect(){const settings=this.getSettings();if(!settings.enabled||!settings.clientId)return false;if(this.connected&&this.clientId===settings.clientId&&this.socket)return true;if(this.connecting)return this.connecting;this.clientId=settings.clientId;this.connecting=new Promise(resolve=>{const paths=this.candidateSockets();let index=0;const tryNext=()=>{if(index>=paths.length){this.connecting=null;resolve(false);return;}const socketPath=paths[index++],socket=net.createConnection(socketPath);let settled=false;const finish=ok=>{if(settled)return;settled=true;try{socket.removeAllListeners();}catch{}if(!ok){try{socket.destroy();}catch{}tryNext();}else{this.connecting=null;resolve(true);}};socket.setTimeout(900);socket.once('connect',()=>{this.socket=socket;this.socketPath=socketPath;this.connected=true;socket.setTimeout(0);socket.on('error',()=>this.disconnect());socket.on('close',()=>this.disconnect());this.sendPacket(0,{v:1,client_id:this.clientId}).then(ok=>finish(ok));});socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));};tryNext();});return this.connecting;}
  disconnect(){this.connected=false;this.lastActivityKey='';const s=this.socket;this.socket=null;this.socketPath=null;if(s)try{s.destroy();}catch{} }
  sendPacket(opcode,payload){if(!this.socket||!this.connected)return Promise.resolve(false);const body=Buffer.from(JSON.stringify(payload),'utf8'),packet=Buffer.alloc(8+body.length);packet.writeInt32LE(opcode,0);packet.writeInt32LE(body.length,4);body.copy(packet,8);return new Promise(resolve=>{try{this.socket.write(packet,()=>resolve(true));}catch{resolve(false);}});}
  async setActivity(activity){if(!await this.connect())return false;const ok=await this.sendPacket(1,{cmd:'SET_ACTIVITY',args:{pid:process.pid,activity},nonce:crypto.randomUUID()});if(!ok)this.disconnect();return ok;}
  async clear(){this.lastActivityKey='';this.coverProxy.disconnect();if(!this.connected)return true;const ok=await this.sendPacket(1,{cmd:'SET_ACTIVITY',args:{pid:process.pid,activity:null},nonce:crypto.randomUUID()});this.disconnect();return ok;}
  async update(track,position=0,paused=false){
    const settings=this.getSettings();
    if(!settings.enabled||!settings.clientId||!track?.title){await this.clear();return false;}
    const duration=Math.max(0,Number(track.duration)||0);
    const current=Math.max(0,Math.min(duration||Number.MAX_SAFE_INTEGER,Number(position)||0));
    const activity={
      type:2,
      name:'Hive',
      details:String(track.title||'Unknown title'),
      state:settings.showArtist?String(track.artist||'Unknown artist'):(settings.showAlbum?String(track.album||'Unknown album'):'Hive Music Library'),
      instance:false
    };
    if(settings.showAlbum&&settings.showArtist) activity.state=`${String(track.artist||'Unknown artist')} · ${String(track.album||'Unknown album')}`;
    // Beehive deliberately does NOT provide Discord artwork. Music Presence owns
    // cover handling and reads the local cover through Beehive's MPRIS interface.
    // In particular, never invoke MusicBrainz/Cover Art Archive artwork fallback here.
    if(settings.showProgress&&duration>0&&!paused){const start=Date.now()-Math.round(current*1000);activity.timestamps={start,end:start+Math.round(duration*1000)};}
    if(paused) activity.state+=' · Paused';
    const key=JSON.stringify({...activity,p:Math.floor(current),paused});
    if(key===this.lastActivityKey)return true;
    const ok=await this.setActivity(activity);
    if(ok)this.lastActivityKey=key;
    return ok;
  }
}
function appTempDir(){return process.env.XDG_RUNTIME_DIR||os.tmpdir();}
module.exports={DiscordRichPresence};
