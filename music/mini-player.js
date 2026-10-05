// =========================================================
// Hangout Music — Mini Player (main-site widget)
// A minimalist "my playlist + transport" panel for index.html. It reuses the
// full Music app's hidden YouTube audio engine and the same RTDB 3 store, but
// nothing else — no library, no search, no auth UI. Lazy-imported by the
// floating music button, so the shell only pays for it once someone taps it.
// =========================================================
import { auth, db3 } from '../js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { ref, onValue } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';
import { YouTubeAudioPlayer } from './youtube-player.js?v=7';

// Shared with the full Music app (same key + same shape), so a link that fails
// to embed once is remembered everywhere.
const UNPLAYABLE_KEY = 'hangout_music_unplayable';
const UNPLAYABLE_MAX = 100;

const MP_HTML = `
<div id="mini-music-modal" class="mp-overlay mp-off">
  <div class="mp-card">
    <header class="mp-head">
      <span class="mp-badge"><i class="fa-solid fa-music"></i></span>
      <div class="mp-head-text">
        <h3 class="mp-h3">My Playlist</h3>
        <p id="mini-music-count" class="mp-sub">Loading…</p>
      </div>
      <a href="music/" class="mp-icon-btn" title="Open the full Music app"><i class="fa-solid fa-up-right-from-square"></i></a>
      <button type="button" id="mini-music-close" class="mp-icon-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
    </header>

    <ul id="mini-music-list" class="mp-list"></ul>
    <div id="mini-music-empty" class="mp-empty mp-off"></div>

    <footer class="mp-foot">
      <div id="mini-music-now" class="mp-now">Nothing playing</div>
      <div class="mp-seek-row">
        <span id="mini-music-cur" class="mp-time">0:00</span>
        <input id="mini-music-seek" class="mp-seek" type="range" min="0" max="100" step="1" value="0" aria-label="Seek">
        <span id="mini-music-dur" class="mp-time">--:--</span>
      </div>
      <div class="mp-ctrls">
        <button type="button" id="mini-music-prev" class="mp-ctrl" title="Previous"><i class="fa-solid fa-backward-step"></i></button>
        <button type="button" id="mini-music-play" class="mp-ctrl mp-ctrl-main" title="Play / Pause"><i id="mini-music-play-icon" class="fa-solid fa-play"></i></button>
        <button type="button" id="mini-music-next" class="mp-ctrl" title="Next"><i class="fa-solid fa-forward-step"></i></button>
      </div>
    </footer>
  </div>
</div>
<div class="mp-yt" aria-hidden="true"><div id="mini-music-mount"></div></div>`;

const mp = {
  built: false,
  open: false,
  user: null,
  tracks: [],          // the signed-in user's saved playlist
  queue: [],           // snapshot the transport is walking through
  index: -1,
  unsubPlaylist: null,
  unsubAuth: null,
  unplayable: new Set(),
  skipStreak: 0,
  scrubbing: false
};

let player = null;

/* ------------------------------- helpers ------------------------------- */

const el = (id) => document.getElementById(id);

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function thumbFor(id) { return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; }

/** Reuse the site's toast when it is available. */
function notify(msg) {
  if (typeof window.showToast === 'function') window.showToast(msg);
  else console.info('[mini-player]', msg);
}

/**
 * Same volume preference the full Music app persists — maximum by default.
 * (An unset key must be checked explicitly: `Number(null)` is 0, not NaN.)
 */
function storedVolume() {
  const raw = localStorage.getItem('hangout_music_volume');
  if (raw === null) return 100;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}

function loadUnplayable() {
  try {
    const raw = JSON.parse(localStorage.getItem(UNPLAYABLE_KEY) || '[]');
    if (Array.isArray(raw)) mp.unplayable = new Set(raw.filter((id) => typeof id === 'string'));
  } catch (_) { /* private mode — ignore */ }
}

function markUnplayable(id) {
  if (!id || mp.unplayable.has(id)) return;
  mp.unplayable.add(id);
  try {
    localStorage.setItem(UNPLAYABLE_KEY, JSON.stringify([...mp.unplayable].slice(-UNPLAYABLE_MAX)));
  } catch (_) { /* ignore */ }
}

