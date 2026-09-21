#!/usr/bin/env python3
import sys, json, sqlite3, os, time

DB_PATH = sys.argv[1]
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
conn = sqlite3.connect(DB_PATH, timeout=30)
conn.execute('PRAGMA journal_mode=WAL')
conn.execute('PRAGMA synchronous=NORMAL')
conn.execute('PRAGMA foreign_keys=ON')
conn.executescript('''
CREATE TABLE IF NOT EXISTS tracks (
  path TEXT PRIMARY KEY,
  artist TEXT,
  album TEXT,
  title TEXT,
  album_artist TEXT,
  mtime_ms REAL,
  size INTEGER,
  loved INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album);
CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(album_artist);
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
CREATE TABLE IF NOT EXISTS metadata_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  job_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_metadata_jobs_status ON metadata_jobs(status);
''')
# Backward-compatible migration for databases created before the durable Love column.
columns = {row[1] for row in conn.execute('PRAGMA table_info(tracks)').fetchall()}
if 'loved' not in columns:
    conn.execute('ALTER TABLE tracks ADD COLUMN loved INTEGER NOT NULL DEFAULT 0')
    rows = conn.execute('SELECT path,payload FROM tracks').fetchall()
    with conn:
        for path_value, payload in rows:
            try:
                loved = 1 if bool(json.loads(payload).get('loved')) else 0
            except Exception:
                loved = 0
            if loved:
                conn.execute('UPDATE tracks SET loved=1 WHERE path=?', (path_value,))
conn.commit()

def reply(req, result=None, error=None):
    out={'id':req.get('id')}
    if error: out.update(ok=False,error=str(error))
    else: out.update(ok=True,result=result)
    sys.stdout.write(json.dumps(out,separators=(',',':'))+'\n'); sys.stdout.flush()

