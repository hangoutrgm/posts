// ============================================================
// Arena — main controller
// Tabs: Lobbies · Tournaments · Brackets · Schedule · My Squads
// Data: tournaments/registrations/matches live in RTDB 3 (db3) with the
//       same "open rules + client-side guard" convention as Music.
//       Lobbies are READ from the main feed's sharded Firestores.
// ============================================================
import { auth, db, db3, fsdb, fsdb2, fsdb3 } from '../js/firebase-config.js';
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { ref, onValue, set, update, get, push, remove, increment } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';
import { collection, query, where, orderBy, limit, getDocs } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js';
import { FORMAT, generateBracket, decideMatch, isComplete, championOf, bracketRounds, roundRobinStandings, winsNeeded, resolveByes } from './bracket-engine.js';

const $ = (id) => document.getElementById(id);
const SUPER_ADMIN_UID = 'IrcAY3gUELNjiRUhMkr7muxNIpm2';

const state = {
  user: null,
  profile: null,      // /users/{uid} snapshot (role + mlbb)
  isMod: false,
  tournaments: {},     // tid -> tournament
  registrations: {},   // tid -> { uid -> registration }
  matches: {},         // tid -> { matchId -> match }
  lobbies: [],
  activeTab: 'lobbies',
  tFilter: 'all',
  regTid: null,
  picked: [],          // register modal: tagged teammates [{uid, name}]
  usersMap: null,      // uid -> /users record (for member search/validation)
  editTid: null,       // edit-modal target
  prizeTid: null,      // prize-modal target
  points: {}           // uid -> arena points (db3 /arena/points)
};

// ---- helpers ----------------------------------------------------------
function esc(v = '') {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ordinal(n) {
  n = Number(n) || 0;
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ============================================================
// INSTANT PAINT — localStorage snapshots (same discipline as the
// shared users cache): paint the last-known data synchronously at
// boot, then live listeners refresh it. Writes are debounced and
// quota-guarded; a corrupted/stale cache never blocks the app.
// ============================================================
const SNAP_KEY = 'hangout-arena-snap-v1';
const LOBBY_KEY = 'hangout-arena-lobbies-v1';
const PROF_KEY = 'hangout-arena-profile-v1';

/** Synchronously hydrate tournaments/registrations/matches/points + lobbies. */
function loadSnapshots() {
  try {
    const s = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    if (s && typeof s === 'object') {
      state.tournaments = s.t || {};
      state.registrations = s.r || {};
      state.matches = s.m || {};
      state.points = s.p || {};
    }
  } catch (e) { /* corrupted — start empty */ }
  try {
    const l = JSON.parse(localStorage.getItem(LOBBY_KEY) || 'null');
    if (Array.isArray(l)) state.lobbies = l;
  } catch (e) { /* corrupted — start empty */ }
}

let _snapTimer = null;
function saveSnapshot() {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({
      t: state.tournaments, r: state.registrations, m: state.matches, p: state.points
    }));
  } catch (e) { /* quota — skip gracefully */ }
}
/** Trailing-edge debounce: at most one snapshot write per 3s of activity. */
function scheduleSnapshot() {
  if (_snapTimer) return;
  _snapTimer = setTimeout(() => { _snapTimer = null; saveSnapshot(); }, 3000);
}
function saveLobbies() {
  try { localStorage.setItem(LOBBY_KEY, JSON.stringify(state.lobbies)); }
  catch (e) { /* quota — skip gracefully */ }
}

/** Instant paint: apply the cached /users/{uid} snapshot before the RTDB read lands. */
function applyCachedProfile(uid) {
  try {
    const c = JSON.parse(localStorage.getItem(PROF_KEY) || 'null');
    if (!c || c.uid !== uid || !c.p) return;
    state.profile = c.p;
    state.isMod = c.p.isAdmin === true || c.p.isMod === true || uid === SUPER_ADMIN_UID;
    document.querySelectorAll('.mod-only').forEach((el) => el.classList.toggle('hidden', !state.isMod));
    applyAuthUi(); // avatar + account menu paint immediately from cache
  } catch (e) { /* ignore */ }
}
window.toast = (msg) => {
  const t = $('arena-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2600);
};
window.toggleArenaTheme = () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.theme = dark ? 'dark' : 'light';
};

// ---- account menu (avatar dropdown: theme toggle + sign out) ----------
window.toggleArenaAcct = (e) => {
  if (e) e.stopPropagation();
  const menu = $('arena-acct-menu');
  if (!menu) return;
  const hidden = menu.classList.toggle('hidden');
  $('arena-avatar')?.setAttribute('aria-expanded', String(!hidden));
};
document.addEventListener('click', (e) => {
  const acct = $('arena-acct');
  if (!acct || acct.classList.contains('hidden')) return;
  if (!acct.contains(e.target)) $('arena-acct-menu')?.classList.add('hidden');
});

// ---- tabs -------------------------------------------------------------
function initTabs() {
  document.querySelectorAll('.arena-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.arena-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.arena-panel').forEach((p) => p.classList.add('hidden'));
      $('tab-' + state.activeTab).classList.remove('hidden');
      if (state.activeTab === 'brackets') renderBracketPicker();
      if (state.activeTab === 'schedule') renderSchedule();
      if (state.activeTab === 'rankings') renderRankings();
      if (state.activeTab === 'squads') renderSquads();
      if (state.activeTab === 'tournaments') renderTournaments();
    });
  });
  document.querySelectorAll('#tournament-filter .arena-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#tournament-filter .arena-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      state.tFilter = chip.dataset.filter;
      renderTournaments();
    });
  });
}

window.Arena = {};
window.closeModal = (id) => $(id)?.classList.add('hidden');
window.Arena.closeModal = window.closeModal;

// ---- dedicated prompt / notice modal (Promise-based; replaces window.confirm) ----
let _promptDone = null;
function arenaPrompt(message, { title = 'Please confirm', danger = false, notice = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('prompt-modal');
    if (!modal) return resolve(true); // fail-open if the markup is missing
    $('prompt-title').textContent = title;
    $('prompt-msg').textContent = message;
    $('prompt-ok').className = `a-btn ${danger ? 'a-btn--red' : 'a-btn--teal'} flex-1 justify-center`;
    $('prompt-ok').textContent = notice ? 'OK' : 'Confirm';
    $('prompt-cancel').classList.toggle('hidden', notice);
    _promptDone = (v) => {
      _promptDone = null;
      modal.classList.add('hidden');
      resolve(v);
    };
    modal.classList.remove('hidden');
  });
}
/** Confirm dialog — resolves true/false. */
window.Arena.confirm = (message, opts) => arenaPrompt(message, opts);
/** Single-OK notice dialog — resolves when dismissed. */
window.Arena.notice = (message, opts = {}) => arenaPrompt(message, { ...opts, notice: true, title: opts.title || 'Notice' });
window.Arena.promptOk = () => { if (_promptDone) _promptDone(true); };
window.Arena.promptClose = () => { if (_promptDone) _promptDone(false); };

// ---- tournament card overflow menu (⋯) ----
// On open the menu is PORTALED into <body>: the card's overflow:hidden clips
// descendants and its :hover transform makes it the containing block for
// position:fixed children — both make an in-card dropdown invisible. A body
// child has neither problem; stale copies from card re-renders are dropped.
window.Arena.toggleCardMenu = (tid, btn) => {
  document.querySelectorAll('.a-card-menu').forEach((m) => m.classList.add('hidden'));
  const fresh = $('card-menu-' + tid);
  if (!fresh) return;
  document.querySelectorAll('#card-menu-' + tid).forEach((el) => { if (el !== fresh) el.remove(); });
  const opening = fresh.classList.contains('hidden');
  fresh.classList.toggle('hidden');
  if (!opening || !btn) return;
  document.body.appendChild(fresh); // portal out of the clipping/transformed card
  const r = btn.getBoundingClientRect();
  fresh.style.top = (r.bottom + 6) + 'px';
  fresh.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  fresh.style.bottom = '';
  // Flip above the button when there isn't room below.
  if (r.bottom + 6 + fresh.offsetHeight > window.innerHeight - 8) {
    fresh.style.top = '';
    fresh.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  }
};
document.addEventListener('click', () => {
  document.querySelectorAll('.a-card-menu').forEach((m) => m.classList.add('hidden'));
});
window.addEventListener('scroll', () => {
  document.querySelectorAll('.a-card-menu').forEach((m) => m.classList.add('hidden'));
}, { passive: true });

// ---- auth -------------------------------------------------------------
window.ArenaAuth = () => {
  if (state.user) {
    signOut(auth).then(() => window.toast('Signed out.'));
  } else {
    $('signin-modal').classList.remove('hidden');
  }
};

window.Arena.emailSignIn = async () => {
  const email = $('si-email').value.trim(), pass = $('si-pass').value;
  const err = $('si-error');
  err.classList.add('hidden');
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    $('signin-modal').classList.add('hidden');
  } catch (e) {
    err.textContent = String(e?.message || e).replace('Firebase: ', '');
    err.classList.remove('hidden');
  }
};

window.Arena.googleSignIn = async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
    $('signin-modal').classList.add('hidden');
  } catch (e) {
    window.toast(String(e?.message || e).replace('Firebase: ', ''));
  }
};

function applyAuthUi() {
  const acct = $('arena-acct'), menu = $('arena-acct-menu'),
    img = $('arena-avatar-img'), initial = $('arena-avatar-initial'), ph = $('arena-avatar-ph'),
    nameEl = $('arena-acct-name'), itemIn = $('menu-signin'), itemOut = $('menu-signout');
  menu.classList.add('hidden');
  if (state.user) {
    const name = state.profile?.name || state.user.displayName || state.user.email || 'Player';
    nameEl.textContent = name;
    nameEl.classList.remove('hidden');
    itemIn.classList.add('hidden');
    itemOut.classList.remove('hidden');
    const raw = state.profile?.pic || state.user.photoURL || '';
    if (raw) {
      img.src = window.optAvatar ? window.optAvatar(raw, 96) : raw;
      img.classList.remove('hidden');
      initial.classList.add('hidden');
      ph.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      initial.textContent = name.charAt(0).toUpperCase();
      initial.classList.remove('hidden');
      ph.classList.add('hidden');
    }
  } else {
    nameEl.classList.add('hidden');
    itemIn.classList.remove('hidden');
    itemOut.classList.add('hidden');
    img.classList.add('hidden');
    initial.classList.add('hidden');
    ph.classList.remove('hidden');
  }
  acct.classList.remove('hidden');
}