/* -------------------------- playlist cache --------------------------
   Same "instant first paint" idea as the chat apps' inbox cache: the
   signed-in user's normalized track list is mirrored to localStorage on
   every live snapshot and restored on auth/open, so the widget never
   waits on (or re-downloads) RTDB just to show what's already theirs. */
function loadPlaylistCache(uid) {
  try {
    const raw = localStorage.getItem(`hangout-playlist-${uid}`);
    if (!raw) return false;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return false;
    mp.tracks = arr.filter((t) => t && t.youtubeId);
    renderList(); // paint immediately; the live listener refreshes below
    return true;
  } catch (_) { return false; } // corrupted cache — wait on live data
}

function savePlaylistCache() {
  if (!mp.user) return;
  try {
    // Saved even when empty, so "no tracks" is cached truth too (no stale
    // resurrect after the user heart-removes everything).
    localStorage.setItem(`hangout-playlist-${mp.user.uid}`, JSON.stringify(mp.tracks));
  } catch (_) { /* private mode / quota — memory is best-effort */ }
}

/* ------------------------------- shell ------------------------------- */

function build() {
  if (mp.built) return;
  mp.built = true;

  // Injected rather than living in index.html: the widget is self-contained
  // and the shell only carries it once the floating button is actually used.
  const holder = document.createElement('div');
  holder.innerHTML = MP_HTML;
  while (holder.firstChild) document.body.appendChild(holder.firstChild);

  el('mini-music-modal').addEventListener('click', (e) => {
    if (e.target.id === 'mini-music-modal') closeModal();
  });
  el('mini-music-close').addEventListener('click', closeModal);

  el('mini-music-list').addEventListener('click', (e) => {
    const row = e.target.closest('.mp-row');
    if (row) playIndex(Number(row.dataset.index));
  });

  el('mini-music-play').addEventListener('click', toggle);
  el('mini-music-prev').addEventListener('click', () => step(-1));
  el('mini-music-next').addEventListener('click', () => step(1));

  const seek = el('mini-music-seek');
  seek.addEventListener('input', () => {
    mp.scrubbing = true;
    if (player) player.beginScrub();
    el('mini-music-cur').textContent = fmtTime(seek.value);
  });
  seek.addEventListener('change', () => {
    if (player) { player.seekTo(Number(seek.value)); player.endScrub(); }
    mp.scrubbing = false;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mp.open) closeModal();
  });

  loadUnplayable();
  watchAuth();
}

function openModal() {
  build();
  mp.open = true;
  el('mini-music-modal').classList.remove('mp-off');
  if (mp.user) {
    // Instant first paint: memory, then localStorage — no RTDB wait.
    if (!mp.tracks.length) loadPlaylistCache(mp.user.uid);
    if (mp.tracks.length) renderList();
    // Stay subscribed after the first open — never re-download per open.
    if (!mp.unsubPlaylist) watchPlaylist(mp.user.uid);
  }
  // paintSeek() no-ops while the widget is closed, so paint one fresh frame now.
  if (player && player.ready) paintSeek(player.getCurrentTime(), player.getDuration());
}

function closeModal() {
  mp.open = false;
  const modal = el('mini-music-modal');
  if (modal) modal.classList.add('mp-off');
}

/* ------------------------------- render ------------------------------- */

