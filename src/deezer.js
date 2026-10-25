// Deezer public API (no auth). Only public playlists are readable.
const API = 'https://api.deezer.com';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Deezer API HTTP ${res.status}`);
  const body = await res.json();
  if (body && body.error) {
    throw new Error(`Deezer API error: ${body.error.message || body.error.type}`);
  }
  return body;
}

// Accepts a numeric id, a deezer.com playlist URL, or a short share link
// (link.deezer.com / deezer.page.link), which is resolved by following redirects.
async function resolvePlaylistId(input) {
  const text = String(input || '').trim();
  if (/^\d+$/.test(text)) return text;

  let match = text.match(/playlist\/(\d+)/);
  if (match) return match[1];

  if (/^https?:\/\/(link\.deezer\.com|deezer\.page\.link)\//.test(text)) {
    const res = await fetch(text, { redirect: 'follow' });
    match = res.url.match(/playlist\/(\d+)/);
    if (match) return match[1];
    const html = await res.text();
    match = html.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/);
    if (match) return match[1];
  }
  throw new Error('Could not recognize a playlist ID or URL.');
}

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
  const meta = await getJson(`${API}/playlist/${id}`);
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
  return toTrack(await getJson(`${API}/track/${trackId}`));
}

module.exports = { resolvePlaylistId, fetchPlaylist, fetchPreviewUrl, fetchTrack };
