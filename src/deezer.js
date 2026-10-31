// Deezer public API (no auth). Only public playlists are readable.
const API = 'https://api.deezer.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Deezer API HTTP ${res.status}`);
  const body = await res.json();
  if (body && body.error) {
    const err = new Error(`Deezer API error: ${body.error.message || body.error.type}`);
    err.deezerCode = body.error.code; // 800 = no data (missing or not public)
    throw err;
  }
  return body;
}

// Rewords "no data" (unknown id, or not public) for people; other errors pass through.
function notFound(message) {
  return (err) => {
    if (err.deezerCode === 800) throw new Error(message);
    throw err;
  };
}

const KIND_RE = /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(track|playlist|album|artist|show|episode|profile)\/(\d+)/i;

// Accepts a numeric id, a deezer.com URL of the wanted kind, or a short share
// link (link.deezer.com / deezer.page.link) leading to one, resolved by
// following redirects. Links to any other kind (album, artist, ...) are refused.
async function resolveId(input, wanted, refusal, unknown) {
  const text = String(input || '').trim();
  if (/^\d+$/.test(text)) return text;
  const kindOf = (url) => url.match(KIND_RE) || [];

  let [, kind, id] = kindOf(text);
  if (!kind && /^https?:\/\/(link\.deezer\.com|deezer\.page\.link)\//.test(text)) {
    const res = await fetch(text, { redirect: 'follow' });
    [, kind, id] = kindOf(res.url);
    if (!kind) [, kind, id] = kindOf(await res.text());
  }
  if (!kind) throw new Error(unknown);
  if (kind.toLowerCase() !== wanted) throw new Error(refusal);
  return id;
}

const resolvePlaylistId = (input) => resolveId(input, 'playlist',
  'Only playlists (playlist links) are accepted.', 'Could not recognize a playlist URL or ID.');

const resolveTrackId = (input) => resolveId(input, 'track',
  'Only songs (track links) are accepted.', 'Could not recognize a song URL or ID.');

function toTrack(t) {
  return {
    id: String(t.id),
    title: t.title,
    artist: t.artist ? t.artist.name : '',
    album: t.album ? t.album.title : '',
    cover: t.album ? t.album.cover_medium : '',
    duration: t.duration,
    readable: t.readable !== false,
  };
}

async function fetchPlaylist(id) {
  const meta = await getJson(`${API}/playlist/${id}`).catch(notFound('No public playlist with this ID.'));
  const tracks = [];
  let url = `${API}/playlist/${id}/tracks?limit=100&index=0`;
  while (url) {
    const page = await getJson(url);
    for (const t of page.data || []) tracks.push(toTrack(t));
    url = page.next || null;
  }
  return {
    id: String(meta.id),
    title: meta.title,
    creator: meta.creator ? meta.creator.name : '',
    picture: meta.picture_medium,
    link: meta.link,
    tracks,
    fetchedAt: new Date().toISOString(),
  };
}

// Preview URLs are signed and expire, so fetch them right before playing.
async function fetchPreviewUrl(trackId) {
  const t = await getJson(`${API}/track/${trackId}`);
  return t.preview || '';
}

async function fetchTrack(trackId) {
  return toTrack(await getJson(`${API}/track/${trackId}`).catch(notFound('No song with this ID.')));
}

module.exports = { resolvePlaylistId, resolveTrackId, fetchPlaylist, fetchPreviewUrl, fetchTrack };
