# Tanzen Music Shuffler (Web)

Picks the next track at random from public Deezer or Spotify playlists and plays it in a deezer.com or open.spotify.com tab in your own browser. One service is used at a time (**Music service** in Settings); playlists of the two are never mixed.

## Why it works this way
Neither service's developer API is used.
- **Deezer**: the developer portal has not accepted new app registrations since 2024, so OAuth and the playback-control APIs are not available. The unauthenticated public API (`api.deezer.com/playlist/{id}`) still works, and track lists come from there. Playback is handled by a **userscript** in a deezer.com tab that calls the Deezer web player's internal `window.dzPlayer` object.
- **Spotify**: track lists are read from the public embed pages (`open.spotify.com/embed/playlist/{id}`), which need no login or app registration. Playback is handled by a userscript in an open.spotify.com tab (see [Spotify playback](#spotify-playback)).

```
[Docker: Node server] ◀──sync (~1s)──▶ [deezer.com or open.spotify.com tab + Tampermonkey userscript] ──▶ web player
        ▲  shuffle logic, state in /data         ◀── status reports / track-ended events
        └── SSE ── [control UI http://localhost:8787]
```

## Running
```bash
docker compose up -d --build        # default port 8787 (change with: HOST_PORT=9000 docker compose up -d)
```
Then open http://localhost:8787 in your browser.

## Getting started
1. In ⚙ Settings, choose the **Music service**: Deezer or Spotify.
2. Add a public playlist URL (or ID) of that service in the control UI. Only playlist links are accepted (also short share links that lead to a playlist); anything else shows a red error below the field.
3. Install [Tampermonkey](https://www.tampermonkey.net/). In Chrome, also turn on "Allow User Scripts" in the extension's details.
4. Install the script from the "Install userscript" link in the Settings' Connect tab (`deezer-shuffler.user.js` or `spotify-shuffler.user.js`). The server address is filled in automatically at install time. To change it later, use "Change Shuffler server address" in the Tampermonkey menu.
5. Open **exactly one** deezer.com or open.spotify.com tab, signed in, and click anywhere on the page once. This is required by the browser's autoplay policy.
6. When Tampermonkey asks to allow access to the server, choose "Always allow".
7. When the "Deezer tab" or "Spotify tab" badge in the header turns green, press ⏭ Next track.

If you switch the output to "30-second preview", you can listen in the control page itself without an account. This is meant for checking that everything works.

### Switching the music service
Each service keeps its own playlists, active selection, shares, Up next queue and song requests. Switching stops the current track and brings back the other service's set as you left it. The history and play time are shared.

## Dance hall display
**⧉ Dance Hall** in the Now Playing card opens a display-only window (`/display.html`) for projecting in the dance hall. It shows:
- the current track's large artwork, the dance (playlist name), title and artist
- a time bar with elapsed and remaining time. This is a simulated clock: it starts from 0:00 as soon as the player reports the track playing, then counts the known track length down once per second. It never re-syncs with the player's position mid-track, so it never jumps. It only reacts to events: it freezes on pause or ads, continues on resume, resets on the next track or stop, and shows the full length at the end. The real position is used once, when the page is opened mid-track. When a max play time is set, the timer ends when the track will actually stop
- the next 4 tracks in the queue, with artwork

When the track changes, the display switches like a carousel: the previous track slides out to the left while the new one slides in from the right, and the up-next cards slide in after it. With the system's "reduce motion" setting on, it switches without animation.

### Dance step footprints
Next to the timer, the display animates small footprints showing the basic rhythm of the dance. The dance is recognised from the playlist name (e.g. "Tanzen - Chacha"), or from the track title if the playlist name doesn't match. Footprints stamp in time with the play clock, so they stop when it stops. The tempo is the standard competition tempo, unless the track title names one (e.g. "Slow Waltz: 29BPM", read as bars per minute). Turn the footprints on or off with "Show dance step footprints on the display" in Settings.

| Dance | Steps (small = quick) |
|---|---|
| Langsamer Walzer / Slow Waltz | 1 2 3 (3/4 time) |
| Wiener Walzer | 1 2 3 |
| Cha Cha | 2 3, then small 4 & 1 (cha-cha-cha) |
| Rumba | 2 3 4-1 |
| Paso Doble | 1 2 |
| Samba | 1 a 2 |
| Tango | S S Q Q S |
| Slowfox | S Q Q |
| Quickstep | S Q Q S |
| Jive | 1 2, 3 a 4, 5 a 6 |
| Discofox | 1 2 tap |
| Salsa | 1 2 3, 5 6 7 |

Patterns and tempos are defined in `public/steps.js`.

The window opens sized to fill the screen. If a second screen (projector) is connected, Chrome can move it there; Chrome asks once for the "window management" permission. Browsers only allow fullscreen after a user action, so click the window once, or press **F** (double-click also toggles fullscreen). The page keeps the screen awake and hides the mouse cursor while it is idle. It only reads state and never controls playback, so you can open it on any device in the same network.

## Settings
Settings open in a modal from the ⚙ gear in the header, next to the connection badges. Close it with ✕ Close, Esc, or a click outside it. It has three tabs:
- **Settings**: choices on the left (music service, output, auto-play, footprints), numbers on the right (max play time, fade-out, gap).
- **Connect Deezer / Connect Spotify**: the connection badges again, and the userscript setup steps for the selected service.
- **History**: the last 500 played tracks in a compact table (time and date as `21:54:37 31/10/2026`, playlist or "Requested"/"Picked in Deezer"/"Picked in Spotify", track), with **Clear history**, the **total play time** and **today's play time**. Play time counts only while the player reports the current track playing (not ads or pauses). Clearing the history keeps both totals; today's play time starts again from 0 at local midnight. The time zone is set by `TZ` in `docker-compose.yml` (default `Europe/Berlin`).

| Setting | Description |
|---|---|
| Music service | Deezer or Spotify. See [Switching the music service](#switching-the-music-service) |
| Automatically play the next track | Picks the next track automatically when one ends |
| Max play time | 0 plays the whole track. For example, 90 fades out after 90 seconds and moves on to the next track |
| Fade-out / Gap between tracks | Fade length when a max play time is set, and the wait before the next track starts |

## Queue
The "Up next" panel, below Now Playing, holds the upcoming tracks. Ten tracks are queued automatically whenever the queue is empty, including at startup and after adding a playlist.

| Control | What it does |
|---|---|
| ⏭ Next track | Plays the track at the top of the queue. If the queue runs out, 10 more are drawn automatically |
| 🎲 Rolling Dice | Draws 10 new random tracks and adds them to the end of the queue |
| 🔄 Flip Board | Clears the queue, then runs Rolling Dice |
| Drag and drop, ↑ ↓ | Changes the order (priority) of queued tracks |
| ✕ | Removes a track from the queue |
| ➕ Adding Song | Opens a panel in the right half of Up next for collecting songs by song URL or ID (see below) |

### Adding songs by URL or ID
**➕ Adding Song** opens a panel next to Up next. Paste a song link of the selected service (`deezer.com/…/track/…`, `open.spotify.com/…/track/…`, `spotify:track:…`, or a short share link that leads to a song) or a song ID and press **Request**. Only songs are accepted; playlist, album or artist links are refused, as are songs that aren't playable. Requested songs collect in the panel's list. The list is kept on the server and doesn't change Up next. It stays across track changes, page reloads and other open control pages until you act on it:
- **Add them to #1** inserts the songs at the top of Up next, in list order, without interrupting the current track. The rest of the queue moves down; a song that was already queued moves up instead of appearing twice.
- **Add them to LAST** appends them to the end of Up next. The existing order doesn't change; a song that was already queued stays where it is.
- **Clear** empties the list. ✕ removes a single song.

Songs that aren't in any of your playlists show as "Requested" in Up next.

### Picking a song directly in Deezer or Spotify
If you pick a song yourself in the Deezer or Spotify tab, the userscript notices it and tells the server. The picked song becomes the current track, and the control page and the dance hall display show it ("Picked in Deezer" / "Picked in Spotify"). The queue stays as it is; if the picked song was waiting in the queue, it is removed so it won't play twice. When the picked song ends, playback continues from the top of the queue.

How a direct pick is told apart from the player switching songs by itself:
- A different song must play for 1.5 seconds.
- Ads are ignored.
- When the previous track was in its last 3 seconds, the switch counts as that track ending (e.g. autoplay). Changes in the 10 seconds after a track ends are not treated as picks.

### Playlist tracks
The ▾ button at the right end of each playlist row opens that playlist's tracks in the right half of the Playlists card (scrollable for long playlists). A search box above the list filters it by title as you type (ignoring case and accents); it is cleared after Add to Next Queue and whenever the panel closes. Tracks that are playing or already queued are marked. **Add to Next Queue** puts a track at the top of the queue, so it plays next. Picks made while the same track is playing line up in the order they were made (#1, #2, #3, …) and are tagged "Picked" in Up next; once the next track starts, the next pick goes to #1 again. A track that was already queued moves up instead of appearing twice. The panel then closes. Pressing ▴ or Esc also closes it.

### Playlist shares
Each active playlist has a 0–100% slider: its chance of supplying the next track. The next track is picked in two steps: first a playlist, by its share, regardless of how many tracks it has; then a random track inside that playlist.

- All active playlists always add up to 100%. Shares are whole numbers and never go below 0% or above 100%.
- Moving one slider changes the others equally to make up the difference. They update live while you drag, and the result is saved when you release. Once a playlist reaches 0%, the rest is taken from the others.
- A newly added (or newly checked) playlist gets the median of the existing shares, at most 50%, and takes that amount equally from the others. Unchecking or deleting a playlist gives its share back to the others equally.
- With only one active playlist, it is fixed at 100%. Unchecked playlists show "—".
- The same playlist (genre) never plays twice in a row, unless it is the only one with tracks left. Picking skips the previous playlist, and the pick weights are corrected for that, so over time each playlist still plays at its share. A share above 50% can't be reached this way, since there aren't enough other tracks to put between its own; it plays about 50% of the time, and the control page says so. As a safety net, a batch from Rolling Dice or Flip Board that still has two of the same genre in a row swaps the second one with the next track from a different genre.
- A small playlist with a high share repeats its tracks more often. Within a playlist, every track plays once before any repeats.

The share rules are in `public/shares.js`, used by both the server and the control page.

Each playlist has its own shuffle "bag": every track in it is drawn once before the bag is reshuffled. A track that is already queued or playing is never drawn again. Tracks removed by ✕ or Flip Board go back into the bag unplayed, so they can still come up later. The queue is saved in `/data` and survives restarts.

### Deezer's repeat setting
Each track is played in Deezer as a one-track list. With Deezer's repeat on (player bar or Queue tab), Deezer would start that same track again when it ends, so the userscript keeps repeat **off** while it controls playback (this changes the repeat setting in your Deezer account). If repeat can't be switched off, a track that jumps from its end back to the start still counts as ended, and the next track follows within a fraction of a second.

## Spotify playback
The Spotify web player has no public player object like Deezer's `dzPlayer`, so `spotify-shuffler.user.js` uses what the page itself offers:
- **Playing a track**: the tab moves to the track's page (`/track/{id}`), which Spotify starts by itself. If it doesn't start, the next try presses the page's play button.
- **Pause and resume**: the Media Session handlers Spotify registers (the same ones media keys use).
- **Position, length and fade-out**: the media element Spotify plays through. The userscript sets its volume directly for the fade and restores it afterwards; Spotify's volume slider doesn't move.
- **Which track is playing**: the player state in the player bar's React props (`state.item`).
- **End of a track**: when a track ends, Spotify's autoplay starts another one within milliseconds. The userscript therefore stops each track 0.4 seconds before its end.

The Spotify playlist embed has no artwork per track, so the server fills it in from each track's own embed page in the background after a playlist is added or reloaded. The Spotify tab also reports the artwork of what it plays.

## Limitations
- **Spotify, 100 tracks**: without signing in, Spotify shows at most the first 100 tracks of a playlist. Larger playlists are cut there, and the playlist row says "first 100 only".
- **Spotify Free accounts**: ads play between tracks. During an ad the badge shows "Spotify tab (ad playing)" and the userscript waits up to 90 seconds for the track. How ads look in the web player has not been checked yet; the userscript treats a non-track item or Spotify's ad markers as an ad. The `hooks.item` field in `/api/state` (`players.spotify.status`) shows what the player reports, which helps when checking this.
- **Spotify on one device**: playing on another device with the same account stops the web player.
- The Spotify userscript relies on Spotify's page internals (page structure, React props, `data-testid` attributes). It may need fixing when Spotify updates its web app.
- **Deezer Free accounts**: on the web you can usually pick individual tracks, but ads play. In some countries (such as the US) only 30-second previews are allowed. When that is the case, the UI badge shows "30s-limited account". If an ad delays the start of a track, the userscript keeps retrying for up to 90 seconds.
- `dzPlayer` is an internal Deezer object, not a public API. The userscript may need fixing when Deezer updates its web app. The methods confirmed so far are `play`, `getSongId`, `getPosition`, `getDuration`, `isPlaying`, `isLimited`, and `control.pause/play/setVolume`.
- Playlists must be public.

The userscript keeps exactly one request open at a time (`POST /api/player/sync`). The request carries the player status and events up, and its response carries the latest command down. The server answers at once when a command is waiting, otherwise after at most 1 second. An earlier version used a separate long-poll, and the browser then held the userscript's status requests back for 10+ seconds.

## Layout
- `src/server.js`: HTTP server, shuffling, player long-poll, SSE (no external dependencies)
- `src/deezer.js`: Deezer public API client
- `src/spotify.js`: Spotify embed page reader (playlists and tracks)
- `src/store.js`: saves state to `/data/state.json`
- `public/`: control UI, `deezer-shuffler.user.js` and `spotify-shuffler.user.js`
