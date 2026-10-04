// =========================================================
// Hangout Music — App Controller
// A modular jukebox over the shared /global_library (RTDB 3, rpw3-67a05):
//   • YouTube search (URL paste via oEmbed · text via Data API v3)
//   • Community library rendered live through onValue()
//   • Per-user favorites at /user_playlists/{uid}
//   • Custom transport controls driving the hidden YouTube audio engine
// Auth + user identity come from the primary project (../js/firebase-config.js).
// =========================================================
import { auth, db, db3 } from '../js/firebase-config.js?v=4';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut as authSignOut,
  GoogleAuthProvider
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import {
  ref,
  onValue,
  push,
  set,
  remove,
  get
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';
import { YouTubeAudioPlayer } from './youtube-player.js?v=7';

// The YouTube Data API key is configured ONCE by an admin (stored in RTDB 3),
// so members never paste their own. Pasting a YouTube link never needs a key.
const API_KEY_PATH = 'settings/youtube_api_key';
// Remembers the last session (track + queue + playhead) across reloads.
const LAST_KEY = 'hangout_music_last';
const LAST_MAX_QUEUE = 100;

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  profile: null,
  library: [],          // global tracks, newest first
  libraryIndex: new Map(), // youtubeId -> track (de-dup guard)
  playlist: {},         // youtubeId -> track (mine)
  searchResults: [],
  view: 'library',      // library | playlist | search | queue
  queue: [],
  queueIndex: -1,
  apiKey: '',           // mirrored live from /settings/youtube_api_key (RTDB 3)
  playerReady: false,
  busySearch: false,
  resumePosition: 0,    // seconds to jump to when the restored track is first played
  unsubLibrary: null,
  unsubPlaylist: null
};

let player = null;
let toastTimer = null;
let pendingAutoPlay = null; // true while waiting on first player.init()
let lastSavedAt = 0;        // throttle for the last-played snapshot

/* ----------------------------- utilities ----------------------------- */

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function show(el, on = true) { if (el) el.classList.toggle('hidden', !on); }

function toast(msg, kind = 'ok') {
  const t = $('toast');
  if (!t) return;
  const color = kind === 'err' ? 'm-danger' : 'm-success';
  const icon = kind === 'err' ? 'fa-circle-exclamation' : 'fa-circle-check';
  t.innerHTML = `<i class="fa-solid ${icon} ${color}"></i><span class="min-w-0">${escapeHtml(msg)}</span>`;
  show(t, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), 2600);
}

/** Thumbnail URL for a YouTube id. */
function thumbFor(id) { return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; }

