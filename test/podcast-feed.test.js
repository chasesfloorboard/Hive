'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Podcast feed requests (app/main/podcast-feed.js).

test('a podcast feed fetched before is asked for with its ETag and a 304 reuses the copy', async () => {
  const http = require('http');
  const seen = [];
  const srv = http.createServer((q, r) => {
    seen.push(q.headers['if-none-match'] || '');
    if (q.headers['if-none-match'] === '"v1"') { r.writeHead(304); return r.end(); }
    r.writeHead(200, { ETag: '"v1"' }); r.end('<rss><channel><title>Feed</title></channel></rss>');
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/feed.xml`;
    const { podcastRequest } = require('../app/main/podcast-feed');
    const first = await podcastRequest(url);
    const second = await podcastRequest(url);
    assert.equal(second, first);
    assert.deepEqual(seen, ['', '"v1"']);
  } finally { srv.close(); }
});