function renderEmpty(kind) {
  const box = el('mini-music-empty');
  const list = el('mini-music-list');
  if (!box || !list) return;

  if (!kind) {
    list.classList.remove('mp-off');
    box.classList.add('mp-off');
    return;
  }

  list.classList.add('mp-off');
  box.classList.remove('mp-off');

  if (kind === 'guest') {
    box.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i>
      <p>Sign in to see your playlist — the tracks you save with the heart in Hangout Music.</p>
      <button type="button" id="mini-music-signin">Sign in</button>`;
    const btn = el('mini-music-signin');
    if (btn) btn.addEventListener('click', () => {
      closeModal();
      const authModal = document.getElementById('auth-modal');
      if (authModal) authModal.classList.remove('hidden');
    });
  } else {
    box.innerHTML = `<i class="fa-solid fa-heart"></i>
      <p>No saved tracks yet. Open Hangout Music, find a song and tap the heart to save it here.</p>
      <a href="music/">Open Hangout Music</a>`;
  }
}

function renderList() {
  const list = el('mini-music-list');
  if (!list) return;

  if (!mp.tracks.length) {
    const count = el('mini-music-count');
    if (count) count.textContent = mp.user ? 'No saved tracks' : 'Not signed in';
    renderEmpty(mp.user ? 'empty' : 'guest');
    return;
  }

  renderEmpty(null);
  const count = el('mini-music-count');
  if (count) count.textContent = `${mp.tracks.length} saved track${mp.tracks.length === 1 ? '' : 's'}`;

  list.innerHTML = mp.tracks.map((t, i) => `
    <li class="mp-row${i === mp.index ? ' is-current' : ''}" data-index="${i}">
      <img class="mp-thumb" loading="lazy" src="${esc(t.thumbnail || thumbFor(t.youtubeId))}" alt=""
           onerror="this.onerror=null;this.src='${thumbFor(t.youtubeId)}'">
      <span class="mp-row-text">
        <span class="mp-title">${esc(t.title || 'Untitled')}</span>
        <span class="mp-artist">${esc(t.artist || 'Unknown artist')}</span>
      </span>
      <i class="mp-eq fa-solid fa-volume-high"></i>
    </li>`).join('');
}

/** Highlights the row that matches the current queue entry. */
function markRow() {
  const cur = mp.index >= 0 ? mp.queue[mp.index] : null;
  const id = cur ? cur.youtubeId : null;
  const list = el('mini-music-list');
  if (!list) return;
  list.querySelectorAll('.mp-row').forEach((row) => {
    const track = mp.tracks[Number(row.dataset.index)];
    row.classList.toggle('is-current', Boolean(id && track && track.youtubeId === id));
  });
}

/* ------------------------------- playback ------------------------------- */

function ensurePlayer() {
  if (!player) {
    player = new YouTubeAudioPlayer({
      mountId: 'mini-music-mount',
      volume: storedVolume(),
      onStateChange: () => {
        if (player.playing) mp.skipStreak = 0;
        updateTransport();
        markRow();
      },
      onEnded: () => step(1),
      onError: (code) => handleError(code),
      onTime: (t, d) => paintSeek(t, d)
    });
  }
  return player.init().catch((err) => {
    console.warn('[mini-player] audio engine failed:', err);
    notify('Could not load the audio engine');
    throw err;
  });
}

function paintSeek(current, duration) {
  // The engine ticks every 250ms even while this widget is closed (playback
  // continues in the background) — skip ALL DOM work until it's visible.
  // openModal() paints one fresh frame when it reopens.
  if (!mp.open) return;
  const dur = Number(duration) || (player ? player.getDuration() : 0) || 0;
  const cur = dur ? Math.min(Number(current) || 0, dur) : (Number(current) || 0);
  const seek = el('mini-music-seek');
  if (seek && !mp.scrubbing) {
    const maxStr = String(Math.max(1, Math.round(dur)));
    const valStr = String(Math.round(cur));
    // Write only on change: values are seconds-granular, so this drops DOM
    // mutations from 4/sec to ~1/sec while playing with the modal open.
    if (seek.max !== maxStr) seek.max = maxStr;
    if (seek.value !== valStr) seek.value = valStr;
  }
  const curText = fmtTime(cur);
  const curLabel = el('mini-music-cur');
  if (curLabel && curLabel.textContent !== curText) curLabel.textContent = curText;
  const durText = dur ? fmtTime(dur) : '--:--';
  const durLabel = el('mini-music-dur');
  if (durLabel && durLabel.textContent !== durText) durLabel.textContent = durText;
}

function updateTransport() {
  const playing = Boolean(player && player.playing);
  const icon = el('mini-music-play-icon');
  if (icon) icon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  const fab = document.getElementById('floating-music-btn');
  if (fab) fab.classList.toggle('is-playing', playing);
}

function loadTrack(track) {
  if (!track) return;
  const now = el('mini-music-now');
  if (now) now.textContent = `${track.title || 'Untitled'} · ${track.artist || 'Unknown artist'}`;
  updateTransport();
  markRow();
}

/** Plays a playlist row and loads the whole playlist as the queue. */
function playIndex(index) {
  if (!mp.tracks.length) return;
  mp.queue = mp.tracks.map((t) => ({ ...t }));
  mp.index = Math.max(0, Math.min(index, mp.queue.length - 1));
  mp.skipStreak = 0;
  const track = mp.queue[mp.index];
  loadTrack(track);
  ensurePlayer().then(() => player.play(track.youtubeId)).catch(() => {});
}

/** +1 / -1 through the queue, hopping over tracks already known to be dead. */
function step(dir) {
  if (!mp.queue.length) return;
  const n = mp.queue.length;
  let i = mp.index;
  for (let s = 1; s <= n; s += 1) {
    i = (((mp.index + dir * s) % n) + n) % n;
    if (!mp.unplayable.has(mp.queue[i].youtubeId)) break;
  }
  mp.index = i;
  const track = mp.queue[mp.index];
  loadTrack(track);
  ensurePlayer().then(() => player.play(track.youtubeId)).catch(() => {});
}

function toggle() {
  if (!mp.queue.length) {
    if (mp.tracks.length) { playIndex(0); return; }
    notify('No saved tracks yet');
    return;
  }
  ensurePlayer().then(() => player.toggle()).catch(() => {});
}

/** Same courteous behaviour as the full app: label the reason, then skip on. */
function handleError(code) {
  const track = mp.index >= 0 ? mp.queue[mp.index] : null;
  if (track) markUnplayable(track.youtubeId);

  const why = (code === 101 || code === 150) ? 'blocked from embedded players'
    : code === 100 ? 'removed or made private'
      : 'not playable here';
  notify(`“${track ? track.title : 'Track'}” skipped — ${why}`);

  if (!mp.queue.length) return;
  mp.skipStreak += 1;
  if (mp.skipStreak >= mp.queue.length) {
    mp.skipStreak = 0;
    notify('Nothing in your playlist can be embedded');
    updateTransport();
    return;
  }
  setTimeout(() => step(1), 1000);
}

/* ------------------------------- data ------------------------------- */

function watchAuth() {
  mp.unsubAuth = onAuthStateChanged(auth, (user) => {
    mp.user = user || null;
    if (user) {
      loadPlaylistCache(user.uid); // instant state, even before first open
      watchPlaylist(user.uid);
      return;
    }
    if (mp.unsubPlaylist) { mp.unsubPlaylist(); mp.unsubPlaylist = null; }
    mp.tracks = [];
    renderList();
  });
}

function watchPlaylist(uid) {
  if (mp.unsubPlaylist) mp.unsubPlaylist();
  mp.unsubPlaylist = onValue(ref(db3, `user_playlists/${uid}`), (snap) => {
    const val = snap.val() || {};
    mp.tracks = Object.keys(val).map((id) => {
      const t = val[id] || {};
      return {
        youtubeId: t.youtubeId || id,
        title: t.title || 'Untitled',
        artist: t.artist || 'Unknown artist',
        duration: Number(t.duration) || 0,
        thumbnail: t.thumbnail || thumbFor(id),
        addedAt: Number(t.addedAt) || 0
      };
    }).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    savePlaylistCache(); // mirror every snapshot so the next open is instant
    renderList();
  }, (err) => {
    console.warn('[mini-player] playlist read failed:', err);
    const count = el('mini-music-count');
    if (count) count.textContent = 'Could not load';
  });
}

/* ------------------------------- exports ------------------------------- */

export function openMiniPlayer() { openModal(); }
export function closeMiniPlayer() { closeModal(); }
export function toggleMiniPlayer() { mp.open ? closeModal() : openModal(); }

// Inline-handler surface, matching the rest of the site's global-first style.
window.MiniPlayer = { open: openMiniPlayer, close: closeMiniPlayer, toggle: toggleMiniPlayer };