/** Pulls an 11-char video id out of a URL, a bare id, or a `v=` param. */
function parseYouTubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const url = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = url.pathname.match(/\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch (_) { /* not a URL — fall through */ }
  const m = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** Converts an ISO-8601 duration (PT1H2M3S) to seconds. */
function isoDurationToSeconds(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

function displayName() {
  return (state.profile && state.profile.name) || (state.user && state.user.displayName) ||
    (state.user && state.user.email ? state.user.email.split('@')[0] : '') ||
    (state.user ? `User_${state.user.uid.slice(0, 5)}` : 'Guest');
}

/* ----------------------------- views & rendering ----------------------------- */

function playlistArray() {
  return Object.values(state.playlist).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function currentItems() {
  if (state.view === 'library') return state.library;
  if (state.view === 'playlist') return playlistArray();
  if (state.view === 'search') return state.searchResults;
  if (state.view === 'queue') return state.queue;
  return [];
}

function viewMeta() {
  const n = currentItems().length;
  const plural = (c) => `${c} track${c === 1 ? '' : 's'}`;
  switch (state.view) {
    case 'library':
      return { title: 'Community Library', sub: `${plural(n)} shared by the hangout` };
    case 'playlist':
      return { title: 'My Playlist', sub: `${plural(n)} saved` };
    case 'search':
      return { title: 'Search Results', sub: n ? `${n} result${n === 1 ? '' : 's'} — tap “+” to share` : 'Search YouTube or paste a link' };
    case 'queue':
      return { title: 'Play Queue', sub: n ? `${n} in the queue` : 'Nothing queued yet' };
    default:
      return { title: 'Library', sub: '' };
  }
}

function emptyState() {
  switch (state.view) {
    case 'library': return { title: 'The library is empty', text: 'Search for a song above and tap “+” to add the very first track.' };
    case 'playlist': return { title: 'No saved tracks yet', text: 'Tap the heart on any track to save it to your personal playlist.' };
    case 'search': return { title: 'Search for music', text: 'Type a song or artist, or paste a YouTube link to pull it in directly.' };
    case 'queue': return { title: 'Queue is empty', text: 'Play something from the library to build your queue.' };
    default: return { title: 'Nothing here', text: '' };
  }
}

function trackRowHtml(track, index) {
  const id = track.youtubeId;
  const inLib = state.libraryIndex.has(id);
  const fav = Boolean(state.playlist[id]);
  const dead = unplayable.has(id);
  const blocked = track.embeddable === false;
  const dur = track.duration ? fmtTime(track.duration) : '--:--';
  const badge = track.addedBy
    ? `<span class="badge-contrib"><i class="fa-solid fa-user-plus"></i>Added by @${escapeHtml(track.addedBy)}</span>`
    : '';
  // Flag uploads that block embedded playback — either the API told us up front
  // (`status.embeddable === false`) or the player already failed on this one.
  const warnChip = (blocked || dead)
    ? `<span class="inline-flex items-center gap-1 text-[10px] font-semibold m-danger" title="This upload is blocked from embedded players, so it cannot play here"><i class="fa-solid fa-triangle-exclamation"></i>Can't embed</span>`
    : '';
  const addBtn = state.view === 'search'
    ? (blocked
      ? `<span class="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold m-danger px-1.5" title="Blocked from embedded players"><i class="fa-solid fa-ban"></i>Blocked</span>`
      : inLib
        ? `<span class="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold m-success px-1.5"><i class="fa-solid fa-check"></i>In library</span>`
        : `<button type="button" data-action="add" class="icon-btn h-9 px-3 text-xs font-semibold gap-1.5" title="Add to the community library"><i class="fa-solid fa-plus"></i><span class="hidden sm:inline">Add</span></button>`)
    : '';
  // Clean-up affordance: a track we know can't be embedded is dead weight, so
  // (and ONLY so) it can be removed — from the shared library or your playlist.
  const canDelete = (blocked || dead) && (state.view === 'library' || state.view === 'playlist');
  const delBtn = canDelete
    ? `<button type="button" data-action="delete" class="icon-btn w-9 h-9 text-sm m-danger" title="${state.view === 'library' ? 'Delete from the community library — this song can’t be embedded' : 'Remove from your playlist'}"><i class="fa-solid fa-trash-can"></i></button>`
    : '';

  return `
  <li class="track-row animate-rise p-2.5 flex items-center gap-3" data-track-id="${escapeHtml(id)}" data-index="${index}">
    <div class="thumb-frame w-14 h-14 sm:w-16 sm:h-16">
      <img loading="lazy" src="${escapeHtml(track.thumbnail || thumbFor(id))}" alt="" onerror="this.onerror=null;this.src='${thumbFor(id)}'">
      <span class="thumb-play"><i class="fa-solid fa-play text-white text-sm"></i></span>
    </div>
    <div class="min-w-0 flex-1">
      <div class="track-title text-sm font-semibold m-text line-clamp-1">${escapeHtml(track.title || 'Untitled')}</div>
      <div class="text-xs m-muted line-clamp-1 mt-0.5">${escapeHtml(track.artist || 'Unknown artist')}</div>
      <div class="flex items-center gap-2 mt-1.5 flex-wrap">
        ${badge}
        ${warnChip}
        <span class="text-[10px] m-faint font-mono">${track.addedAt ? escapeHtml(timeAgo(track.addedAt)) : ''}</span>
      </div>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      <span class="hidden sm:inline text-[11px] m-muted font-mono tabular-nums mr-1">${dur}</span>
      ${addBtn}
      ${delBtn}
      <button type="button" data-action="fav" class="icon-btn fav-btn ${fav ? 'is-on' : ''} w-9 h-9 text-sm" title="${fav ? 'Remove from my playlist' : 'Save to my playlist'}">
        <i class="fa-${fav ? 'solid' : 'regular'} fa-heart"></i>
      </button>
    </div>
  </li>`;
}

function markCurrentRow() {
  const cur = state.queueIndex >= 0 ? state.queue[state.queueIndex] : null;
  const activeId = cur ? cur.youtubeId : null;
  document.querySelectorAll('#content-list .track-row').forEach((row) => {
    const isCurrent = Boolean(activeId && row.dataset.trackId === activeId);
    row.classList.toggle('is-current', isCurrent);
    const icon = row.querySelector('.thumb-play i');
    if (icon) icon.className = (isCurrent && player && player.playing)
      ? 'fa-solid fa-volume-high text-white text-sm'
      : 'fa-solid fa-play text-white text-sm';
  });
}

function renderCounts() {
  if ($('lib-count')) $('lib-count').textContent = state.library.length;
  if ($('playlist-count')) $('playlist-count').textContent = playlistArray().length;
}

function renderContent() {
  const list = $('content-list');
  const items = currentItems();
  const meta = viewMeta();
  if ($('content-title')) $('content-title').textContent = meta.title;
  if ($('content-sub')) $('content-sub').textContent = meta.sub;

  ['library', 'playlist', 'search', 'queue'].forEach((v) => {
    const tab = $('tab-' + v);
    if (tab) tab.classList.toggle('is-active', v === state.view);
  });
  renderCounts();

  if (!items.length) {
    list.innerHTML = '';
    show(list, false);
    const empty = $('content-empty');
    if (empty) {
      const e = emptyState();
      $('content-empty-title').textContent = e.title;
      $('content-empty-text').textContent = e.text;
      show(empty, true);
    }
    return;
  }

  show($('content-empty'), false);
  show(list, true);
  list.innerHTML = items.map((t, i) => trackRowHtml(t, i)).join('');
  markCurrentRow();
}

function switchView(view) {
  state.view = view;
  renderContent();
  const panel = $('content-panel');
  if (panel && window.innerWidth < 1024) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ----------------------------- realtime data ----------------------------- */

function startLibraryListener() {
  if (state.unsubLibrary) state.unsubLibrary();
  state.unsubLibrary = onValue(ref(db3, 'global_library'), (snap) => {
    const val = snap.val() || {};
    const arr = Object.keys(val).map((key) => {
      const t = val[key] || {};
      const id = t.youtubeId || key;
      return {
        key,
        youtubeId: id,
        title: t.title || 'Untitled',
        artist: t.artist || 'Unknown artist',
        duration: Number(t.duration) || 0,
        thumbnail: t.thumbnail || thumbFor(id),
        addedBy: t.addedBy || '',
        addedByUid: t.addedByUid || '',
        addedAt: Number(t.addedAt) || 0
      };
    }).filter((t) => t.youtubeId);

    arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    state.library = arr;
    state.libraryIndex = new Map(arr.map((t) => [t.youtubeId, t]));
    renderContent();
    updateNowPlayingMeta();
  }, (err) => {
    console.warn('[music] library read failed:', err);
    toast('Could not load the community library', 'err');
  });
}

function startPlaylistListener(uid) {
  if (state.unsubPlaylist) { state.unsubPlaylist(); state.unsubPlaylist = null; }
  state.playlist = {};
  if (!uid) { renderContent(); return; }

  state.unsubPlaylist = onValue(ref(db3, `user_playlists/${uid}`), (snap) => {
    const val = snap.val() || {};
    const next = {};
    Object.keys(val).forEach((id) => {
      const t = val[id] || {};
      next[id] = {
        youtubeId: t.youtubeId || id,
        title: t.title || 'Untitled',
        artist: t.artist || 'Unknown artist',
        duration: Number(t.duration) || 0,
        thumbnail: t.thumbnail || thumbFor(id),
        addedAt: Number(t.addedAt) || 0
      };
    });
    state.playlist = next;
    renderContent();
  }, (err) => console.warn('[music] playlist read failed:', err));
}

/* ----------------------------- search & contributions ----------------------------- */

function requireSignIn() {
  if (state.user) return true;
  openAuthModal();
  toast('Sign in to add tracks', 'err');
  return false;
}

/**
 * Resolves metadata for a known video id.
 * With the shared key we use videos.list, which also reports the real duration
 * AND whether the uploader allows embedding (`status.embeddable`) — so a dead
 * link can be caught BEFORE it reaches the shared library. Without a key we fall
 * back to the keyless noembed oEmbed proxy, which carries no embeddability info.
 */
async function fetchTrackMeta(videoId) {
  const fallback = {
    youtubeId: videoId,
    title: videoId,
    artist: 'YouTube',
    duration: 0,
    thumbnail: thumbFor(videoId)
  };

  if (state.apiKey) {
    try {
      const res = await fetch('https://www.googleapis.com/youtube/v3/videos'
        + `?part=snippet,contentDetails,status&id=${encodeURIComponent(videoId)}`
        + `&key=${encodeURIComponent(state.apiKey)}`);
      const data = await res.json();
      const item = data && Array.isArray(data.items) ? data.items[0] : null;
      if (item) {
        const s = item.snippet || {};
        const thumbs = s.thumbnails || {};
        return {
          youtubeId: videoId,
          title: (s.title || fallback.title).trim(),
          artist: (s.channelTitle || 'YouTube').trim(),
          duration: isoDurationToSeconds(item.contentDetails && item.contentDetails.duration),
          thumbnail: (thumbs.medium || thumbs.high || thumbs.default || {}).url || fallback.thumbnail,
          embeddable: !(item.status && item.status.embeddable === false)
        };
      }
    } catch (_) { /* fall through to the keyless path */ }
  }

  try {
    const url = `https://noembed.com/embed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}`;
    const res = await fetch(url);
    if (!res.ok) return fallback;
    const data = await res.json();
    if (!data || data.error) return fallback;
    return {
      youtubeId: videoId,
      title: (data.title || fallback.title).trim(),
      artist: (data.author_name || 'YouTube').trim(),
      duration: 0,
      thumbnail: data.thumbnail_url || fallback.thumbnail
    };
  } catch (_) {
    return fallback;
  }
}

/** Text search through the YouTube Data API v3 (uses the shared admin key). */
async function searchByApi(query) {
  const key = state.apiKey;
  // videoEmbeddable=true keeps owner/label-restricted uploads out of the results
  // entirely — the vast majority of "cannot be embedded" errors never happen.
  const searchUrl = 'https://www.googleapis.com/youtube/v3/search'
    + `?part=snippet&type=video&videoEmbeddable=true&maxResults=12&key=${encodeURIComponent(key)}`
    + `&q=${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl);
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error((data.error && data.error.message) || `YouTube API error (${res.status})`);
  }

  const items = (data.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => {
      const s = it.snippet || {};
      const thumbs = s.thumbnails || {};
      return {
        youtubeId: it.id.videoId,
        title: s.title || 'Untitled',
        artist: s.channelTitle || 'YouTube',
        duration: 0,
        thumbnail: (thumbs.medium || thumbs.high || thumbs.default || {}).url || thumbFor(it.id.videoId)
      };
    });

  if (!items.length) return items;

  // Second call resolves the real durations + confirms embeddability.
  try {
    const ids = items.map((i) => i.youtubeId).join(',');
    const vidRes = await fetch('https://www.googleapis.com/youtube/v3/videos'
      + `?part=contentDetails,status&id=${ids}&key=${encodeURIComponent(key)}`);
    const vidData = await vidRes.json();
    const map = {};
    (vidData.items || []).forEach((v) => {
      map[v.id] = {
        duration: isoDurationToSeconds(v.contentDetails && v.contentDetails.duration),
        embeddable: !(v.status && v.status.embeddable === false)
      };
    });
    items.forEach((i) => {
      const info = map[i.youtubeId];
      if (info) { i.duration = info.duration; i.embeddable = info.embeddable; }
    });
  } catch (_) { /* durations are best-effort */ }

  return items;
}

function setSearchBusy(busy) {
  const btn = $('music-search-btn');
  if (btn) btn.disabled = busy;
  const icon = btn && btn.querySelector('i');
  if (icon) icon.className = busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-magnifying-glass';
}

function setSearchHint(msg) {
  const hint = $('search-hint');
  if (!hint) return;
  hint.textContent = msg || '';
  show(hint, Boolean(msg));
}

async function handleSearch() {
  const input = $('music-search-input');
  const query = (input && input.value || '').trim();
  if (!query || state.busySearch) return;

  state.busySearch = true;
  setSearchBusy(true);
  switchView('search');
  state.searchResults = [];
  renderContent();
  setSearchHint('');

  try {
    const directId = parseYouTubeId(query);
    if (directId) {
      const track = await fetchTrackMeta(directId);
      state.searchResults = [track];
      if (track.embeddable === false) {
        setSearchHint('That video is blocked from embedded players, so it cannot play in Hangout Music.');
        toast('That video cannot be embedded', 'err');
      } else {
        setSearchHint('Loaded from link — tap “+” to share it with everyone.');
      }
    } else if (!state.apiKey) {
      setSearchHint('Paste a YouTube link to add a track — keyword search is being set up by the admins.');
      toast('Keyword search is not available yet', 'err');
    } else {
      state.searchResults = await searchByApi(query);
      if (!state.searchResults.length) setSearchHint('No results found. Try different keywords.');
    }
  } catch (err) {
    console.warn('[music] search failed:', err);
    setSearchHint(`Search failed: ${err.message}`);
    toast('Search failed', 'err');
  } finally {
    state.busySearch = false;
    setSearchBusy(false);
    renderContent();
  }
}

/** Adds a track to the shared /global_library, guarding against duplicates. */
async function addToLibrary(track) {
  if (!requireSignIn()) return;
  if (!track || !track.youtubeId) return;
  if (state.libraryIndex.has(track.youtubeId)) {
    toast('Already in the community library');
    return;
  }
  // Don't let a dead link into the shared library — it would fail for everyone.
  if (track.embeddable === false) {
    toast('Blocked from embedded players — it cannot play in Hangout Music', 'err');
    return;
  }
  try {
    await push(ref(db3, 'global_library'), {
      youtubeId: track.youtubeId,
      title: track.title || 'Untitled',
      artist: track.artist || 'Unknown artist',
      duration: Number(track.duration) || 0,
      thumbnail: track.thumbnail || thumbFor(track.youtubeId),
      addedBy: displayName(),
      addedByUid: state.user.uid,
      addedAt: Date.now()
    });
    toast('Added to the community library');
  } catch (err) {
    console.warn('[music] add failed:', err);
    toast('Could not add that track', 'err');
  }
}

/** Toggles a track in the signed-in user's personal playlist. */
async function toggleFavorite(track) {
  if (!requireSignIn()) return;
  if (!track || !track.youtubeId) return;
  const uid = state.user.uid;
  const path = `user_playlists/${uid}/${track.youtubeId}`;
  try {
    if (state.playlist[track.youtubeId]) {
      await remove(ref(db3, path));
      toast('Removed from your playlist');
    } else {
      await set(ref(db3, path), {
        youtubeId: track.youtubeId,
        title: track.title || 'Untitled',
        artist: track.artist || 'Unknown artist',
        duration: Number(track.duration) || 0,
        thumbnail: track.thumbnail || thumbFor(track.youtubeId),
        addedAt: Date.now()
      });
      toast('Saved to your playlist');
    }
  } catch (err) {
    console.warn('[music] favourite failed:', err);
    toast('Could not update your playlist', 'err');
  }
}

/**
 * Removes a track from the community library or the user's playlist.
 * Only reachable from rows the app has flagged as un-embeddable (the delete
 * button is not rendered otherwise), so this is a clean-up path rather than a
 * general edit tool. Because the shared library affects everyone, it confirms
 * first; the personal playlist does too, for consistency.
 */
async function deleteTrack(track) {
  if (!requireSignIn()) return;
  if (!track || !track.youtubeId) return;

  const fromLibrary = state.view === 'library';
  const fromPlaylist = state.view === 'playlist';
  if (!fromLibrary && !fromPlaylist) return;

  const id = track.youtubeId;
  const where = fromLibrary ? 'the community library' : 'your playlist';
  const label = track.title ? `“${track.title}”` : 'That track';
  if (!window.confirm(`Remove ${label} from ${where}?`)) return;

  try {
    if (fromLibrary) {
      const entry = track.key ? track : state.library.find((t) => t.youtubeId === id);
      if (!entry || !entry.key) { toast('Could not find that library entry', 'err'); return; }
      await remove(ref(db3, `global_library/${entry.key}`));
    } else {
      await remove(ref(db3, `user_playlists/${state.user.uid}/${id}`));
    }
    unplayable.delete(id);
    toast(`Removed from ${where}`);
  } catch (err) {
    console.warn('[music] delete failed:', err);
    toast('Could not delete that track', 'err');
  }
}

/* ----------------------------- background playback -----------------------------
   Keeps audio running when the tab/app is backgrounded or the screen locks:
     • nothing here ever pauses playback on hide — audio just keeps going
     • Media Session publishes track metadata + routes hardware media keys and
       lock-screen / notification buttons back to our transport
     • when the page returns we re-sync the UI, because background tabs throttle
       timers (the 250ms seekbar ticker effectively stops)
   Note: background audio from a cross-origin YouTube iframe is supported by
   desktop Chrome/Edge/Firefox and Chrome on Android. iOS Safari suspends page
   media on background/lock — that is an Apple platform restriction.
--------------------------------------------------------------------------------- */

/** Publishes the current track to the OS media controls (lock screen / notification). */
function updateMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  try {
    if (!track) { navigator.mediaSession.metadata = null; return; }
    if (typeof MediaMetadata === 'undefined') return;
    const art = track.thumbnail || thumbFor(track.youtubeId);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || 'Untitled',
      artist: track.artist || 'Unknown artist',
      album: 'Hangout Music',
      artwork: [
        { src: art, sizes: '320x180', type: 'image/jpeg' },
        { src: thumbFor(track.youtubeId), sizes: '480x270', type: 'image/jpeg' }
      ]
    });
  } catch (_) { /* best-effort only */ }
}

/** Routes hardware media keys / lock-screen buttons to the app's transport. */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) {}
  };
  set('play', () => togglePlayPause());
  set('pause', () => togglePlayPause());
  set('previoustrack', () => prevTrack());
  set('nexttrack', () => nextTrack());
  set('stop', () => { if (player) player.pauseVideo(); });
  set('seekbackward', (d) => seekBy(-(d && d.seekOffset ? d.seekOffset : 10)));
  set('seekforward', (d) => seekBy(d && d.seekOffset ? d.seekOffset : 10));
  set('seekto', (d) => { if (player && d && typeof d.seekTime === 'number') player.seekTo(d.seekTime); });
}

function syncMediaSessionState() {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = (player && player.playing) ? 'playing' : 'paused'; } catch (_) {}
}

/** Feeds the lock-screen scrubber its position (safe no-op where unsupported). */
function syncMediaPosition(current, duration) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      playbackRate: 1,
      position: Math.max(0, Math.min(Number(current) || 0, d))
    });
  } catch (_) {}
}

/** Background tabs throttle timers, so re-sync the UI when the page comes back. */
function handleVisibility() {
  if (document.visibilityState === 'hidden') {
    saveLastPlayed(true);
    return;
  }
  if (player && player.ready) {
    player.resync();
    updateSeekUi(uiPosition(), player.getDuration());
  }
  updatePlayButton();
  syncMediaSessionState();
}

/* ----------------------------- last-played memory -----------------------------
   Survives reloads, tab closes and phone lock-ups: the current track, the queue
   and the playhead are snapshotted to localStorage and restored on the next
   visit. Playback is never auto-started (browsers block audio without a user
   gesture), so the bar comes back paused with the seekbar sitting exactly where
   you left it — one tap on play continues from there.
-------------------------------------------------------------------------------- */

/** Only the fields worth persisting, so the snapshot stays small. */
function pickTrackFields(t) {
  return {
    youtubeId: t.youtubeId,
    title: t.title || 'Untitled',
    artist: t.artist || 'Unknown artist',
    duration: Number(t.duration) || 0,
    thumbnail: t.thumbnail || thumbFor(t.youtubeId)
  };
}

/** A windowed slice of the queue, so the saved index always stays valid. */
function queueForStorage() {
  const q = state.queue;
  const i = state.queueIndex;
  if (q.length <= LAST_MAX_QUEUE) return { queue: q, index: i };
  const half = Math.floor(LAST_MAX_QUEUE / 2);
  const start = Math.max(0, Math.min(i - half, q.length - LAST_MAX_QUEUE));
  return { queue: q.slice(start, start + LAST_MAX_QUEUE), index: i - start };
}

/** Snapshots the current track + queue + playhead (throttled unless forced). */
function saveLastPlayed(force = false) {
  try {
    const track = currentTrack();
    if (!track || !track.youtubeId) return;
    const now = Date.now();
    if (!force && now - lastSavedAt < 4000) return;
    lastSavedAt = now;

    const position = (player && player.ready && player.getVideoId())
      ? player.getCurrentTime()
      : state.resumePosition;
    const windowed = queueForStorage();

    localStorage.setItem(LAST_KEY, JSON.stringify({
      at: now,
      position: Math.max(0, Math.round(position)),
      queueIndex: windowed.index,
      queue: windowed.queue.map(pickTrackFields),
      track: pickTrackFields(track)
    }));
  } catch (_) { /* private mode / quota — memory is best-effort */ }
}

/** Restores the previous session's track, queue and playhead (paused). */
function restoreLastPlayed() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (_) { return; }
  if (!saved || !saved.track || !saved.track.youtubeId) return;

  let queue = Array.isArray(saved.queue) ? saved.queue.filter((t) => t && t.youtubeId) : [];
  if (!queue.length) queue = [saved.track];

  let index = Number(saved.queueIndex);
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) {
    index = Math.max(0, queue.findIndex((t) => t.youtubeId === saved.track.youtubeId));
  }

  state.queue = queue.map((t) => ({ ...t }));
  state.queueIndex = index;
  state.resumePosition = Math.max(0, Number(saved.position) || 0);

  const track = currentTrack();
  if (!track) return;
  updateNowPlaying(track);
  updateSeekUi(state.resumePosition, track.duration || 0);

  if (state.resumePosition >= 15) toast('Tap play to resume where you left off');
}

/** Playhead for the UI: the live position while playing, else the restored one. */
function uiPosition() {
  if (player && player.ready) {
    if (player.playing) return player.getCurrentTime();
    if (state.resumePosition > 0) return state.resumePosition;
    return player.getCurrentTime();
  }
  return state.resumePosition || 0;
}

/* ----------------------------- embed-blocked tracks -----------------------------
   Some uploads cannot play in ANY embedded player — the uploader or the rights
   holder disabled embedding (YouTube error 101/150), or the video is gone (100).
   There is no legitimate way to force those through the official player, so we
   do the next best things: keep them out of search results (videoEmbeddable),
   refuse to add them to the shared library, remember the ones that fail, label
   them in the UI, and skip past them instead of stalling the queue.
---------------------------------------------------------------------------------- */

const UNPLAYABLE_KEY = 'hangout_music_unplayable';
const UNPLAYABLE_MAX = 100;

let unplayable = new Set(); // videoIds that failed in the embedded player
let skipStreak = 0;         // consecutive auto-skips, so a dead queue can't loop forever

function loadUnplayable() {
  try {
    const raw = JSON.parse(localStorage.getItem(UNPLAYABLE_KEY) || '[]');
    if (Array.isArray(raw)) unplayable = new Set(raw.filter((id) => typeof id === 'string'));
  } catch (_) { /* private mode — memory is best-effort */ }
}

function markUnplayable(videoId) {
  if (!videoId || unplayable.has(videoId)) return;
  unplayable.add(videoId);
  try {
    localStorage.setItem(UNPLAYABLE_KEY, JSON.stringify([...unplayable].slice(-UNPLAYABLE_MAX)));
  } catch (_) { /* quota — ignore */ }
  renderContent(); // repaint so the "Can't embed" chip shows up
}

/** Self-heal: if YouTube later allows embedding again, clear the flag. */
function forgetUnplayable(videoId) {
  if (!videoId || !unplayable.has(videoId)) return;
  unplayable.delete(videoId);
  try {
    localStorage.setItem(UNPLAYABLE_KEY, JSON.stringify([...unplayable]));
  } catch (_) { /* ignore */ }
  renderContent();
}

/** Plain-language reason for a YouTube IFrame player error code. */
function errorReason(code) {
  if (code === 101 || code === 150) return 'blocked from embedded players by its owner';
  if (code === 100) return 'removed or made private';
  if (code === 2) return 'an invalid video id';
  if (code === 5) return 'not playable in an HTML5 player';
  return 'not playable here';
}

/** Next queue index in `dir`, stepping over tracks we already know are dead. */
function stepIndex(from, dir) {
  const n = state.queue.length;
  if (n <= 1) return 0;
  for (let step = 1; step <= n; step += 1) {
    const i = (((from + dir * step) % n) + n) % n;
    const t = state.queue[i];
    if (t && !unplayable.has(t.youtubeId)) return i;
  }
  return (((from + dir) % n) + n) % n; // everything is flagged — plain step anyway
}

/** One dead link shouldn't stall the queue: label it, then hop to the next. */
function handlePlaybackError(code) {
  const track = currentTrack();
  const id = track ? track.youtubeId : null;
  console.warn('[music] player error', code, id);
  if (id) markUnplayable(id);

  const label = track ? `“${track.title}”` : 'That track';
  toast(`${label} skipped — ${errorReason(code)}`, 'err');

  if (!state.queue.length) return;
  skipStreak += 1;
  if (skipStreak >= state.queue.length) {
    skipStreak = 0;
    toast('Nothing in this queue can be embedded — try a different song', 'err');
    updatePlayButton();
    return;
  }
  setTimeout(() => { if (state.queue.length) nextTrack(); }, 1000);
}

/* ----------------------------- player & queue ----------------------------- */

let scrubbing = false;

/**
 * Volume preference, shared with the full Music app.
 * Maximum (100) unless the listener has deliberately moved the slider.
 * NB: `Number(null)` is 0 — an UNSET key must be handled explicitly or the
 * player silently boots at volume 0 (the old fallback never fired).
 */
function storedVolume() {
  const raw = localStorage.getItem('hangout_music_volume');
  if (raw === null) return 100;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}

/** Lazily boots the hidden audio engine and returns its init promise. */
function ensurePlayer() {
  if (!player) {
    player = new YouTubeAudioPlayer({
      mountId: 'yt-player-mount',
      volume: storedVolume(),
      onReady: () => {
        state.playerReady = true;
        show($('yt-status'), false);
        if (pendingAutoPlay) {
          const id = pendingAutoPlay;
          pendingAutoPlay = null;
          player.play(id);
        }
      },
      onStateChange: () => {
        if (player.playing) {
          state.resumePosition = 0;
          skipStreak = 0;                              // one good track resets the runaway guard
          forgetUnplayable(player.getVideoId());       // self-heal a previously blocked id
        }
        updatePlayButton();
        markCurrentRow();
        saveLastPlayed(true);
      },
      onEnded: () => nextTrack(),
      onError: (code) => handlePlaybackError(code),
      onTime: (t, d) => { updateSeekUi(t, d); saveLastPlayed(); },
      onDuration: (d) => { updateSeekUi(player.getCurrentTime(), d); updateNowPlayingMeta(); }
    });
  }
  return player.init().catch((err) => {
    console.warn('[music] player init failed:', err);
    toast('Could not load the YouTube player', 'err');
    throw err;
  });
}

/** Paints the gradient fill of a range input (custom seekbar / volume). */
function setFill(el, ratio) {
  if (!el) return;
  const pct = Math.max(0, Math.min(1, Number(ratio) || 0)) * 100;
  el.style.setProperty('--fill', pct + '%');
}

function updateSeekUi(current, duration) {
  const bar = $('seekbar');
  const dur = Number(duration) || (player ? player.getDuration() : 0) || 0;
  const cur = dur ? Math.min(Number(current) || 0, dur) : (Number(current) || 0);
  if (bar && !scrubbing) {
    bar.max = String(Math.max(1, Math.round(dur)));
    bar.value = String(Math.round(cur));
    setFill(bar, dur ? cur / dur : 0);
  }
  if ($('time-current')) $('time-current').textContent = fmtTime(cur);
  if ($('time-total')) $('time-total').textContent = dur ? fmtTime(dur) : '--:--';
  syncMediaPosition(cur, dur);
}

function currentTrack() {
  return state.queueIndex >= 0 ? state.queue[state.queueIndex] : null;
}

function updatePlayButton() {
  const playing = Boolean(player && player.playing);
  const icon = $('icon-play');
  if (icon) icon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  $('viz') && $('viz').classList.toggle('is-paused', !playing);
  $('player-vinyl') && $('player-vinyl').classList.toggle('is-paused', !playing);
  syncMediaSessionState();
}

/** Paints the volume slider + percentage readout (0-100). */
function paintVolume(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const bar = $('volbar');
  if (bar) { bar.value = String(v); setFill(bar, v / 100); }
  const label = $('vol-value');
  if (label) label.textContent = v + '%';
  return v;
}

/** Speaker icons (top bar + popover) mirror both mute state and current level. */
function updateVolIcon() {
  let cls = 'fa-solid fa-volume-high';
  if (player) {
    const v = player.getVolume();
    if (player.muted || v === 0) cls = 'fa-solid fa-volume-xmark';
    else if (v < 45) cls = 'fa-solid fa-volume-low';
  }
  const top = $('icon-vol');
  const inner = $('icon-mute');
  if (top) top.className = cls;
  if (inner) inner.className = cls;
}

function setupMarquee() {
  const wrap = $('player-title-wrap');
  const span = $('player-title');
  if (!wrap || !span) return;
  const cur = currentTrack();
  const title = cur ? (cur.title || 'Untitled') : 'Nothing playing';
  wrap.classList.remove('is-overflowing');
  span.textContent = title;
  if (span.scrollWidth > wrap.clientWidth + 4) {
    const sep = '\u00A0\u00A0\u00A0\u00A0•\u00A0\u00A0\u00A0\u00A0';
    span.textContent = title + sep + title + sep;
    wrap.classList.add('is-overflowing');
  }
}

function updateNowPlaying(track) {
  const thumb = $('player-thumb');
  if (thumb) {
    if (track) thumb.src = track.thumbnail || thumbFor(track.youtubeId);
    else thumb.removeAttribute('src');
  }
  if ($('player-title')) $('player-title').textContent = track ? (track.title || 'Untitled') : 'Nothing playing';
  if ($('player-artist')) $('player-artist').textContent = track ? (track.artist || 'Unknown artist') : 'Pick a track to start';
  updatePlayButton();
  markCurrentRow();
  setupMarquee();
  updateMediaSession(track);
  document.title = track ? `${track.title} · Hangout Music` : 'Hangout Music';
  saveLastPlayed(true);
}

/** Called when the library changes so the playing track keeps fresh metadata. */
function updateNowPlayingMeta() {
  const cur = currentTrack();
  if (!cur) return;
  const lib = state.libraryIndex.get(cur.youtubeId);
  if (lib && lib.duration && !cur.duration) {
    cur.duration = lib.duration;
    if (!scrubbing) updateSeekUi(uiPosition(), lib.duration);
  }
}

/** Plays a list of tracks as the active queue, starting at `index`. */
function playTrackList(items, index) {
  const list = (items || []).filter((t) => t && t.youtubeId);
  if (!list.length) return;
  state.queue = list.map((t) => ({ ...t }));
  state.queueIndex = Math.max(0, Math.min(index || 0, state.queue.length - 1));
  state.resumePosition = 0; // explicit pick — always start from the top
  const track = currentTrack();
  if (!track) return;
  pendingAutoPlay = track.youtubeId;
  updateNowPlaying(track);
  if (state.view === 'queue') renderContent();
  ensurePlayer().then(() => {
    if (pendingAutoPlay === track.youtubeId) {
      pendingAutoPlay = null;
      player.play(track.youtubeId);
    }
  }).catch(() => {});
}

/** Plays the row the user clicked inside the current view. */
function playFromContext(index) {
  const items = currentItems();
  const track = items[index];
  if (!track) return;
  if (state.view === 'queue') {
    state.queueIndex = index;
    state.resumePosition = 0;
    updateNowPlaying(track);
    ensurePlayer().then(() => player.play(track.youtubeId)).catch(() => {});
    return;
  }
  playTrackList(items, index);
}

/** Advances the queue (also used for auto-advance and looping). */
function nextTrack() {
  if (!state.queue.length) return;
  state.queueIndex = stepIndex(state.queueIndex, 1);
  state.resumePosition = 0;
  const track = currentTrack();
  if (!track) return;
  updateNowPlaying(track);
  if (state.view === 'queue') renderContent(); else markCurrentRow();
  ensurePlayer().then(() => player.play(track.youtubeId)).catch(() => {});
}

function prevTrack() {
  if (!state.queue.length) return;
  const elapsed = player ? player.getCurrentTime() : 0;
  if (elapsed > 3) { // classic "restart current" behaviour
    state.resumePosition = 0;
    ensurePlayer().then(() => player.seekTo(0)).catch(() => {});
    updateSeekUi(0, player ? player.getDuration() : 0);
    return;
  }
  state.queueIndex = stepIndex(state.queueIndex, -1);
  state.resumePosition = 0;
  const track = currentTrack();
  if (!track) return;
  updateNowPlaying(track);
  if (state.view === 'queue') renderContent(); else markCurrentRow();
  ensurePlayer().then(() => player.play(track.youtubeId)).catch(() => {});
}

function togglePlayPause() {
  if (!state.queue.length) {
    const items = currentItems();
    if (items.length) { playTrackList(items, 0); return; }
    toast('Pick a track to play');
    return;
  }
  ensurePlayer().then(() => {
    const cur = currentTrack();
    // First start of a restored session: continue from the saved playhead.
    if (!player.playing && cur && state.resumePosition > 0) {
      player.play(cur.youtubeId, state.resumePosition);
      state.resumePosition = 0;
      return;
    }
    player.toggle();
  }).catch(() => {});
}

function seekBy(delta) {
  if (!player || !state.queue.length) return;
  const dur = player.getDuration() || 0;
  const target = Math.max(0, dur ? Math.min(player.getCurrentTime() + delta, dur) : player.getCurrentTime() + delta);
  player.seekTo(target);
}

/** Wires the custom transport controls to the hidden audio engine. */
function setupPlayer() {
  const seekbar = $('seekbar');
  if (seekbar) {
    seekbar.addEventListener('input', () => {
      scrubbing = true;
      if (player) player.beginScrub();
      setFill(seekbar, Number(seekbar.value) / Number(seekbar.max || 1));
      if ($('time-current')) $('time-current').textContent = fmtTime(seekbar.value);
    });
    seekbar.addEventListener('change', () => {
      const target = Number(seekbar.value);
      if (player) { player.seekTo(target); player.endScrub(); }
      scrubbing = false;
      state.resumePosition = 0;
    });
  }

  // ---- Volume (popover, reachable at every breakpoint) ----
  paintVolume(storedVolume());

  const volbar = $('volbar');
  if (volbar) {
    volbar.addEventListener('input', () => {
      const v = paintVolume(volbar.value);
      try { localStorage.setItem('hangout_music_volume', String(v)); } catch (_) {}
      ensurePlayer().then(() => {
        player.setVolume(v);
        if (v > 0 && player.muted) player.setMuted(false);
        updateVolIcon();
      }).catch(() => {});
    });
  }

  const btnMute = $('btn-mute');
  if (btnMute) btnMute.addEventListener('click', () => {
    ensurePlayer().then(() => {
      player.setMuted(!player.muted);
      if (!player.muted) {
        const v = player.getVolume() || storedVolume();
        if (v <= 0) { player.setVolume(60); paintVolume(60); }
        else paintVolume(v);
      }
      updateVolIcon();
    }).catch(() => {});
  });

  const volBtn = $('btn-volume');
  const volPop = $('volume-pop');
  const closeVolPop = () => {
    if (volPop) show(volPop, false);
    if (volBtn) volBtn.setAttribute('aria-expanded', 'false');
  };
  if (volBtn && volPop) {
    volBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = volPop.classList.contains('hidden');
      show(volPop, willOpen);
      volBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (willOpen) updateVolIcon();
    });
    volPop.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeVolPop);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVolPop(); });
  }

  const btnPlay = $('btn-play');
  if (btnPlay) btnPlay.addEventListener('click', togglePlayPause);
  const btnNext = $('btn-next');
  if (btnNext) btnNext.addEventListener('click', () => nextTrack());
  const btnPrev = $('btn-prev');
  if (btnPrev) btnPrev.addEventListener('click', () => prevTrack());
  const nowInfo = $('player-info');
  if (nowInfo) nowInfo.addEventListener('click', togglePlayPause);

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    const tag = (el && el.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seekBy(5); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
  });
}

/* ----------------------------- theme ----------------------------- */

function isDarkTheme() { return document.documentElement.classList.contains('dark'); }

/** Keeps the mobile browser chrome in sync with the active theme. */
function syncMetaThemeColor() {
  const meta = $('meta-theme-color');
  if (meta) meta.setAttribute('content', isDarkTheme() ? '#05060d' : '#eef1f8');
}

/** Mirrors the active theme onto the account-modal switch, icon + label. */
function syncThemeUi() {
  const dark = isDarkTheme();
  const sw = $('theme-toggle');
  if (sw) {
    sw.classList.toggle('is-on', dark);
    sw.setAttribute('aria-checked', dark ? 'true' : 'false');
  }
  const icon = $('icon-theme');
  if (icon) icon.className = dark ? 'fa-solid fa-sun text-sm' : 'fa-solid fa-moon text-sm';
  const label = $('theme-label');
  if (label) label.textContent = dark ? 'Dark mode' : 'Light mode';
}

/** Flips light/dark using the same localStorage.theme contract as the rest of the site. */
function toggleTheme() {
  const next = !isDarkTheme();
  document.documentElement.classList.toggle('dark', next);
  try { localStorage.theme = next ? 'dark' : 'light'; } catch (_) {}
  syncMetaThemeColor();
  syncThemeUi();
  setupMarquee();
}

/* ----------------------------- auth & settings ----------------------------- */

function openAuthModal() { show($('modal-auth'), true); }

function closeAuthModal() {
  show($('modal-auth'), false);
  const e = $('auth-error-msg');
  if (e) show(e, false);
}

function showAuthError(err) {
  const el = $('auth-error-msg');
  if (!el) return;
  el.textContent = ((err && err.message) || 'Sign-in failed').replace('Firebase: ', '');
  show(el, true);
}

async function fetchProfile(uid) {
  try {
    const snap = await get(ref(db, `users/${uid}`));
    return snap.exists() ? (snap.val() || {}) : null;
  } catch (_) {
    return null;
  }
}

function updateAuthUi() {
  const signedIn = Boolean(state.user);
  const name = signedIn ? displayName() : 'Guest';

  applyAvatars(signedIn);

  const nameEl = $('user-modal-name');
  if (nameEl) nameEl.textContent = name;
  const statusEl = $('user-modal-status');
  if (statusEl) {
    statusEl.textContent = signedIn
      ? 'Signed in · playlists sync to your account'
      : 'Not signed in · sign in to save playlists';
  }
  const menuBtn = $('btn-user-menu');
  if (menuBtn) menuBtn.title = signedIn ? `Signed in as ${name}` : 'Account & settings';

  show($('btn-user-signin'), !signedIn);
  show($('btn-user-signout'), signedIn);
}

/** Inline display toggle for FontAwesome <i> elements (immune to FA's own display rule). */
function showIcon(el, on) {
  if (el) el.style.display = on ? '' : 'none';
}

/** Shows the avatar image (signed in) or the generic user icon (signed out). */
function applyAvatars(signedIn) {
  const url = signedIn ? avatarFor() : '';
  ['user-avatar', 'user-avatar-lg'].forEach((id) => {
    const img = $(id);
    if (!img) return;
    if (url) {
      if (img.getAttribute('src') !== url) img.src = url;
    } else {
      img.removeAttribute('src');
    }
    show(img, signedIn);
  });
  showIcon($('user-avatar-icon'), !signedIn);
  showIcon($('user-avatar-lg-icon'), !signedIn);
}

/** Resolves the signed-in member's avatar (Cloudinary-optimized when available). */
function avatarFor() {
  const raw = (state.profile && state.profile.pic) || (state.user && state.user.photoURL) || '';
  if (raw) return window.optAvatar ? window.optAvatar(raw, 96) : raw;
  // Deterministic fallback — same provider the main site uses (window.generateAvatar).
  const seed = encodeURIComponent((state.user && state.user.uid) || 'hangout');
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=transparent`;
}

/**
 * The YouTube Data API key is owned by the admins: it is written once in /config
 * and stored in RTDB 3. Mirrored live here so a first-time setup or a rotation
 * reaches open tabs without a reload — members never paste a key themselves.
 * Pasting a YouTube link never needs a key at all.
 */
function startApiKeyListener() {
  onValue(ref(db3, API_KEY_PATH), (snap) => {
    state.apiKey = String(snap.val() || '').trim();
    if (state.apiKey && state.view === 'search' && !state.searchResults.length && !state.busySearch) {
      setSearchHint('Shared search is ready — type a song or artist, or paste a link.');
    }
  }, (err) => {
    console.warn('[music] shared API key read failed:', err);
  });
}

/* ----------------------------- account modal ----------------------------- */

function openUserModal() {
  updateAuthUi();
  syncThemeUi();
  show($('modal-user'), true);
  const btn = $('btn-user-menu');
  if (btn) btn.setAttribute('aria-expanded', 'true');
}

function closeUserModal() {
  show($('modal-user'), false);
  const btn = $('btn-user-menu');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

/* ----------------------------- UI wiring & boot ----------------------------- */

function bindUiEvents() {
  ['library', 'playlist', 'search', 'queue'].forEach((v) => {
    const tab = $('tab-' + v);
    if (tab) tab.addEventListener('click', () => switchView(v));
  });

  const searchForm = $('music-search-form');
  if (searchForm) searchForm.addEventListener('submit', (e) => { e.preventDefault(); handleSearch(); });
  const searchBtn = $('music-search-btn');
  if (searchBtn) searchBtn.addEventListener('click', (e) => { e.preventDefault(); handleSearch(); });

  // Row interactions: play by default, fav / add via data-action buttons.
  const list = $('content-list');
  if (list) list.addEventListener('click', (e) => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    const track = currentItems()[index];
    if (!track) return;
    const actionEl = e.target.closest('[data-action]');
    const action = actionEl && actionEl.dataset.action;
    if (action === 'fav') { toggleFavorite(track); return; }
    if (action === 'add') { addToLibrary(track); return; }
    if (action === 'delete') { deleteTrack(track); return; }
    playFromContext(index);
  });

  // Account modal (avatar / account & settings menu)
  const userMenuBtn = $('btn-user-menu');
  if (userMenuBtn) userMenuBtn.addEventListener('click', openUserModal);
  const userClose = $('btn-user-close');
  if (userClose) userClose.addEventListener('click', closeUserModal);
  const userModal = $('modal-user');
  if (userModal) userModal.addEventListener('click', (e) => { if (e.target === userModal) closeUserModal(); });
  const userSignin = $('btn-user-signin');
  if (userSignin) userSignin.addEventListener('click', () => { closeUserModal(); openAuthModal(); });
  const userSignout = $('btn-user-signout');
  if (userSignout) userSignout.addEventListener('click', async () => {
    try { await authSignOut(auth); toast('Signed out'); } catch (_) {}
    closeUserModal();
  });

  // Auth modal
  const authClose = $('btn-auth-close');
  if (authClose) authClose.addEventListener('click', closeAuthModal);
  const authModal = $('modal-auth');
  if (authModal) authModal.addEventListener('click', (e) => { if (e.target === authModal) closeAuthModal(); });

  const btnGoogle = $('btn-auth-google');
  if (btnGoogle) btnGoogle.addEventListener('click', async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      closeAuthModal();
      toast('Signed in');
    } catch (err) { showAuthError(err); }
  });

  const authForm = $('form-auth-email');
  if (authForm) authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailEl = $('input-auth-email');
    const passEl = $('input-auth-password');
    const email = emailEl ? emailEl.value.trim() : '';
    const pass = passEl ? passEl.value : '';
    if (!email || !pass) return;
    try {
      await signInWithEmailAndPassword(auth, email, pass);
      closeAuthModal();
      toast('Signed in');
    } catch (err) { showAuthError(err); }
  });

  const themeBtn = $('theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
}

function boot() {
  syncMetaThemeColor();
  syncThemeUi();
  bindUiEvents();
  setupPlayer();
  setupMediaSession();
  document.addEventListener('visibilitychange', handleVisibility);
  document.addEventListener('pagehide', () => saveLastPlayed(true));
  updateSeekUi(0, 0);
  loadUnplayable();
  renderContent();
  startLibraryListener();
  startApiKeyListener();
  restoreLastPlayed();

  // Pre-warm the audio engine so the first tap starts playback instantly.
  ensurePlayer().then(() => updateVolIcon()).catch(() => {});

  onAuthStateChanged(auth, async (user) => {
    state.user = user || null;
    state.profile = user ? await fetchProfile(user.uid) : null;
    updateAuthUi();
    startPlaylistListener(user ? user.uid : null);
  });
}

// Global-first surface (matches the rest of the site: window.* helpers).
window.MusicApp = {
  state,
  switchView,
  playTrackList,
  nextTrack,
  prevTrack,
  togglePlayPause,
  addToLibrary,
  toggleFavorite
};

boot();
