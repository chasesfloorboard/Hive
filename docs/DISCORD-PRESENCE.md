# Discord presence: the approved look (2026-11-05)

With Settings › Discord › activity type **Listening**, Discord's profile pop-up shows
a **"Listening to Hive"** card. This is the look the owner approved; keep it.

```
Listening to Hive                         ...
+--------+  <Song title>            (bold)
| cover  |  <Artist>
|  art   |  <Album>
+--------+  00:08 ---o------------- 02:50
```

How each part is made (`app/main/discord-presence.js`, `_apply`):

| Card part | Activity field |
|---|---|
| "Listening to Hive" | `type: 2` (Listening) and the Hive Discord application's name |
| Cover art | `assets.large_image`: a public URL (stream/podcast art) or local art via the loon relay |
| Title (bold) | `details` |
| Artist | `state` (`status_display_type: 1` keeps the artist as the status line) |
| Album | `assets.large_text` |
| Progress bar and times | `timestamps.start` (now − position) and `timestamps.end` (start + duration) |
| Shown in the pop-up, not only the full profile | `instance: false` |

Rules that keep it working:
- Resend only on a track change or pause/resume; Discord moves the bar itself.
- When paused, `state` becomes "<Artist> — Paused" and the timestamps are dropped.
- Don't set `instance: true`: Discord then treats Hive as a joinable game and hides the card from the pop-up.
- Locked by `test/discord-presence.test.js` ("Listening" shows the approved card).
