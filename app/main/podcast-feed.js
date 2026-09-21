'use strict';

// Podcast RSS feed fetching + parsing. Pure/network-only — no Electron or
// main.js process state — so the parser is safe to unit test with fixture XML.

function podcastRequest(url) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(String(url)); } catch { reject(new Error('Invalid podcast URL.')); return; }
    if (!/^https?:$/.test(target.protocol)) { reject(new Error('Only HTTP(S) podcast feeds are supported.')); return; }
    const client = target.protocol === 'https:' ? require('https') : require('http');
    const req = client.get(target, { headers: { 'User-Agent': 'Hive/1.0 Podcast Reader' }, timeout: 12000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); podcastRequest(new URL(res.headers.location, target).toString()).then(resolve, reject); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Podcast request failed (${res.statusCode}).`)); return; }
      let body='';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 8*1024*1024) req.destroy(new Error('Podcast feed is too large.')); });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('Podcast request timed out.')));
    req.on('error', reject);
  });
}
function xmlDecode(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g, (_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_,n)=>String.fromCodePoint(parseInt(n,16))).trim();
}
function xmlTag(block, tag) {
  const safe=String(tag).replace(/[:]/g,'\\:');
  const re=new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, 'i');
  const m=String(block||'').match(re); return m ? xmlDecode(m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ')) : '';
}
function xmlAttr(block, tag, attr) {
  const re=new RegExp(`<${String(tag).replace(/[:]/g,'\\:')}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m=String(block||'').match(re); return m ? xmlDecode(m[1]) : '';
}
function parsePodcastFeed(xml, feedUrl) {
  const channel=(String(xml).match(/<channel\b[^>]*>([\s\S]*?)<\/channel>/i)||[])[1] || String(xml);
  const feedImage=xmlAttr(channel,'itunes:image','href') || ((channel.match(/<image\b[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/image>/i)||[])[1] ? xmlDecode((channel.match(/<image\b[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/image>/i)||[])[1]) : '');
  const items=[]; const itemRe=/<item\b[^>]*>([\s\S]*?)<\/item>/gi; let m;
  while ((m=itemRe.exec(String(channel))) && items.length<200) {
    const b=m[1];
    const enclosure=(b.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i)||[])[1] || '';
    if (!enclosure) continue;
    const guid=xmlTag(b,'guid') || enclosure;
    const title=xmlTag(b,'title') || 'Untitled episode';
    const author=xmlTag(b,'itunes:author') || xmlTag(b,'author') || xmlTag(channel,'itunes:author') || xmlTag(channel,'author');
    const description=xmlTag(b,'content:encoded') || xmlTag(b,'description');
    const image=xmlAttr(b,'itunes:image','href') || feedImage;
    const durationText=xmlTag(b,'itunes:duration');
    let duration=0; const parts=durationText.split(':').map(Number);
    if (parts.length===3 && parts.every(Number.isFinite)) duration=parts[0]*3600+parts[1]*60+parts[2];
    else if (parts.length===2 && parts.every(Number.isFinite)) duration=parts[0]*60+parts[1]; else if (/^\d+(?:\.\d+)?$/.test(durationText)) duration=Number(durationText);
    items.push({ id:guid, title, artist:author || xmlTag(channel,'title') || 'Podcast', description, pubDate:xmlTag(b,'pubDate'), duration, audioUrl:xmlDecode(enclosure), cover:image });
  }
  return { title:xmlTag(channel,'title') || 'Podcast', description:xmlTag(channel,'description'), author:xmlTag(channel,'itunes:author') || xmlTag(channel,'author'), image:feedImage, feedUrl, episodes:items };
}

module.exports = { podcastRequest, xmlDecode, xmlTag, xmlAttr, parsePodcastFeed };