/** Read /users/{uid} for role flags + MLBB gaming profile. */
function loadProfile(uid) {
  return get(ref(db, 'users/' + uid)).then((snap) => {
    state.profile = snap.val() || {};
    const p = state.profile;
    state.isMod = p.isAdmin === true || p.isMod === true || uid === SUPER_ADMIN_UID;
    document.querySelectorAll('.mod-only').forEach((el) => el.classList.toggle('hidden', !state.isMod));
    try { localStorage.setItem(PROF_KEY, JSON.stringify({ uid, p })); } catch (e) { /* quota — skip */ }
    applyAuthUi();
    return p;
  }).catch(() => { state.profile = {}; applyAuthUi(); return {}; });
}

// ---- profile verification guard ---------------------------------------
const GUARD_FIELDS = [
  ['ign', 'In-Game Name (IGN)', (m) => m.ign],
  ['gameId', 'Game ID', (m) => m.gameId],
  ['primaryRole', 'Primary Role', (m) => m.primaryRole]
];

/** Returns {ok, missing:[labels], mlbb}. */
function checkGamingProfile() {
  const m = state.profile?.mlbb || {};
  const missing = GUARD_FIELDS.filter(([, , get]) => !String(get(m) || '').trim()).map(([, label]) => label);
  return { ok: missing.length === 0, missing, mlbb: m };
}

window.Arena.openProfileSettings = () => {
  // Deep-link the main site straight to Edit Profile > Gaming.
  window.location.href = '../?edit=gaming';
};

/**
 * Gate for Register Team / Join Tournament.
 * Returns the MLBB profile when complete; otherwise shows the guard modal.
 */
function guardGamingProfile() {
  const res = checkGamingProfile();
  if (res.ok) return res.mlbb;
  const box = $('guard-missing');
  box.innerHTML = res.missing.map((l) =>
    `<p class="flex items-center gap-1.5 text-gray-600 dark:text-gray-300"><i class="fa-solid fa-circle-xmark text-red-400"></i>${esc(l)}</p>`
  ).join('');
  $('guard-modal').classList.remove('hidden');
  return null;
}
window.Arena.guardGamingProfile = guardGamingProfile;

// ============================================================
// 1. LOBBY BRIDGE — read Lobby posts from the main feed's 3 shards
// ============================================================
async function fetchLobbies() {
  const results = [];
  for (const fs of [fsdb, fsdb2, fsdb3]) {
    try {
      const q = query(collection(fs, 'community_posts'),
        where('category', '==', 'Lobby'), orderBy('timestamp', 'desc'), limit(15));
      const snap = await getDocs(q);
      snap.forEach((d) => results.push({ id: d.id, ...d.data() }));
    } catch (_) { /* shard may lack the index — skip */ }
  }
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  state.lobbies = results.filter((p) => p.isLobby && !p.isDeleted).slice(0, 30);
  renderLobbies();
  saveLobbies(); // instant paint on the next visit
}

function lobbyCard(post) {
  const l = post.lobby || {};
  const mode = String(l.mode || 'Ranked');
  const lookingFor = String(l.lookingFor || 'Duo');
  const rankReq = String(l.rankReq || 'Any');
  const roles = Array.isArray(l.roles) ? l.roles : [];
  const roomId = String(l.roomId || '').trim();
  const roomPass = String(l.roomPass || '').trim();
  const isCustom = mode === 'Custom';
  const idText = [String(l.gameId || '').trim(), l.server ? `(${l.server})` : ''].filter(Boolean).join(' ');
  const joins = (l.joins && typeof l.joins === 'object') ? l.joins : {};
  const joinCount = Object.keys(joins).length;
  const mine = state.user?.uid === post.authorId;
  const joined = !!(state.user && joins[state.user.uid]);

  const copyBtn = (val, label) => val
    ? `<button onclick="window.Arena.copyText('${esc(val)}')" class="a-btn a-btn--indigo a-btn--sm shrink-0"><i class="fa-solid fa-copy"></i>${label}</button>`
    : '';

  const action = mine
    ? `<span class="a-badge a-badge--gold"><i class="fa-solid fa-crown"></i>You are the host</span>`
    : (state.user
      ? (joined
        ? `<button onclick="window.Arena.leaveLobby('${esc(post.id)}','${esc(post._dbSource || 1)}')" class="a-btn a-btn--ghost a-btn--sm">Leave</button>`
        : `<button onclick="window.Arena.joinLobby('${esc(post.id)}','${esc(post._dbSource || 1)}')" class="a-btn a-btn--teal a-btn--sm"><i class="fa-solid fa-user-plus"></i>Join</button>`)
      : `<button onclick="document.getElementById('signin-modal').classList.remove('hidden')" class="a-btn a-btn--ghost a-btn--sm">Sign in</button>`);

  return `<div class="arena-card">
    <div class="flex items-center justify-between gap-2 mb-2">
        <div class="min-w-0">
            <p class="text-[9px] font-black uppercase tracking-widest text-teal-600 dark:text-teal-400">Looking for Group</p>
            <p class="text-xs font-extrabold uppercase text-gray-800 dark:text-gray-100 truncate">${esc(String(l.game || 'Mobile Legends: Bang Bang'))}</p>
        </div>
        <div class="flex gap-1.5 shrink-0">
            <span class="a-badge a-badge--slate">${esc(mode)}</span>
            <span class="a-badge a-badge--slate">${esc(lookingFor)}</span>
        </div>
    </div>
    <div class="grid grid-cols-2 gap-2 text-[11px] mb-2">
        <div class="bg-gray-50 dark:bg-slate-900/60 rounded-lg px-2 py-1.5">
            <p class="text-[9px] font-bold uppercase text-gray-400">Slots</p>
            <p class="font-extrabold text-gray-700 dark:text-gray-200">${esc(lookingFor)}${joinCount ? ` · ${joinCount} joined` : ''}</p>
        </div>
        <div class="bg-gray-50 dark:bg-slate-900/60 rounded-lg px-2 py-1.5">
            <p class="text-[9px] font-bold uppercase text-gray-400">Rank req</p>
            <p class="font-extrabold text-gray-700 dark:text-gray-200">${esc(rankReq)}</p>
        </div>
    </div>
    ${roles.length ? `<div class="flex flex-wrap gap-1 mb-2">${roles.map((r) => `<span class="text-[9px] font-bold text-indigo-600 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800/50 px-1.5 py-0.5 rounded-full">${esc(r)}</span>`).join('')}</div>` : ''}
    <div class="flex items-center justify-between gap-2 mb-2">
        <div class="min-w-0">
            <p class="text-[9px] font-bold uppercase text-gray-400">${isCustom ? 'Room' : 'Host Game ID'}</p>
            <p class="text-[11px] font-mono font-bold text-gray-700 dark:text-gray-200 truncate">${esc(isCustom ? (roomId || 'Not set') : idText)}</p>
        </div>
        ${copyBtn(isCustom ? roomId : idText, isCustom ? 'Copy Room' : 'Copy ID')}
    </div>
    ${isCustom && roomPass ? `<div class="flex items-center justify-between gap-2 mb-2"><div class="min-w-0"><p class="text-[9px] font-bold uppercase text-gray-400">Password</p><p class="text-[11px] font-mono font-bold text-gray-700 dark:text-gray-200 truncate">${esc(roomPass)}</p></div>${copyBtn(roomPass, 'Copy Pass')}</div>` : ''}
    <div class="flex justify-end">${action}</div>
  </div>`;
}

function renderLobbies() {
  const box = $('lobby-list');
  if (!box) return;
  if (!state.lobbies.length) {
    box.innerHTML = '<div class="a-empty"><i class="fa-solid fa-users-viewfinder"></i>No live lobbies right now.<br>Create one from the main feed (Create → Lobby).</div>';
    return;
  }
  box.innerHTML = state.lobbies.map(lobbyCard).join('');
}

window.Arena.copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); window.toast('Copied to clipboard'); }
  catch (_) { window.toast('Copy failed — long-press to copy'); }
};
window.Arena.loadLobbies = fetchLobbies;

// Resolve a post's home shard (posts carry _dbSource 1/2/3).
function shardDb(source) {
  const n = Number(source) || 1;
  return n === 2 ? fsdb2 : n === 3 ? fsdb3 : fsdb;
}

// Ban check — banned accounts cannot act in the Arena (flag from RTDB 1 /users,
// fetched into state.profile when the auth state resolves).
function isBannedUser() { return Boolean(state.user && state.profile && state.profile.isBanned === true); }

