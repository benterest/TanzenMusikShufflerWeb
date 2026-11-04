// Spotify without the Web API: public playlists and tracks are read from the
// embed pages (open.spotify.com/embed/...), which carry their data as JSON in
// a __NEXT_DATA__ script. No login, no app registration. The embed shows at
// most 100 tracks of a playlist.
const EMBED = 'https://open.spotify.com/embed';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EMBED_TRACK_LIMIT = 100;

async function fetchEntity(kind, id, missing) {
  const res = await fetch(`${EMBED}/${kind}/${id}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (res.status === 404) throw new Error(missing);
  if (!res.ok) throw new Error(`Spotify HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Could not read the Spotify page (its layout may have changed).');
  const props = (JSON.parse(m[1]).props || {}).pageProps || {};
  const entity = props.state && props.state.data && props.state.data.entity;
  if (props.status === 404 || !entity) throw new Error(missing);
  return entity;
}

const ID_RE = /^[A-Za-z0-9]{22}$/;
const KIND_RE = /open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|playlist|album|artist|show|episode)\/([A-Za-z0-9]{22})/i;
const URI_RE = /spotify:(track|playlist|album|artist|show|episode):([A-Za-z0-9]{22})/i;

// Accepts a bare id, an open.spotify.com URL or spotify: URI of the wanted
// kind, or a short share link (spotify.link / spotify.app.link) leading to
// one, resolved by following redirects. Other kinds are refused.
async function resolveId(input, wanted, refusal, unknown) {
  const text = String(input || '').trim();
  if (ID_RE.test(text)) return text;
  const kindOf = (s) => s.match(KIND_RE) || s.match(URI_RE) || [];

  let [, kind, id] = kindOf(text);
  if (!kind && /^https?:\/\/(spotify\.link|spotify\.app\.link)\//.test(text)) {
    const res = await fetch(text, { redirect: 'follow', headers: { 'User-Agent': UA } });
    [, kind, id] = kindOf(res.url);
    if (!kind) [, kind, id] = kindOf(await res.text());
  }
  if (!kind) throw new Error(/deezer\./i.test(text) ? `${unknown} This is a Deezer link; the music service is set to Spotify in Settings.` : unknown);
  if (kind.toLowerCase() !== wanted) throw new Error(refusal);
  return id;
}

const resolvePlaylistId = (input) => resolveId(input, 'playlist',
  'Only playlists (playlist links) are accepted.', 'Could not recognize a Spotify playlist URL or ID.');

const resolveTrackId = (input) => resolveId(input, 'track',
  'Only songs (track links) are accepted.', 'Could not recognize a Spotify song URL or ID.');

const trackIdOf = (uri) => (String(uri || '').match(/^spotify:track:([A-Za-z0-9]{22})$/) || [])[1] || '';

// Picks the image closest to 300px from a list of { url, maxWidth|width }.
function pickImage(list) {
  const imgs = (list || []).filter((i) => i && i.url);
  if (!imgs.length) return '';
  const w = (i) => i.maxWidth || i.width || 0;
  return imgs.reduce((best, i) => (Math.abs(w(i) - 300) < Math.abs(w(best) - 300) ? i : best)).url;
}

async function fetchPlaylist(id) {
  const e = await fetchEntity('playlist', id, 'No public Spotify playlist with this ID.');
  const tracks = [];
  for (const t of e.trackList || []) {
    const tid = trackIdOf(t.uri);
    if (!tid) continue; // podcast episodes, local files
    tracks.push({
      id: tid,
      title: t.title || '',
      artist: t.subtitle || '',
      album: '',
      cover: '', // not in the playlist embed; filled in from each track's embed
      duration: Math.round((Number(t.duration) || 0) / 1000),
      readable: t.isPlayable !== false,
      previewUrl: (t.audioPreview && t.audioPreview.url) || '',
    });
  }
  return {
    id: String(e.id || id),
    provider: 'spotify',
    title: e.name || e.title || '',
    creator: e.subtitle || '',
    picture: pickImage(e.coverArt && e.coverArt.sources),
    link: `https://open.spotify.com/playlist/${id}`,
    tracks,
    truncated: (e.trackList || []).length >= EMBED_TRACK_LIMIT,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchTrack(trackId) {
  const t = await fetchEntity('track', trackId, 'No Spotify song with this ID.');
  return {
    id: trackIdOf(t.uri) || String(trackId),
    title: t.name || t.title || '',
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: '',
    cover: pickImage(t.visualIdentity && t.visualIdentity.image),
    duration: Math.round((Number(t.duration) || 0) / 1000),
    readable: t.isPlayable !== false,
    previewUrl: (t.audioPreview && t.audioPreview.url) || '',
  };
}

async function fetchPreviewUrl(trackId) {
  return (await fetchTrack(trackId)).previewUrl;
}

module.exports = { resolvePlaylistId, resolveTrackId, fetchPlaylist, fetchPreviewUrl, fetchTrack };