for line in sys.stdin:
    try:
        req=json.loads(line)
        cmd=req.get('cmd')
        if cmd=='get_library':
            rows=conn.execute('SELECT payload,loved FROM tracks ORDER BY rowid').fetchall()
            tracks=[]
            for payload,loved in rows:
                track=json.loads(payload)
                track['loved']=bool(loved)
                track['loveHydrated']=True
                tracks.append(track)
            reply(req, {'tracks':tracks,'scannedAt':int(time.time()*1000) if tracks else 0})
        elif cmd=='clear_library':
            with conn:
                conn.execute('DELETE FROM tracks')
            reply(req, {'count': 0})
        elif cmd=='replace_library':
            tracks=req.get('tracks') or []
            now=int(time.time()*1000)
            with conn:
                conn.execute('DELETE FROM tracks')
                conn.executemany('''INSERT INTO tracks(path,artist,album,title,album_artist,mtime_ms,size,loved,payload,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)''', [
                    (str(t.get('path','')),str(t.get('artist','') or ''),str(t.get('album','') or ''),str(t.get('title','') or ''),str(t.get('albumArtist','') or ''),float(t.get('fileMtimeMs') or 0),int(t.get('fileSize') or 0),1 if t.get('loved') else 0,json.dumps(t,separators=(',',':')),now) for t in tracks if t.get('path')
                ])
            reply(req, {'count':len(tracks)})
        elif cmd=='search_tracks':
            text=str(req.get('text') or '').strip()
            limit=max(1,min(5000,int(req.get('limit') or 1000)))
            if not text: rows=[]
            else:
                like='%'+text.replace('%','\\%').replace('_','\\_')+'%'
                rows=conn.execute('''SELECT payload FROM tracks WHERE artist LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR album_artist LIKE ? ESCAPE '\\' ORDER BY artist,album,title LIMIT ?''',(like,like,like,like,limit)).fetchall()
            reply(req, [json.loads(r[0]) for r in rows])
        elif cmd=='upsert_tracks':
            tracks=req.get('tracks') or []
            now=int(time.time()*1000)
            with conn:
                conn.executemany('''INSERT INTO tracks(path,artist,album,title,album_artist,mtime_ms,size,loved,payload,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(path) DO UPDATE SET artist=excluded.artist,album=excluded.album,title=excluded.title,album_artist=excluded.album_artist,mtime_ms=excluded.mtime_ms,size=excluded.size,loved=excluded.loved,payload=excluded.payload,updated_at=excluded.updated_at''', [
                    (str(t.get('path','')),str(t.get('artist','') or ''),str(t.get('album','') or ''),str(t.get('title','') or ''),str(t.get('albumArtist','') or ''),float(t.get('fileMtimeMs') or 0),int(t.get('fileSize') or 0),1 if t.get('loved') else 0,json.dumps(t,separators=(',',':')),now) for t in tracks if t.get('path')
                ])
            reply(req, {'count':len(tracks)})
        elif cmd=='get_loved_paths':
            rows=conn.execute('SELECT path FROM tracks WHERE loved=1 ORDER BY rowid').fetchall()
            reply(req, [str(row[0]) for row in rows])
        elif cmd=='set_loved':
            values=req.get('values') or {}
            updated=0
            with conn:
                for track_path,loved in values.items():
                    key=str(track_path or '')
                    if not key: continue
                    row=conn.execute('SELECT payload FROM tracks WHERE path=?',(key,)).fetchone()
                    if not row: continue
                    try:
                        payload=json.loads(row[0])
                    except Exception:
                        payload={}
                    payload['loved']=bool(loved)
                    payload['loveHydrated']=True
                    conn.execute('UPDATE tracks SET loved=?,payload=?,updated_at=? WHERE path=?',(1 if loved else 0,json.dumps(payload,separators=(',',':')),int(time.time()*1000),key))
                    updated += 1
            reply(req, {'count':updated})
        elif cmd=='remove_tracks':
            paths=[str(p) for p in req.get('paths') or []]
            with conn: conn.executemany('DELETE FROM tracks WHERE path=?',[(p,) for p in paths])
            reply(req, {'count':len(paths)})
        elif cmd=='upsert_job':
            j=req.get('job') or {}; jid=str(j.get('id') or '')
            if not jid: raise ValueError('job id required')
            now=int(time.time()*1000)
            with conn:
                conn.execute('''INSERT INTO metadata_jobs(id,status,job_json,attempts,created_at,updated_at,last_error) VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET status=excluded.status,job_json=excluded.job_json,attempts=excluded.attempts,updated_at=excluded.updated_at,last_error=excluded.last_error''',
                    (jid,str(j.get('status','queued')),json.dumps(j.get('job') or {},separators=(',',':')),int(j.get('attempts',0)),int(j.get('createdAt',now)),now,str(j.get('lastError',''))))
            reply(req, {'id':jid})
        elif cmd=='update_job':
            jid=str(req.get('job_id') or ''); status=str(req.get('status') or 'queued'); attempts=int(req.get('attempts',0)); err=str(req.get('error',''))
            now=int(time.time()*1000)
            with conn:
                conn.execute('UPDATE metadata_jobs SET status=?,attempts=?,updated_at=?,last_error=? WHERE id=?',(status,attempts,now,err,jid))
            reply(req, True)
        elif cmd=='delete_job':
            jid=str(req.get('job_id') or '')
            with conn: conn.execute('DELETE FROM metadata_jobs WHERE id=?',(jid,))
            reply(req, True)
        elif cmd=='health_check':
            integrity=conn.execute('PRAGMA integrity_check').fetchone()[0]
            schema_rows=conn.execute("SELECT name,type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name").fetchall()
            jobs=conn.execute("SELECT status,COUNT(*) FROM metadata_jobs GROUP BY status ORDER BY status").fetchall()
            track_count=conn.execute('SELECT COUNT(*) FROM tracks').fetchone()[0]
            reply(req, {'integrity': integrity, 'healthy': integrity == 'ok', 'trackCount': track_count, 'jobCounts': {str(k): int(v) for k,v in jobs}, 'schemaObjects': [{'name':str(k),'type':str(v)} for k,v in schema_rows]})
        elif cmd=='recover_jobs':
            rows=conn.execute("SELECT id,status,job_json,attempts,created_at,updated_at,last_error FROM metadata_jobs WHERE status IN ('queued','running','retry') ORDER BY created_at").fetchall()
            jobs=[]
            now=int(time.time()*1000)
            with conn:
                for jid,status,jjson,attempts,created,updated,err in rows:
                    conn.execute("UPDATE metadata_jobs SET status='queued',updated_at=? WHERE id=?",(now,jid))
                    jobs.append({'id':jid,'status':'queued','job':json.loads(jjson),'attempts':attempts,'createdAt':created,'updatedAt':updated,'lastError':err})
            reply(req,jobs)
        else:
            raise ValueError('unknown command '+str(cmd))
    except Exception as e:
        try: reply(req,error=e)
        except Exception: pass