window.Arena.joinLobby = async (postId, source) => {
  if (!state.user) return $('signin-modal').classList.remove('hidden');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  const { updateDoc, doc, arrayUnion, deleteField } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
  try {
    await updateDoc(doc(shardDb(source), 'community_posts', postId), {
      [`lobby.joins.${state.user.uid}`]: { role: '', joinedAt: Date.now() }
    });
    window.toast('Joined the squad!');
    fetchLobbies();
  } catch (e) {
    window.toast('Could not join: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.leaveLobby = async (postId, source) => {
  if (!state.user) return;
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  const { updateDoc, doc, deleteField } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
  try {
    await updateDoc(doc(shardDb(source), 'community_posts', postId), {
      [`lobby.joins.${state.user.uid}`]: deleteField()
    });
    window.toast('You left the squad.');
    fetchLobbies();
  } catch (e) {
    window.toast('Could not leave: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

// ============================================================
// 2. TOURNAMENTS — RTDB 3 (/arena/*)
// ============================================================
function listenArena() {
  onValue(ref(db3, 'arena/tournaments'), (snap) => {
    state.tournaments = snap.val() || {};
    scheduleSnapshot();
    renderTournaments();
    renderBracketPicker();
    maybeOpenSharedTournament(); // shared /arena/?t=<id> link → spotlight the details
  });
  onValue(ref(db3, 'arena/registrations'), (snap) => {
    state.registrations = snap.val() || {};
    scheduleSnapshot();
    renderTournaments();
    renderSquads();
  });
  onValue(ref(db3, 'arena/matches'), (snap) => {
    state.matches = snap.val() || {};
    scheduleSnapshot();
    renderBracket();
    renderSchedule();
  });
  // Arena points (per-user totals) for the Rankings tab.
  onValue(ref(db3, 'arena/points'), (snap) => {
    state.points = snap.val() || {};
    scheduleSnapshot();
    if (state.activeTab === 'rankings') renderRankings();
  });
}

function tournamentStatus(t) {
  if (t.status === 'pending' || t.status === 'rejected' || t.status === 'open') return t.status;
  const ms = state.matches[t.id] || {};
  if (Object.keys(ms).length && isComplete(ms)) return 'completed';
  if (Object.keys(ms).length) return 'ongoing';
  return 'upcoming';
}

function regCount(tid) {
  return Object.keys(state.registrations[tid] || {}).length;
}

window.Arena.openCreateTournament = () => {
  if (!state.user) return $('signin-modal').classList.remove('hidden');
  const dateEl = $('ct-date'), timeEl = $('ct-time');
  if (dateEl && !dateEl.value) {
    const d = new Date(Date.now() + 24 * 3600 * 1000);
    dateEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (timeEl && !timeEl.value) timeEl.value = '20:00';
  $('create-modal').classList.remove('hidden');
};

window.Arena.createTournament = async () => {
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  const name = $('ct-name').value.trim();
  if (!name) return window.toast('Please enter a tournament name.');
  const dateVal = $('ct-date').value;
  const timeVal = $('ct-time').value;
  let startTime;
  if (dateVal && timeVal) {
    startTime = new Date(`${dateVal}T${timeVal}`).getTime();
  } else if (!dateVal && !timeVal) {
    startTime = Date.now() + 24 * 3600 * 1000;
  } else {
    return window.toast('Please pick both the start date and time.');
  }
  const durationHrs = Number($('ct-duration').value) > 0 ? Math.round(Number($('ct-duration').value)) : null;
  const maxTeams = Math.floor(Number($('ct-max').value));
  if (!maxTeams || maxTeams < 2) return window.toast('Enter max teams (2 or more).');
  const payload = {
    name,
    format: $('ct-format').value,
    series: $('ct-series').value,
    maxTeams,
    startTime,
    durationHrs,
    awardTop: Number($('ct-winners').value) || 3,
    prize: $('ct-prize').value.trim(),
    desc: $('ct-desc').value.trim(),
    status: 'pending',
    createdAt: Date.now(),
    createdBy: state.user.uid,
    createdByName: state.profile?.name || state.user.displayName || 'Player'
  };
  try {
    const newRef = push(ref(db3, 'arena/tournaments'));
    payload.id = newRef.key;
    await set(newRef, payload);
    $('create-modal').classList.add('hidden');
    $('ct-name').value = ''; $('ct-prize').value = ''; $('ct-desc').value = '';
    window.toast('Tournament submitted for approval.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.setStatus = async (tid, status) => {
  if (!state.isMod) return;
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  await update(ref(db3, 'arena/tournaments/' + tid), { status });
  window.toast('Status → ' + status);
};

// ---- host: set prizes + edit details (only before a bracket exists) ----
window.Arena.openPrizes = (tid) => {
  const t = state.tournaments[tid];
  if (!t) return;
  if (!state.user || t.createdBy !== state.user.uid) return window.toast('Only the host can set prizes.');
  if (tournamentStatus(t) === 'completed') return window.toast('The tournament is completed — prizes are locked.');
  state.prizeTid = tid;
  $('prize-tname').textContent = t.name;
  $('pt-prize').value = t.prize || '';
  // One prize row per awarded place (Top N from the tournament details):
  // monetary prize + arena points side by side.
  const n = Math.min(Math.max(Number(t.awardTop) || 3, 1), 5);
  const pr = t.prizes || {};
  const pp = t.points || {};
  $('pt-ranks').innerHTML = Array.from({ length: n }, (_, i) => {
    const rank = i + 1;
    return `<div>
        <label class="block text-[10px] font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">${ordinal(rank)} place</label>
        <div class="grid grid-cols-2 gap-2">
          <input type="text" data-rank="${rank}" maxlength="60" value="${esc(pr[rank] || '')}" placeholder="e.g. ${rank === 1 ? '500 stars' : rank === 2 ? '300 stars' : '100 stars'}" class="w-full bg-gray-50 dark:bg-slate-900 text-xs p-2.5 rounded-lg dark:text-white border border-gray-200 dark:border-slate-700 focus:outline-none">
          <input type="number" data-rankpts="${rank}" min="0" max="100000" value="${Number(pp[rank]) > 0 ? Number(pp[rank]) : ''}" placeholder="Arena points" class="w-full bg-gray-50 dark:bg-slate-900 text-xs p-2.5 rounded-lg dark:text-white border border-gray-200 dark:border-slate-700 focus:outline-none">
        </div>
      </div>`;
  }).join('');
  $('prize-modal').classList.remove('hidden');
};

window.Arena.savePrize = async () => {
  const tid = state.prizeTid;
  const t = state.tournaments[tid];
  if (!t || !state.user || t.createdBy !== state.user.uid) return window.toast('Only the host can set prizes.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  const prizes = {}, points = {};
  document.querySelectorAll('#pt-ranks input[data-rank]').forEach((inp) => {
    prizes[inp.dataset.rank] = inp.value.trim();
  });
  document.querySelectorAll('#pt-ranks input[data-rankpts]').forEach((inp) => {
    points[inp.dataset.rankpts] = Math.max(0, Math.min(100000, Math.floor(Number(inp.value) || 0)));
  });
  try {
    await update(ref(db3, 'arena/tournaments/' + tid), { prize: $('pt-prize').value.trim(), prizes, points });
    $('prize-modal').classList.add('hidden');
    window.toast('Prizes updated.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.openEdit = (tid) => {
  const t = state.tournaments[tid];
  if (!t) return;
  if (!state.user || t.createdBy !== state.user.uid) return window.toast('Only the host can edit this tournament.');
  if (hasBracket(tid)) return window.toast('The bracket is already built — details are locked.');
  state.editTid = tid;
  $('et-name').value = t.name || '';
  $('et-format').value = t.format || 'single';
  $('et-series').value = t.series || 'BO3';
  $('et-max').value = t.maxTeams || '';
  $('et-duration').value = t.durationHrs || '';
  $('et-winners').value = String(t.awardTop || 3);
  $('et-desc').value = t.desc || '';
  const d = t.startTime ? new Date(t.startTime) : null;
  $('et-date').value = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
  $('et-time').value = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  $('edit-modal').classList.remove('hidden');
};

window.Arena.saveEdit = async () => {
  const tid = state.editTid;
  const t = state.tournaments[tid];
  if (!t || !state.user || t.createdBy !== state.user.uid) return window.toast('Only the host can edit this tournament.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (hasBracket(tid)) return window.toast('The bracket is already built — details are locked.');
  const name = $('et-name').value.trim();
  if (!name) return window.toast('Please enter a tournament name.');
  const dateVal = $('et-date').value, timeVal = $('et-time').value;
  if (!dateVal || !timeVal) return window.toast('Please pick both the start date and time.');
  const startTime = new Date(`${dateVal}T${timeVal}`).getTime();
  const maxTeams = Math.floor(Number($('et-max').value));
  if (!maxTeams || maxTeams < 2) return window.toast('Enter max teams (2 or more).');
  const regN = regCount(tid);
  if (maxTeams < regN) return window.toast(`Max teams can't be below the ${regN} already registered.`);
  const durationHrs = Number($('et-duration').value) > 0 ? Math.round(Number($('et-duration').value)) : null;
  const payload = {
    name,
    format: $('et-format').value,
    series: $('et-series').value,
    maxTeams,
    startTime,
    durationHrs,
    awardTop: Number($('et-winners').value) || 3,
    desc: $('et-desc').value.trim()
  };
  try {
    await update(ref(db3, 'arena/tournaments/' + tid), payload);
    $('edit-modal').classList.add('hidden');
    window.toast('Tournament updated.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

// ---- host deletion request → mod/admin approval ----
window.Arena.requestDelete = async (tid) => {
  const t = state.tournaments[tid];
  if (!t || !state.user || t.createdBy !== state.user.uid) return window.toast('Only the host can delete this tournament.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (hasBracket(tid)) return window.toast('The bracket is already built — deletion is disabled.');
  if (!(await window.Arena.confirm(`Request deletion of "${t.name}"? A mod / admin must approve before it is removed.`, { title: 'Request deletion' }))) return;
  const name = state.profile?.name || state.user.displayName || state.user.email || 'Player';
  try {
    await update(ref(db3, 'arena/tournaments/' + tid), { deleteRequested: { by: state.user.uid, name, at: Date.now() } });
    window.toast('Deletion requested — waiting for mod / admin approval.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.cancelDelete = async (tid) => {
  const t = state.tournaments[tid];
  if (!t || !state.user || t.createdBy !== state.user.uid) return window.toast('Only the host can cancel this request.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  try {
    await update(ref(db3, 'arena/tournaments/' + tid), { deleteRequested: null });
    window.toast('Deletion request cancelled.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

/** Remove a tournament with its registrations (squads) and bracket. */
async function removeTournamentData(tid) {
  await Promise.all([
    remove(ref(db3, 'arena/tournaments/' + tid)),
    remove(ref(db3, 'arena/registrations/' + tid)),
    remove(ref(db3, 'arena/matches/' + tid))
  ]);
}

window.Arena.approveDelete = async (tid) => {
  const t = state.tournaments[tid];
  if (!t || !state.isMod) return window.toast('Only mods / admins can approve deletion.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (!t.deleteRequested) return window.toast('No deletion request on this tournament.');
  if (!(await window.Arena.confirm(`Permanently delete "${t.name}" with its registrations and bracket? This cannot be undone.`, { title: 'Approve deletion', danger: true }))) return;
  try {
    await removeTournamentData(tid);
    window.toast('Tournament deleted.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

/** Mods/admins can delete a COMPLETED tournament directly (no request flow). */
window.Arena.modDelete = async (tid) => {
  const t = state.tournaments[tid];
  if (!t || !state.isMod) return window.toast('Only mods / admins can delete tournaments.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (tournamentStatus(t) !== 'completed') return window.toast('Only completed tournaments can be deleted directly.');
  if (!(await window.Arena.confirm(`Delete completed tournament "${t.name}" with its bracket and registrations? This cannot be undone.`, { title: 'Delete tournament', danger: true }))) return;
  try {
    await removeTournamentData(tid);
    window.toast('Tournament deleted.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.rejectDelete = async (tid) => {
  const t = state.tournaments[tid];
  if (!t || !state.isMod) return window.toast('Only mods / admins can reject deletion.');
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (!t.deleteRequested) return window.toast('No deletion request on this tournament.');
  try {
    await update(ref(db3, 'arena/tournaments/' + tid), { deleteRequested: null });
    window.toast('Deletion request rejected.');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

// ============================================================
// 3. REGISTRATION — profile guard first, then team form
// ============================================================
// ---- teammate tagging: pick registered user accounts ----------------
function mlbbComplete(u) {
  const m = u && u.mlbb;
  if (!m) return false;
  return !!(String(m.ign || '').trim() && String(m.gameId || '').trim() && String(m.primaryRole || '').trim());
}

/** Load the /users table for search + validation (12h localStorage cache first). */
function ensureUsers() {
  if (state.usersMap && Object.keys(state.usersMap).length) return Promise.resolve(state.usersMap);
  const cache = window.usersCache;
  const cached = cache && cache.read ? cache.read() : null;
  if (cached && cache.isFresh && cache.isFresh(cached)) {
    state.usersMap = cached.users;
    return Promise.resolve(state.usersMap);
  }
  return get(ref(db, 'users')).then((snap) => {
    state.usersMap = snap.val() || {};
    if (cache && cache.write) cache.write(state.usersMap);
  }).catch(() => {
    if (cached) state.usersMap = cached.users; // fall back to stale snapshot
  });
}

function renderMemberChips() {
  const box = $('rm-chips');
  if (!box) return;
  box.innerHTML = state.picked.map((p, i) =>
    `<span class="a-pick-chip"><i class="fa-solid fa-user-check"></i>${esc(p.name)}<button type="button" onclick="window.Arena.unpickMember(${i})" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button></span>`
  ).join('');
  box.classList.toggle('hidden', !state.picked.length);
}

function renderMemberResults() {
  const box = $('rm-results'), input = $('rm-search');
  if (!box || !input) return;
  const q = input.value.trim().toLowerCase();
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const users = state.usersMap;
  if (!users || !Object.keys(users).length) {
    box.innerHTML = '<p class="a-pick-empty">Loading players…</p>';
    box.classList.remove('hidden');
    return;
  }
  const pickedUids = new Set(state.picked.map((p) => p.uid));
  const selfUid = state.user?.uid;
  const rows = Object.entries(users)
    .filter(([uid, u]) => u && uid !== selfUid && !pickedUids.has(uid))
    .filter(([, u]) => String(u.name || '').toLowerCase().includes(q))
    .slice(0, 8);
  if (!rows.length) {
    box.innerHTML = `<p class="a-pick-empty">No registered player matches “${esc(input.value.trim())}”.</p>`;
    box.classList.remove('hidden');
    return;
  }
  box.innerHTML = rows.map(([uid, u]) => {
    const name = u.name || 'Player';
    const pic = u.pic ? (window.optAvatar ? window.optAvatar(u.pic, 48) : u.pic) : '';
    const ava = pic
      ? `<img src="${esc(pic)}" alt="">`
      : `<span class="a-pick-init">${esc(name.charAt(0).toUpperCase())}</span>`;
    const ok = mlbbComplete(u);
    return `<button type="button" class="a-pick-item" onclick="window.Arena.pickMember('${esc(uid)}')">
        ${ava}<span class="truncate">${esc(name)}</span>
        <span class="a-pick-flag ${ok ? 'is-ok' : 'is-bad'}">${ok ? 'Profile ✓' : 'Profile ✗'}</span>
      </button>`;
  }).join('');
  box.classList.remove('hidden');
}

window.Arena.pickMember = (uid) => {
  if (state.picked.length >= 4) return window.toast('Team is full — max 4 tagged players.');
  if (!uid || uid === state.user?.uid || state.picked.some((p) => p.uid === uid)) return;
  const u = state.usersMap?.[uid];
  state.picked.push({ uid, name: u?.name || 'Player' });
  renderMemberChips();
  $('rm-search').value = '';
  $('rm-results').classList.add('hidden');
};

window.Arena.unpickMember = (i) => {
  state.picked.splice(i, 1);
  renderMemberChips();
};

window.Arena.openRegister = (tid) => {
  if (!state.user) return $('signin-modal').classList.remove('hidden');
  const t = state.tournaments[tid];
  if (!t) return;
  if (regCount(tid) >= t.maxTeams && !state.registrations[tid]?.[state.user.uid]) {
    return window.toast('This tournament is full.');
  }
  // Profile verification guard (requirement 2)
  const mlbb = guardGamingProfile();
  if (!mlbb) return; // guard modal shown

  state.regTid = tid;
  const existing = state.registrations[tid]?.[state.user.uid];
  $('rm-title').textContent = existing ? 'Update Team' : 'Register Team';
  $('rm-tournament').textContent = `${t.name} · ${fmtFormat(t.format)} · ${t.series} · ${regCount(tid)}/${t.maxTeams} teams`;
  // Auto-pull IGN + ID for the captain slot
  $('rm-ign').value = mlbb.ign || '';
  $('rm-id').value = [mlbb.gameId || '', mlbb.server ? `(${mlbb.server})` : ''].filter(Boolean).join(' ');
  $('rm-role').value = mlbb.primaryRole || '';
  $('rm-team').value = existing?.teamName || '';
  // Pre-fill tagged teammates (uid-tagged entries only; legacy free-text is re-tagged on edit)
  state.picked = (existing?.members || [])
    .filter((m) => m && typeof m === 'object' && m.uid)
    .map((m) => ({ uid: m.uid, name: m.name || 'Player' }));
  renderMemberChips();
  $('rm-search').value = '';
  $('rm-results').classList.add('hidden');
  ensureUsers().then(() => { if ($('rm-search').value.trim()) renderMemberResults(); });
  $('register-modal').classList.remove('hidden');
};

window.Arena.submitRegistration = async () => {
  const tid = state.regTid;
  const t = state.tournaments[tid];
  if (!tid || !t || !state.user) return;
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  const mlbb = guardGamingProfile();
  if (!mlbb) return;
  const teamName = $('rm-team').value.trim();
  if (!teamName) return window.toast('Please enter a team name.');

  // Teammates = tagged registered accounts; each must have a completed gaming profile.
  await ensureUsers();
  if (!state.usersMap || !Object.keys(state.usersMap).length) {
    return window.toast('Could not load players — check your connection and try again.');
  }
  const picked = state.picked.filter((p) => p.uid);
  for (const p of picked) {
    const u = state.usersMap?.[p.uid];
    if (!u) return window.toast(`${p.name} is not registered on the main site.`);
    if (!mlbbComplete(u)) return window.toast(`${p.name} must complete their gaming profile on the main site.`);
  }
  const members = picked.map((p) => {
    const m = state.usersMap[p.uid].mlbb || {};
    return { uid: p.uid, name: state.usersMap[p.uid].name || p.name, ign: m.ign || '', gameId: m.gameId || '', role: m.primaryRole || '' };
  });
  const reg = {
    uid: state.user.uid,
    teamName,
    captainName: state.profile?.name || state.user.displayName || 'Player',
    ign: mlbb.ign || '',
    gameId: mlbb.gameId || '',
    server: mlbb.server || '',
    role: mlbb.primaryRole || '',
    members,
    joinedAt: Date.now()
  };
  try {
    await set(ref(db3, `arena/registrations/${tid}/${state.user.uid}`), reg);
    $('register-modal').classList.add('hidden');
    window.toast('Registered! Good luck 🎮');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.leaveTournament = async (tid) => {
  if (!state.user) return;
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (!(await window.Arena.confirm('Leave this tournament? Your team registration will be removed.', { title: 'Leave tournament', danger: true }))) return;
  await set(ref(db3, `arena/registrations/${tid}/${state.user.uid}`), null);
  window.toast('You left the tournament.');
};

function fmtFormat(f) {
  return f === 'double' ? 'Double Elim' : f === 'rr' ? 'Round Robin' : 'Single Elim';
}

// ============================================================
// 4. RENDER — tournament hub cards (status, prize, count, countdown)
// ============================================================
const STATUS_BADGE = {
  pending:  ['a-badge a-badge--gold', 'Pending review'],
  rejected: ['a-badge a-badge--red', 'Rejected'],
  open:     ['a-badge a-badge--green', 'Registration open'],
  upcoming: ['a-badge a-badge--blue', 'Upcoming'],
  ongoing:  ['a-badge a-badge--violet', 'Ongoing'],
  completed:['a-badge a-badge--slate', 'Completed']
};

// ---- hero stat counters (driven by live RTDB data) ----
function renderHero() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const all = Object.values(state.tournaments);
  let total = 0;
  let live = 0;
  for (const t of all) {
    const s = tournamentStatus(t);
    if (s === 'pending' || s === 'rejected') continue;
    total++;
    if (s === 'ongoing') live++;
  }
  const matchCount = Object.values(state.matches).reduce((n, ms) => n + Object.keys(ms || {}).length, 0);
  set('hs-tournaments', total);
  set('hs-ongoing', live);
  set('hs-matches', matchCount);
}

function renderTournaments() {
  const box = $('tournament-list');
  if (!box) return;
  renderHero();
  const list = Object.values(state.tournaments)
    .filter((t) => {
      const s = tournamentStatus(t);
      // Pending/rejected are only visible to mods + the creator.
      if (s === 'pending' || s === 'rejected') {
        return state.isMod || (state.user && t.createdBy === state.user.uid);
      }
      const f = state.tFilter;
      return f === 'all' || f === s;
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); // newest posted first

  if (!list.length) {
    box.innerHTML = '<div class="a-empty" style="grid-column:1/-1"><i class="fa-solid fa-trophy"></i>No tournaments here yet.<br>Use Create to start one!</div>';
    return;
  }
  // Entrance animation only on the FIRST paint — replaying it on every
  // listener update made cards jump mid-session.
  const animate = !state._tPainted;
  box.innerHTML = list.map((t) => tournamentCard(t, animate)).join('');
  state._tPainted = true;
}

/** True once a bracket has been generated — details are locked from then on. */
function hasBracket(tid) {
  return !!(state.matches[tid] && Object.keys(state.matches[tid]).length);
}

function tournamentCard(t, animate = false) {
  const status = tournamentStatus(t);
  const [badgeCls, badgeLabel] = STATUS_BADGE[status] || STATUS_BADGE.upcoming;
  const count = regCount(t.id);
  const registered = !!(state.user && state.registrations[t.id]?.[state.user.uid]);

  let action = '';
  if (status === 'pending') {
    action = state.isMod
      ? `<button onclick="window.Arena.setStatus('${t.id}','open')" class="a-btn a-btn--green a-btn--sm">Approve</button>
         <button onclick="window.Arena.setStatus('${t.id}','rejected')" class="a-btn a-btn--red a-btn--sm">Reject</button>`
      : `<span class="a-badge a-badge--gold">Awaiting approval</span>`;
  } else if (status === 'rejected') {
    action = `<span class="a-badge a-badge--red">Rejected</span>`;
  } else if (status === 'open') {
    if (!registered) {
      action += `<button onclick="window.Arena.openRegister('${t.id}')" class="a-btn a-btn--teal a-btn--sm"><i class="fa-solid fa-user-plus"></i>Join Tournament</button>`;
    }
    if (state.isMod) {
      action += `<button onclick="window.Arena.closeRegistration('${t.id}')" class="a-btn a-btn--indigo a-btn--sm">Close &amp; build bracket</button>`;
    }
  } else {
    action = `<button onclick="window.Arena.viewBracket('${t.id}')" class="a-btn a-btn--indigo a-btn--sm">View bracket</button>`;
  }

  const champUid = status === 'completed' ? championOf(state.matches[t.id] || {}, t.format) : null;
  const champReg = champUid ? state.registrations[t.id]?.[champUid] : null;
  const live = status === 'ongoing';
  const detailsBtn = `<button onclick="window.Arena.viewDetails('${t.id}')" class="a-btn a-btn--ghost a-btn--sm"><i class="fa-solid fa-circle-info"></i>Details</button>`;
  const shareBtn = `<button onclick="window.Arena.shareTournament('${t.id}')" class="a-btn a-btn--ghost a-btn--sm"><i class="fa-solid fa-share-nodes"></i>Share</button>`;
  const isHost = !!(state.user && t.createdBy === state.user.uid);
  // Overflow menu — hosts' and registered players' extra actions live here so
  // the button row stays clean (Details / Share / Join / Close stay visible).
  const menuItems = [];
  if (status === 'open' && registered) {
    menuItems.push(`<button onclick="window.Arena.leaveTournament('${t.id}')" class="a-acct-item"><i class="fa-solid fa-right-from-bracket"></i>Leave tournament</button>`);
    menuItems.push(`<button onclick="window.Arena.openRegister('${t.id}')" class="a-acct-item"><i class="fa-solid fa-user-pen"></i>Edit team</button>`);
  }
  const done = status === 'completed';
  // Dedupe: a mod-host of a completed tournament gets ONE delete path only —
  // the direct mod delete (the banner handles any pending request instead).
  const canModDelete = state.isMod && done;
  if (isHost) {
    // Prizes are locked once the tournament completes.
    if (!done) {
      menuItems.push(`<button onclick="window.Arena.openPrizes('${t.id}')" class="a-acct-item"><i class="fa-solid fa-coins"></i>Prizes</button>`);
      if (!hasBracket(t.id)) {
        menuItems.push(`<button onclick="window.Arena.openEdit('${t.id}')" class="a-acct-item"><i class="fa-solid fa-pen"></i>Edit tournament</button>`);
      }
    }
    // Hosts may request deletion before the bracket AND after completion (mod approves).
    if ((!hasBracket(t.id) || done) && !canModDelete) {
      menuItems.push(t.deleteRequested
        ? `<button onclick="window.Arena.cancelDelete('${t.id}')" class="a-acct-item"><i class="fa-solid fa-xmark"></i>Cancel delete</button>`
        : `<button onclick="window.Arena.requestDelete('${t.id}')" class="a-acct-item is-danger"><i class="fa-solid fa-trash"></i>Delete tournament</button>`);
    }
  }
  if (canModDelete && !t.deleteRequested) {
    menuItems.push(`<button onclick="window.Arena.modDelete('${t.id}')" class="a-acct-item is-danger"><i class="fa-solid fa-trash"></i>Delete tournament (mod)</button>`);
  }
  const cardMenuBtn = menuItems.length
    ? `<button onclick="event.stopPropagation(); window.Arena.toggleCardMenu('${t.id}', this)" class="a-btn a-btn--ghost a-btn--sm" title="More actions" aria-label="More actions"><i class="fa-solid fa-ellipsis"></i></button>
       <div id="card-menu-${t.id}" class="hidden a-card-menu">${menuItems.join('')}</div>`
    : '';
  // Deletion-request banner (mod approve/reject stays here — contextual alert).
  const delBadge = t.deleteRequested
    ? `<div class="flex flex-wrap items-center justify-between gap-2 mt-3 rounded-lg bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 px-2.5 py-1.5">
         <p class="text-[10px] font-bold"><i class="fa-solid fa-trash mr-1"></i>Deletion requested by ${esc(t.deleteRequested.name || 'host')} — awaiting approval</p>
         ${state.isMod ? `<div class="flex gap-1.5">
             <button onclick="window.Arena.approveDelete('${t.id}')" class="a-btn a-btn--red a-btn--sm">Approve</button>
             <button onclick="window.Arena.rejectDelete('${t.id}')" class="a-btn a-btn--ghost a-btn--sm">Reject</button>
           </div>` : ''}
       </div>`
    : '';

  return `<div class="arena-card${animate ? ' a-rise' : ''}${live ? ' arena-card--live' : ''}">
    <div class="flex items-start justify-between gap-2 mb-3">
        <div class="min-w-0">
            <p class="text-sm font-extrabold text-gray-900 dark:text-white truncate" style="letter-spacing:-0.01em">${esc(t.name)}</p>
            <p class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">${fmtFormat(t.format)} · ${esc(t.series)} · by ${esc(t.createdByName || '—')}</p>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
            <span class="${badgeCls}">${badgeLabel}</span>
            ${cardMenuBtn}
        </div>
    </div>
    <div class="grid grid-cols-3 gap-1.5 text-center mb-3">
        <div class="a-tile">
            <p class="a-tile-label">Prize</p>
            <p class="a-tile-value gold truncate">${esc(t.prize || '—')}</p>
        </div>
        <div class="a-tile">
            <p class="a-tile-label">Teams</p>
            <p class="a-tile-value">${count}/${t.maxTeams}</p>
        </div>
        <div class="a-tile">
            <p class="a-tile-label">Starts</p>
            <p class="a-tile-value" data-countdown="${t.startTime || 0}">—</p>
        </div>
    </div>
    ${champReg ? `<p class="text-[11px] font-bold text-amber-600 dark:text-amber-400 mb-2 text-center"><i class="fa-solid fa-crown mr-1"></i>Champion: ${esc(champReg.teamName)}</p>` : ''}
    ${t.desc ? `<p class="text-[11px] text-gray-500 dark:text-gray-400 mb-2.5">${esc(t.desc)}</p>` : ''}
    ${delBadge}
    <div class="flex flex-wrap justify-end gap-1.5">${detailsBtn}${shareBtn}${action}</div>
  </div>`;
}

// ---- tournament details modal (info + registered teams/players) ----
/**
 * Share a tournament: the link spotlights the tournament's Details modal
 * (same idea as the main feed's post spotlight — /arena/?t=<id>).
 */
window.Arena.shareTournament = (tid) => {
  const t = state.tournaments[tid];
  if (!t) return;
  const url = `${location.origin}${location.pathname}?t=${encodeURIComponent(tid)}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => window.toast('Tournament link copied — paste it anywhere!'))
      .catch(() => window.toast(url));
  } else {
    window.toast(url);
  }
};

window.Arena.viewDetails = (tid) => {
  const t = state.tournaments[tid];
  if (!t) return;
  const status = tournamentStatus(t);
  const [, badgeLabel] = STATUS_BADGE[status] || STATUS_BADGE.upcoming;
  const regs = Object.values(state.registrations[tid] || {});
  const wins = winsNeeded(t.series);
  const tile = (label, value) => `<div class="a-tile"><p class="a-tile-label">${label}</p><p class="a-tile-value truncate">${value}</p></div>`;
  const startDate = t.startTime ? new Date(t.startTime) : null;
  const info = `<div class="grid grid-cols-2 gap-2">
      ${tile('Game', 'Mobile Legends')}
      ${tile('Format', esc(fmtFormat(t.format)))}
      ${tile('Series', `${esc(t.series)} · race to ${wins}`)}
      ${tile('Slots', `${regs.length}/${t.maxTeams} teams`)}
      ${tile('Date', startDate ? esc(startDate.toLocaleDateString()) : '—')}
      ${tile('Time', startDate ? esc(startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '—')}
      ${tile('Duration', t.durationHrs ? `${Number(t.durationHrs)} hr${Number(t.durationHrs) > 1 ? 's' : ''}` : '—')}
      ${tile('Prize', esc(t.prize || '—'))}
      ${tile('Winners', `Top ${Number(t.awardTop) || 3}`)}
      ${tile('Status', esc(badgeLabel))}
      ${tile('Host', esc(t.createdByName || '—'))}
    </div>`;
  const desc = t.desc
    ? `<div class="bg-gray-50 dark:bg-slate-900/60 rounded-lg p-3">
         <p class="text-[9px] font-black uppercase text-gray-400 mb-1">Details / rules</p>
         <p class="text-[11px] text-gray-600 dark:text-gray-300 leading-relaxed" style="white-space: pre-line">${esc(t.desc)}</p>
       </div>`
    : '';
  const teams = regs.length
    ? regs.map((r) => rosterList(tid, r)).join('')
    : '<div class="a-empty"><i class="fa-solid fa-people-group"></i>No teams registered yet.</div>';
  const pr = t.prizes || {}, pp = t.points || {};
  const rankKeys = [...new Set([
    ...Object.keys(pr).filter((k) => String(pr[k] || '').trim()),
    ...Object.keys(pp).filter((k) => Number(pp[k]) > 0)
  ])].sort((a, b) => Number(a) - Number(b));
  const prizeList = rankKeys.length
    ? `<div class="bg-gray-50 dark:bg-slate-900/60 rounded-lg p-3">
         <p class="text-[9px] font-black uppercase text-gray-400 mb-1">Prize breakdown</p>
         ${rankKeys.map((rank) => {
           const money = String(pr[rank] || '').trim();
           const ap = Number(pp[rank]) || 0;
           return `<p class="text-[11px] font-bold text-gray-700 dark:text-gray-200 flex items-center justify-between gap-2">
             <span>${ordinal(rank)} place</span>
             <span class="flex items-center gap-2 shrink-0">${money ? `<span class="text-amber-600 dark:text-amber-400"><i class="fa-solid fa-coins mr-1"></i>${esc(money)}</span>` : ''}${ap > 0 ? `<span class="text-indigo-500"><i class="fa-solid fa-shield-halved mr-1"></i>+${ap} AP</span>` : ''}</span>
           </p>`;
         }).join('')}
       </div>`
    : '';
  $('td-title').textContent = t.name;
  $('td-body').innerHTML = `${info}${desc}${prizeList}
    <p class="text-[10px] font-black uppercase tracking-wide text-gray-400">Registered teams &amp; players (${regs.length})</p>
    <div class="space-y-2">${teams}</div>`;
  $('tour-modal').classList.remove('hidden');
};

// ============================================================
// 5. BRACKET — generate on registration close, render, advance
// ============================================================
window.Arena.closeRegistration = async (tid) => {
  const t = state.tournaments[tid];
  if (!t || !state.isMod) return;
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  const regs = Object.values(state.registrations[tid] || {});
  if (regs.length < 2) return window.toast('Need at least 2 registered teams.');
  if (!(await window.Arena.confirm(`Close registration for "${t.name}" and build the bracket now? This starts the tournament.`, { title: 'Build bracket' }))) return;

  // Seeds = registration uids, shuffled for fairness.
  const teams = regs.map((r) => r.uid);
  for (let i = teams.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [teams[i], teams[j]] = [teams[j], teams[i]];
  }
  const { matches } = generateBracket({
    format: t.format, teams, startTime: t.startTime || Date.now(),
    roundGapMs: 30 * 60 * 1000, matchGapMs: 5 * 60 * 1000
  });
  // Resolve byes so one-sided first-round matches advance immediately.
  const seeded = resolveByes(matches, winsNeeded(t.series));

  try {
    await set(ref(db3, 'arena/matches/' + tid), seeded);
    await update(ref(db3, 'arena/tournaments/' + tid), { status: 'ongoing', closedAt: Date.now() });
    window.toast('Bracket generated — ' + Object.keys(seeded).length + ' matches.');
    window.Arena.viewBracket(tid);
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

window.Arena.viewBracket = (tid) => {
  document.querySelector('.arena-tab[data-tab="brackets"]')?.click();
  const sel = $('bracket-select');
  if (sel) { sel.value = tid; renderBracket(); }
};

function teamName(tid, uid) {
  if (!uid) return null;
  const r = state.registrations[tid]?.[uid];
  return r ? r.teamName : 'TBD';
}

/**
 * Final standings for a COMPLETED bracket, best first.
 * - Round Robin: existing points standings.
 * - Knockout: champion first, then teams ranked by how late they were
 *   eliminated (stage depth: wb < lb < gf, deeper round = later), ties by wins.
 */
function finalStandings(tid) {
  const t = state.tournaments[tid];
  const ms = state.matches[tid] || {};
  if (!t || !Object.keys(ms).length || !isComplete(ms)) return [];
  if (t.format === 'rr') {
    return roundRobinStandings(ms).map((r, i) => ({ uid: r.id, rank: i + 1 }));
  }
  const champ = championOf(ms, t.format);
  const stageBase = { wb: 0, lb: 1000, gf: 2000, rr: 0 };
  const info = new Map();
  for (const m of Object.values(ms)) {
    for (const uid of [m.slotA, m.slotB]) {
      if (uid && !info.has(uid)) info.set(uid, { uid, key: -1, wins: 0 });
    }
  }
  for (const m of Object.values(ms)) {
    if (m.status !== 'done' || !m.winner || !m.slotA || !m.slotB) continue;
    const loser = m.winner === m.slotA ? m.slotB : m.slotA;
    const wi = info.get(m.winner);
    if (wi) wi.wins++;
    const li = info.get(loser);
    if (li) li.key = Math.max(li.key, (stageBase[m.stage] ?? 0) + (Number(m.round) || 0));
  }
  const arr = [...info.values()];
  arr.sort((a, b) => {
    if (champ && a.uid === champ) return -1;
    if (champ && b.uid === champ) return 1;
    return (b.key - a.key) || (b.wins - a.wins);
  });
  return arr.map((x, i) => ({ uid: x.uid, rank: i + 1 }));
}

/** "🏆 Final standings" card — top N in order with each place's prize. */
function finalStandingsCard(tid, t) {
  const rows = finalStandings(tid);
  if (!rows.length) return '';
  const top = Math.min(Math.max(Number(t.awardTop) || 3, 1), rows.length);
  const prizes = t.prizes || {};
  const medals = ['🥇', '🥈', '🥉'];
  const list = rows.slice(0, top).map((r, i) => {
    const tName = state.registrations[tid]?.[r.uid]?.teamName || 'TBD';
    const prize = prizes[i + 1] || prizes[String(i + 1)] || '';
    const ap = Number((t.points || {})[i + 1]) || 0;
    const rankLabel = i < 3 ? medals[i] : `#${i + 1}`;
    const right = (prize || ap > 0)
      ? `<div class="flex items-center gap-1.5 shrink-0">
            ${prize ? `<span class="text-[10px] font-black text-amber-600 dark:text-amber-400"><i class="fa-solid fa-coins mr-1"></i>${esc(prize)}</span>` : ''}
            ${ap > 0 ? `<span class="text-[10px] font-black text-indigo-500"><i class="fa-solid fa-shield-halved mr-1"></i>+${ap} AP</span>` : ''}
         </div>`
      : '<span class="text-[10px] text-gray-400 shrink-0">—</span>';
    return `<div class="flex items-center justify-between gap-2 py-1.5${i > 0 ? ' border-t border-gray-100 dark:border-slate-700' : ''}">
        <div class="flex items-center gap-2 min-w-0">
            <span class="w-7 text-center text-sm shrink-0">${rankLabel}</span>
            <span class="text-[12px] font-bold text-gray-800 dark:text-gray-100 truncate">${esc(tName)}</span>
        </div>
        ${right}
    </div>`;
  }).join('');
  return `<div class="arena-card mb-3">
      <p class="text-[11px] font-extrabold uppercase tracking-wide text-amber-500 mb-1.5"><i class="fa-solid fa-trophy mr-1"></i>Final standings · top ${top}</p>
      ${list}
  </div>`;
}

function renderBracketPicker() {
  const sel = $('bracket-select');
  if (!sel) return;
  const current = sel.value;
  const ready = Object.values(state.tournaments)
    .filter((t) => state.matches[t.id] && Object.keys(state.matches[t.id]).length);
  sel.innerHTML = ready.length
    ? ready.map((t) => `<option value="${t.id}">${esc(t.name)} · ${fmtFormat(t.format)}</option>`).join('')
    : '<option value="">No brackets yet — close registration first</option>';
  if (current && ready.some((t) => t.id === current)) sel.value = current;
  sel.onchange = renderBracket;
  renderBracket();
}

function matchCard(tid, m, series) {
  const nameA = teamName(tid, m.slotA);
  const nameB = teamName(tid, m.slotB);
  const done = m.status === 'done';
  const winA = done && m.winner === m.slotA;
  const winB = done && m.winner === m.slotB;
  const ready = !!(m.slotA && m.slotB);
  const stageLabel = m.stage === 'wb' ? 'Winners' : m.stage === 'lb' ? 'Losers' : m.stage === 'gf' ? 'Grand Final' : 'Round Robin';

  const slot = (name, score, win) => `<div class="a-slot ${win ? 'win' : (done ? 'lose' : '')}">
      <span class="a-slot-name">${win ? '<i class="fa-solid fa-trophy" style="font-size:9px;margin-right:5px"></i>' : ''}${esc(name || 'TBD')}</span>
      <span class="a-slot-score">${done || score > 0 ? score : ''}</span>
    </div>`;

  return `<div class="a-match" data-ready="${ready ? 1 : 0}" data-done="${done ? 1 : 0}" onclick="window.Arena.openMatch('${tid}','${m.id}')">
      <div class="flex items-center justify-between mb-1.5" style="padding-left:2px">
          <span class="text-[9px] font-black uppercase" style="letter-spacing:.12em;color:var(--a-faint)">${stageLabel}</span>
          ${done ? '<span class="a-badge a-badge--green" style="padding:2px 7px;font-size:8.5px">Final</span>' : `<span class="text-[9px] font-black" style="color:var(--a-gold-1)">${esc(series)}</span>`}
      </div>
      ${slot(nameA, m.scoreA, winA)}
      ${slot(nameB, m.scoreB, winB)}
  </div>`;
}

function renderBracket() {
  const view = $('bracket-view');
  if (!view) return;
  const tid = $('bracket-select')?.value;
  const t = state.tournaments[tid];
  const ms = state.matches[tid];
  if (!tid || !t || !ms || !Object.keys(ms).length) {
    view.innerHTML = '<div class="a-empty"><i class="fa-solid fa-sitemap"></i>Select a tournament with a generated bracket.</div>';
    return;
  }
  const buckets = bracketRounds(ms);
  const roundLabel = (r, n) => {
    if (t.format === 'rr') return 'Matches';
    if (r === 0) return 'Round 1';
    return r === n - 1 ? 'Finals' : `Round ${r + 1}`;
  };

  const section = (title, rounds, color, stageRoundBase) => {
    const keys = Object.keys(rounds).map(Number).sort((a, b) => a - b);
    if (!keys.length) return '';
    const multi = keys.length > 1;
    return `<div class="mb-4">
        <h3 class="text-[11px] font-extrabold uppercase tracking-wide ${color} mb-2">${title}</h3>
        <div class="space-y-3">
        ${keys.map((r) => `
            <div>
                <p class="text-[10px] font-bold text-gray-400 mb-1">${roundLabel(r - stageRoundBase, keys.length)}</p>
                <div class="grid gap-2 ${multi ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}">
                    ${rounds[r].map((m) => matchCard(tid, m, t.series)).join('')}
                </div>
            </div>`).join('')}
        </div>
    </div>`;
  };

  let html = `<div class="arena-card mb-3">
      <p class="text-sm font-extrabold text-gray-900 dark:text-white">${esc(t.name)}</p>
      <p class="text-[10px] text-gray-500 dark:text-gray-400">${fmtFormat(t.format)} · ${esc(t.series)} · ${Object.keys(ms).length} matches${isComplete(ms) ? ' · <span class="text-emerald-500 font-bold">Completed</span>' : ''}</p>
  </div>`;
  if (isComplete(ms)) html += finalStandingsCard(tid, t);
  html += section('Winners Bracket', buckets.wb, 'text-indigo-500', 0);
  if (Object.keys(buckets.lb).length) html += section('Losers Bracket', buckets.lb, 'text-orange-500', 0);
  if (Object.keys(buckets.gf).length) html += section('Grand Final', buckets.gf, 'text-amber-500', 0);
  if (t.format === 'rr') html += section('Round Robin', buckets.rr, 'text-purple-500', 0);
  if (t.format === 'rr') html += standingsTable(tid, ms);
  view.innerHTML = html;
}

function standingsTable(tid, ms) {
  const rows = roundRobinStandings(ms);
  if (!rows.length) return '';
  return `<div class="arena-card">
    <p class="text-[11px] font-extrabold uppercase tracking-wide text-purple-500 mb-2">Standings</p>
    <table class="w-full text-[11px]">
      <thead><tr class="text-gray-400 text-left">
        <th class="py-1 font-bold">#</th><th class="font-bold">Team</th>
        <th class="font-bold text-center">W</th><th class="font-bold text-center">L</th><th class="font-bold text-center">Pts</th>
      </tr></thead>
      <tbody>
      ${rows.map((r, i) => `<tr class="border-t border-gray-100 dark:border-slate-700">
        <td class="py-1.5 font-black ${i === 0 ? 'text-amber-500' : 'text-gray-400'}">${i + 1}</td>
        <td class="font-bold text-gray-700 dark:text-gray-200 truncate">${esc(state.registrations[tid]?.[r.id]?.teamName || 'TBD')}</td>
        <td class="text-center font-bold text-emerald-500">${r.w}</td>
        <td class="text-center font-bold text-red-400">${r.l}</td>
        <td class="text-center font-black text-gray-700 dark:text-gray-200">${r.pts}</td>
      </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

// ============================================================
// 6. MATCH LOBBY — rosters, room reveal, score entry
// ============================================================
function rosterList(tid, reg) {
  if (!reg) return '<p class="text-[11px] text-gray-400 italic">TBD</p>';
  const idText = [reg.gameId, reg.server ? `(${reg.server})` : ''].filter(Boolean).join(' ');
  const captain = `<div class="flex items-center gap-2 py-1">
      <i class="fa-solid fa-crown text-amber-400 text-[10px]"></i>
      <span class="text-[11px] font-bold text-gray-700 dark:text-gray-200 truncate">${esc(reg.ign || reg.captainName)}</span>
      <span class="text-[9px] font-bold text-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 px-1.5 py-0.5 rounded">${esc(reg.role || '—')}</span>
      <span class="text-[10px] font-mono text-gray-400 ml-auto truncate">${esc(idText)}</span>
    </div>`;
  const members = (reg.members || []).map((raw) => {
    const m = typeof raw === 'string' ? { name: raw } : (raw || {});
    // Backfill game ID from the users cache for legacy member records.
    const mGameId = m.gameId || (m.uid && state.usersMap?.[m.uid]?.mlbb?.gameId) || '';
    return `<div class="flex items-center gap-2 py-1 pl-4">
        <i class="fa-solid fa-user text-gray-300 dark:text-gray-600 text-[9px]"></i>
        <span class="text-[11px] text-gray-600 dark:text-gray-300 truncate">${esc(m.name || '')}</span>
        ${m.ign && m.ign !== m.name ? `<span class="text-[9px] font-bold text-teal-600 dark:text-teal-400 truncate">${esc(m.ign)}</span>` : ''}
        ${mGameId ? `<span class="text-[10px] font-mono text-gray-400 ml-auto truncate">${esc(mGameId)}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="bg-gray-50 dark:bg-slate-900/60 rounded-lg px-2.5 py-1.5">
      <p class="text-[9px] font-black uppercase text-gray-400 mb-0.5">${esc(reg.teamName)}</p>
      ${captain}${members}
  </div>`;
}

window.Arena.openMatch = (tid, mid) => {
  const t = state.tournaments[tid];
  const m = state.matches[tid]?.[mid];
  if (!t || !m) return;
  const body = $('match-modal-body');
  const now = Date.now();
  const revealed = now >= (m.roomRevealAt || 0);
  const decided = m.status === 'done';
  const need = winsNeeded(t.series);

  const roomHtml = revealed
    ? (m.roomId
      ? `<div class="bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 rounded-lg p-3">
            <p class="text-[9px] font-black uppercase text-indigo-500 mb-1.5"><i class="fa-solid fa-door-open mr-1"></i>Custom Room</p>
            <div class="flex items-center justify-between gap-2 mb-1.5">
                <span class="text-xs font-mono font-extrabold text-gray-800 dark:text-gray-100">${esc(m.roomId)}</span>
                <button onclick="window.Arena.copyText('${esc(m.roomId)}')" class="a-btn a-btn--indigo a-btn--sm"><i class="fa-solid fa-copy"></i>Copy</button>
            </div>
            ${m.roomPass ? `<div class="flex items-center justify-between gap-2">
                <span class="text-xs font-mono font-extrabold text-gray-800 dark:text-gray-100">${esc(m.roomPass)}</span>
                <button onclick="window.Arena.copyText('${esc(m.roomPass)}')" class="a-btn a-btn--indigo a-btn--sm"><i class="fa-solid fa-copy"></i>Copy pass</button>
            </div>` : ''}
        </div>`
      : '<p class="text-[11px] text-gray-400 italic">No room has been set for this match yet.</p>')
    : `<div class="bg-gray-50 dark:bg-slate-900/60 border border-dashed border-gray-300 dark:border-slate-600 rounded-lg p-3 text-center">
        <p class="text-[10px] font-bold uppercase text-gray-400 mb-1"><i class="fa-solid fa-lock mr-1"></i>Room locked</p>
        <p class="text-xs font-extrabold text-gray-600 dark:text-gray-300" data-countdown="${m.roomRevealAt || 0}">—</p>
       </div>`;

  let reportHtml;
  const scoreA = Number(m.scoreA) || 0;
  const scoreB = Number(m.scoreB) || 0;
  if (decided) {
    reportHtml = `<p class="text-[11px] font-bold text-emerald-500"><i class="fa-solid fa-check mr-1"></i>Winner: ${esc(teamName(tid, m.winner) || '—')} (${m.scoreA}–${m.scoreB})</p>`;
  } else if (!m.slotA || !m.slotB) {
    reportHtml = '<p class="text-[11px] text-gray-400 italic"><i class="fa-solid fa-hourglass-half mr-1"></i>Waiting for both teams to reach this match.</p>';
  } else if (state.isMod) {
    const nameA = teamName(tid, m.slotA) || 'Team A';
    const nameB = teamName(tid, m.slotB) || 'Team B';
    reportHtml = `<div class="border-t border-gray-100 dark:border-slate-700 pt-3">
        <p class="text-[9px] font-black uppercase text-gray-400 mb-1.5"><i class="fa-solid fa-gavel mr-1"></i>Report round · ${esc(t.series)} (first to ${need})</p>
        <p class="text-center text-lg font-black text-gray-800 dark:text-gray-100 mb-2">${scoreA} <span class="text-gray-400">–</span> ${scoreB}</p>
        <div class="grid grid-cols-2 gap-2">
            <button onclick="window.Arena.reportRound('${tid}','${mid}','A')" class="a-btn a-btn--green justify-center truncate">${esc(nameA)}</button>
            <button onclick="window.Arena.reportRound('${tid}','${mid}','B')" class="a-btn a-btn--green justify-center truncate">${esc(nameB)}</button>
        </div>
        <p class="text-[10px] text-gray-400 mt-1">One click = one round win. The match ends when a team reaches ${need} — progress is live for everyone.</p>
       </div>`;
  } else if (scoreA + scoreB > 0) {
    reportHtml = `<p class="text-[11px] text-gray-500 dark:text-gray-400">Current round score: <b class="text-gray-800 dark:text-gray-100">${scoreA}–${scoreB}</b> — waiting for a moderator / admin to report the winner.</p>`;
  } else {
    reportHtml = '<p class="text-[11px] text-gray-400 italic"><i class="fa-solid fa-hourglass-half mr-1"></i>Waiting for a moderator / admin to report the winner.</p>';
  }

  body.innerHTML = `
    <p class="text-xs font-extrabold text-gray-800 dark:text-gray-100">${esc(t.name)} · ${fmtFormat(t.format)} · ${esc(t.series)}</p>
    <p class="text-[10px] text-gray-500" data-countdown="${m.scheduledAt || 0}">—</p>
    ${rosterList(tid, state.registrations[tid]?.[m.slotA])}
    <p class="text-center text-[10px] font-black text-gray-400">VS</p>
    ${rosterList(tid, state.registrations[tid]?.[m.slotB])}
    ${roomHtml}
    ${reportHtml}`;
  $('match-modal').classList.remove('hidden');
  tickCountdowns();
};

/**
 * Award arena points when a tournament completes.
 * Writes BOTH stores, mirroring how lbPoints works:
 *   - db3  /arena/points/{uid}   (arena's own node — Rankings source)
 *   - db1  users/{uid}/arenaPoints (user details mirror)
 * Recipients: every player of each awarded team (captain + tagged members).
 */
async function awardArenaPoints(tid) {
  try {
    const t = state.tournaments[tid];
    const rows = finalStandings(tid);
    if (!t || !rows.length) return;
    const ptsMap = t.points || {};
    const top = Math.min(Math.max(Number(t.awardTop) || 3, 1), rows.length);
    const gains = {};
    let total = 0;
    rows.slice(0, top).forEach((r, i) => {
      const gain = Math.max(0, Math.floor(Number(ptsMap[i + 1] || 0)));
      if (!gain) return;
      const reg = state.registrations[tid]?.[r.uid];
      if (!reg) return;
      const uids = [reg.uid];
      (reg.members || []).forEach((m) => { if (m && typeof m === 'object' && m.uid) uids.push(m.uid); });
      uids.forEach((u) => { gains[u] = (gains[u] || 0) + gain; total += gain; });
    });
    if (!total) return;
    const writes = [];
    for (const [uid, gain] of Object.entries(gains)) {
      writes.push(set(ref(db3, 'arena/points/' + uid), increment(gain)));
      writes.push(set(ref(db, 'users/' + uid + '/arenaPoints'), increment(gain)));
    }
    await Promise.all(writes.map((p) => p.catch((e) => console.warn('arena points write error:', e))));
    window.toast(`+${total} arena points awarded across ${Object.keys(gains).length} player(s).`);
  } catch (e) {
    console.warn('awardArenaPoints failed:', e);
  }
}

/** Record ONE round win — mods/admins only. The series ends at `need` wins. */
window.Arena.reportRound = async (tid, mid, side) => {
  const t = state.tournaments[tid];
  const ms = state.matches[tid] || {};
  if (!t) return;
  if (isBannedUser()) return window.toast('Your account is banned from Hangout.');
  if (!state.isMod) return window.toast('Only mods / admins can report results.');
  const m = ms[mid];
  if (!m || m.status === 'done') return window.toast('This match already has a result.');
  if (!m.slotA || !m.slotB) return window.toast('Both teams must reach this match first.');
  const need = winsNeeded(t.series);
  const a = (Number(m.scoreA) || 0) + (side === 'A' ? 1 : 0);
  const b = (Number(m.scoreB) || 0) + (side === 'B' ? 1 : 0);
  const seriesDone = a >= need || b >= need;
  let next;
  if (seriesDone) {
    try {
      next = decideMatch(ms, mid, a, b, t.series);
    } catch (e) {
      return window.toast(String(e.message));
    }
  } else {
    // Mid-series: save the round score only — everyone sees the progress live.
    next = JSON.parse(JSON.stringify(ms));
    next[mid].scoreA = a;
    next[mid].scoreB = b;
  }
  try {
    await set(ref(db3, 'arena/matches/' + tid), next);
    state.matches[tid] = next; // keep the local view in sync immediately
    if (!seriesDone) {
      window.toast(`Round recorded — ${a}–${b}`);
      window.Arena.openMatch(tid, mid); // refresh the modal score/buttons
      return;
    }
    if (isComplete(next)) {
      // Mark completed once; award arena points only on the FIRST completion
      // so a concurrent second reporter can never double-award.
      const snap = await get(ref(db3, 'arena/tournaments/' + tid));
      const rec = snap.val() || {};
      const first = !rec.awardedAt;
      await update(ref(db3, 'arena/tournaments/' + tid), first
        ? { status: 'completed', completedAt: Date.now(), awardedAt: Date.now() }
        : { status: 'completed', completedAt: rec.completedAt || Date.now() });
      const champ = championOf(next, t.format);
      const champName = teamName(tid, champ);
      window.toast('🏆 ' + (champName || 'Someone') + ' wins ' + t.name + '!');
      if (first) awardArenaPoints(tid); // fire-and-forget (catches internally)
    } else {
      window.toast('Series decided — winner advanced.');
    }
    $('match-modal').classList.add('hidden');
  } catch (e) {
    window.toast('Failed: ' + String(e?.message || e).replace('Firebase: ', ''));
  }
};

// ============================================================
// 7. SCHEDULE — my upcoming matches + room reveal countdowns
// ============================================================
function myTids() {
  if (!state.user) return [];
  return Object.keys(state.registrations).filter((tid) => state.registrations[tid]?.[state.user.uid]);
}

function renderSchedule() {
  const box = $('schedule-list');
  if (!box) return;
  if (!state.user) {
    box.innerHTML = '<p class="text-xs text-gray-400 italic">Sign in to see your match schedule.</p>';
    return;
  }
  const rows = [];
  for (const tid of myTids()) {
    const t = state.tournaments[tid];
    const ms = state.matches[tid] || {};
    if (!t) continue;
    for (const m of Object.values(ms)) {
      if (m.slotA === state.user.uid || m.slotB === state.user.uid) rows.push({ tid, t, m });
    }
  }
  rows.sort((x, y) => (x.m.scheduledAt || 0) - (y.m.scheduledAt || 0));
  if (!rows.length) {
    box.innerHTML = '<div class="a-empty"><i class="fa-solid fa-calendar-check"></i>No matches yet.<br>Join an open tournament and wait for the bracket.</div>';
    return;
  }
  box.innerHTML = rows.map(({ tid, t, m }) => {
    const oppUid = m.slotA === state.user.uid ? m.slotB : m.slotA;
    const opp = teamName(tid, oppUid) || 'TBD';
    const done = m.status === 'done';
    const revealed = Date.now() >= (m.roomRevealAt || 0);
    return `<div class="arena-card">
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <p class="text-xs font-extrabold text-gray-900 dark:text-white truncate">${esc(t.name)}</p>
        <span class="text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${done ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300'}">${done ? 'Final' : t.series}</span>
      </div>
      <p class="text-[11px] text-gray-500 dark:text-gray-400 mb-1">vs <span class="font-bold text-gray-700 dark:text-gray-200">${esc(opp)}</span></p>
      <div class="flex items-center justify-between gap-2">
        <p class="text-[11px] font-bold text-gray-600 dark:text-gray-300" ${done ? '' : `data-countdown="${m.scheduledAt || 0}"`}>${(done || ((Number(m.scoreA) || 0) + (Number(m.scoreB) || 0) > 0)) ? `${m.scoreA}–${m.scoreB}` : '—'}</p>
        ${!done && (m.slotA && m.slotB) ? `<span class="text-[10px] font-bold ${revealed ? 'text-indigo-500' : 'text-gray-400'}"><i class="fa-solid ${revealed ? 'fa-door-open' : 'fa-lock'} mr-1"></i>${revealed ? 'Room open' : 'Room locked'}</span>` : ''}
        <button onclick="window.Arena.openMatch('${tid}','${m.id}')" class="a-btn a-btn--indigo a-btn--sm">Open</button>
      </div>
    </div>`;
  }).join('');
  tickCountdowns();
}

// ============================================================
// 7b. RANKINGS — users by arena points (db3 /arena/points)
// ============================================================
function renderRankings() {
  const box = $('rankings-list');
  if (!box) return;
  ensureUsers().then(() => {
    const users = state.usersMap;
    if (!users || !Object.keys(users).length) {
      box.innerHTML = '<p class="a-pick-empty">Loading players…</p>';
      return;
    }
    const rows = Object.entries(state.points)
      .filter(([uid, p]) => Number(p) > 0
        && users[uid]
        && String(users[uid].mlbb?.ign || '').trim()
        && String(users[uid].mlbb?.gameId || '').trim())
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    if (!rows.length) {
      box.innerHTML = '<p class="a-pick-empty">No arena points awarded yet — win a tournament to enter the rankings.</p>';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    box.innerHTML = rows.map(([uid, p], i) => {
      const u = users[uid];
      const name = u.name || 'Player';
      const ign = String(u.mlbb.ign || '').trim();
      const gameId = String(u.mlbb.gameId || '').trim();
      const pic = u.pic ? (window.optAvatar ? window.optAvatar(u.pic, 48) : u.pic) : '';
      const ava = pic
        ? `<img src="${esc(pic)}" alt="">`
        : `<span class="a-pick-init">${esc(name.charAt(0).toUpperCase())}</span>`;
      return `<a href="../?profile=${esc(uid)}" class="a-pick-item">
          <span class="w-6 text-center text-xs font-black shrink-0">${i < 3 ? medals[i] : `#${i + 1}`}</span>
          ${ava}
          <span class="min-w-0 flex-1">
            <span class="block text-[12px] font-bold truncate">${esc(name)}</span>
            <span class="block text-[10px] text-gray-400 truncate">${esc(ign)} · ${esc(gameId)}</span>
          </span>
          <span class="a-pick-flag is-ok"><i class="fa-solid fa-shield-halved mr-1"></i>${Number(p)} AP</span>
        </a>`;
    }).join('');
  });
}

// ============================================================
// 8. MY SQUADS — tournaments I've registered a team for
// ============================================================
function renderSquads() {
  const box = $('squad-list');
  if (!box) return;
  if (!state.user) {
    box.innerHTML = '<p class="text-xs text-gray-400 italic">Sign in to see your squads.</p>';
    return;
  }
  const tids = myTids();
  if (!tids.length) {
    box.innerHTML = '<div class="a-empty"><i class="fa-solid fa-people-group"></i>You haven\'t registered a team yet.<br>Head to Tournaments → Join.</div>';
    return;
  }
  box.innerHTML = tids.map((tid) => {
    const t = state.tournaments[tid];
    const reg = state.registrations[tid]?.[state.user.uid];
    if (!t || !reg) return '';
    const status = tournamentStatus(t);
    const [bCls, bLabel] = STATUS_BADGE[status] || STATUS_BADGE.upcoming;
    return `<div class="arena-card">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="min-w-0">
            <p class="text-sm font-extrabold text-gray-900 dark:text-white truncate">${esc(reg.teamName)}</p>
            <p class="text-[10px] text-gray-500 dark:text-gray-400">${esc(t.name)} · ${fmtFormat(t.format)} · ${esc(t.series)}</p>
        </div>
        <span class="shrink-0 text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${bCls}">${bLabel}</span>
      </div>
      <div class="bg-gray-50 dark:bg-slate-900/60 rounded-lg px-2.5 py-1.5 mb-2">
        <p class="text-[9px] font-black uppercase text-gray-400 mb-0.5">Roster</p>
        <p class="text-[11px] font-bold text-gray-700 dark:text-gray-200">${esc(reg.ign)} <span class="font-mono font-normal text-gray-400">${esc([reg.gameId, reg.server ? `(${reg.server})` : ''].filter(Boolean).join(' '))}</span> <span class="text-indigo-500">· ${esc(reg.role)}</span></p>
        ${(reg.members || []).length ? `<p class="text-[10px] text-gray-500">${reg.members.map((m) => esc(typeof m === 'string' ? m : (m.name || ''))).filter(Boolean).join(' · ')}</p>` : ''}
      </div>
      <div class="flex justify-between items-center">
        <span class="text-[10px] font-bold text-gray-400">${regCount(tid)}/${t.maxTeams} teams</span>
        <div class="flex gap-1.5">
          <button onclick="window.Arena.viewBracket('${tid}')" class="a-btn a-btn--indigo a-btn--sm">Bracket</button>
          <button onclick="window.Arena.openScheduleTab()" class="a-btn a-btn--blue a-btn--sm">Schedule</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

window.Arena.openScheduleTab = () => document.querySelector('.arena-tab[data-tab="schedule"]')?.click();

// ============================================================
// 9. LIVE COUNTDOWNS (data-countdown = target ms)
// ============================================================
function fmtRemain(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const target = Number(el.dataset.countdown);
    if (!target) return;
    const diff = target - now;
    el.textContent = diff <= 0 ? 'Started' : fmtRemain(diff);
  });
}

// ============================================================
// 10. BOOT
// ============================================================
loadSnapshots();   // instant paint from the last visit's localStorage snapshot
renderTournaments();
renderRankings();  // draws from the points snapshot once the users cache lands
renderLobbies();   // painted from the cached lobby list; fetchLobbies refreshes below
// Shared /arena/?t=<id> link → spotlight that tournament's Details modal.
const sharedTid = new URLSearchParams(location.search).get('t');
let _sharedOpened = false;
function maybeOpenSharedTournament() {
  if (_sharedOpened || !sharedTid) return;
  if (!state.tournaments[sharedTid]) return;
  _sharedOpened = true;
  window.Arena.viewDetails(sharedTid);
}
maybeOpenSharedTournament();
initTabs();
listenArena();
fetchLobbies();
tickCountdowns();
setInterval(tickCountdowns, 1000);
// Teammate picker: search as you type + close results on outside click.
$('rm-search')?.addEventListener('input', renderMemberResults);
$('rm-search')?.addEventListener('focus', renderMemberResults);
document.addEventListener('click', (e) => {
  const box = $('rm-results');
  if (!box || box.classList.contains('hidden')) return;
  const t = e.target;
  if (t && t.closest && !t.closest('#rm-results') && !t.closest('#rm-search')) box.classList.add('hidden');
});
// Disable main-page scrolling while a modal is open — only the modal scrolls.
// Watches every modal overlay's class so no open/close call site needs changing.
const MODAL_IDS = ['guard-modal', 'create-modal', 'register-modal', 'match-modal', 'tour-modal', 'prize-modal', 'edit-modal', 'signin-modal', 'prompt-modal'];
function syncModalScrollLock() {
  const open = MODAL_IDS.some((id) => {
    const el = $(id);
    return el && !el.classList.contains('hidden');
  });
  document.documentElement.style.overflow = open ? 'hidden' : '';
}
const modalScrollObserver = new MutationObserver(syncModalScrollLock);
MODAL_IDS.forEach((id) => {
  const el = $(id);
  if (el) modalScrollObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
});
// Refresh lobby bridge periodically (README bandwidth discipline: 2 min).
setInterval(() => { if (state.activeTab === 'lobbies') fetchLobbies(); }, 120000);

onAuthStateChanged(auth, async (user) => {
  const changed = (user?.uid || null) !== (state.user?.uid || null);
  state.user = user || null;
  if (changed) {
    state.profile = null;
    state.isMod = false;
    document.querySelectorAll('.mod-only').forEach((el) => el.classList.add('hidden'));
  }
  // Sync the account menu/avatar IMMEDIATELY for both directions (sign-in and
  // sign-out) — before the async profile fetch — so no stale items linger.
  applyAuthUi();
  if (user) {
    applyCachedProfile(user.uid); // instant avatar/role from the cached snapshot
    await loadProfile(user.uid);
    // Re-run the guard-dependent views once the profile lands.
    renderTournaments();
    renderSquads();
    renderSchedule();
    renderLobbies(); // lobby Join buttons depend on state.user
  } else {
    renderTournaments();
    renderSquads();
    renderSchedule();
    renderLobbies();
  }
});

window.Arena.loadLobbies = fetchLobbies;














