# Tanzen Music Shuffler (Web)

Picks the next track at random from public Deezer playlists and plays it in a deezer.com tab in your own browser.

## Why it works this way
- The Deezer developer portal has not accepted new app registrations since 2024, so OAuth and the playback-control APIs are not available.
- The unauthenticated public API (`api.deezer.com/playlist/{id}`) still works. Track lists come from there.
- Playback is handled by a **userscript** installed in a deezer.com tab. It calls the Deezer web player's internal `window.dzPlayer` object directly.

```
[Docker: Node server] ◀──sync (~1s)──▶ [deezer.com tab + Tampermonkey userscript] ──▶ dzPlayer.play()
        ▲  shuffle logic, state in /data         ◀── status reports / track-ended events
        └── SSE ── [control UI http://localhost:8787]
```

## Running
```bash
docker compose up -d --build        # default port 8787 (change with: HOST_PORT=9000 docker compose up -d)
```
Then open http://localhost:8787 in your browser.

## Getting started
1. Add a public playlist URL (or ID) in the control UI.
2. Install [Tampermonkey](https://www.tampermonkey.net/). In Chrome, also turn on "Allow User Scripts" in the extension's details.
3. Install the script from the "Install userscript" link in the control UI. The server address is filled in automatically at install time. To change it later, use "Change Shuffler server address" in the Tampermonkey menu.
4. Open **exactly one** deezer.com tab, signed in, and click anywhere on the page once. This is required by the browser's autoplay policy.
5. When Tampermonkey asks to allow access to the server, choose "Always allow".
6. When the "Deezer tab" badge in the UI turns green, press ⏭ Next track.

If you switch the output to "30-second preview", you can listen in the control page itself without a Deezer account. This is meant for checking that everything works.

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
| Setting | Description |
|---|---|
| Automatically play the next track | Picks the next track automatically when one ends |
| Max play time | 0 plays the whole track. For example, 90 fades out after 90 seconds and moves on to the next track |
| Fade-out / Gap between tracks | Fade length when a max play time is set, and the wait before the next track starts |

## Queue
The "Up next" panel, to the right of Settings, holds the upcoming tracks. Ten tracks are queued automatically whenever the queue is empty, including at startup and after adding a playlist.

| Control | What it does |
|---|---|
| ⏭ Next track | Plays the track at the top of the queue. If the queue runs out, 10 more are drawn automatically |
| 🎲 Rolling Dice | Draws 10 new random tracks and adds them to the end of the queue |
| 🔄 Flip Board | Clears the queue, then runs Rolling Dice |
| Drag and drop, ↑ ↓ | Changes the order (priority) of queued tracks |
| ✕ | Removes a track from the queue |

### Picking a song directly in Deezer
If you pick a song yourself in the Deezer tab, the userscript notices it and tells the server. The picked song becomes the current track, and the control page and the dance hall display show it ("Picked in Deezer"). The queue stays as it is; if the picked song was waiting in the queue, it is removed so it won't play twice. When the picked song ends, playback continues from the top of the queue.

How a direct pick is told apart from Deezer switching songs by itself:
- A different song must play for 1.5 seconds.
- Ads (player type ads/jingle) are ignored.
- When the previous track was in its last 3 seconds, the switch counts as that track ending (e.g. Deezer's autoplay). Changes in the 10 seconds after a track ends are not treated as picks.

### Playlist shares
Each active playlist has a 0–100% slider: its chance of supplying the next track. The next track is picked in two steps: first a playlist, by its share, regardless of how many tracks it has; then a random track inside that playlist.

- All active playlists always add up to 100%. Shares are whole numbers and never go below 0% or above 100%.
- Moving one slider changes the others equally to make up the difference. They update live while you drag, and the result is saved when you release. Once a playlist reaches 0%, the rest is taken from the others.
- A newly added (or newly checked) playlist gets the median of the existing shares, at most 50%, and takes that amount equally from the others. Unchecking or deleting a playlist gives its share back to the others equally.
- With only one active playlist, it is fixed at 100%. Unchecked playlists show "—".
- A small playlist with a high share repeats its tracks more often. Within a playlist, every track plays once before any repeats.

The share rules are in `public/shares.js`, used by both the server and the control page.

Each playlist has its own shuffle "bag": every track in it is drawn once before the bag is reshuffled. A track that is already queued or playing is never drawn again. Tracks removed by ✕ or Flip Board go back into the bag unplayed, so they can still come up later. The queue is saved in `/data` and survives restarts.

## Limitations
- **Deezer Free accounts**: on the web you can usually pick individual tracks, but ads play. In some countries (such as the US) only 30-second previews are allowed. When that is the case, the UI badge shows "30s-limited account". If an ad delays the start of a track, the userscript keeps retrying for up to 90 seconds.
- `dzPlayer` is an internal Deezer object, not a public API. The userscript may need fixing when Deezer updates its web app. The methods confirmed so far are `play`, `getSongId`, `getPosition`, `getDuration`, `isPlaying`, `isLimited`, and `control.pause/play/setVolume`.
- Playlists must be public.

The userscript keeps exactly one request open at a time (`POST /api/player/sync`). The request carries the player status and events up, and its response carries the latest command down. The server answers at once when a command is waiting, otherwise after at most 1 second. An earlier version used a separate long-poll, and the browser then held the userscript's status requests back for 10+ seconds.

## Layout
- `src/server.js`: HTTP server, shuffling, player long-poll, SSE (no external dependencies)
- `src/deezer.js`: Deezer public API client
- `src/store.js`: saves state to `/data/state.json`
- `public/`: control UI and `deezer-shuffler.user.js`
