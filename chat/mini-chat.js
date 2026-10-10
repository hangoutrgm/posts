// =========================================================
// Hangout Chat — Mini Chat (main-site widget)
// A minimalist "conversations + thread" panel for index.html, modelled on
// the music mini player: self-contained HTML injected on first open, and
// RTDB listeners that attach while the widget is open and detach on close
// (README bandwidth discipline). Auth + user identity come from the primary
// project (../js/firebase-config.js) — the SAME unversioned URL the feed's
// own modules import, so Firebase initializes exactly once.
//
// Scope is deliberately simple: read conversations, open a thread
// (text / image / voice / video inline), send text replies. Everything
// else (compose-new, search, typing, replies, games,
// media upload) stays in the full /chat app — linked from the header.
//
// Data contract is an EXACT replica of chat/js/app.js so both UIs stay in
// sync: push to chatMessages/{tid}, multi-path update of
// chatThreads/{tid}/last* + own chatInboxes entry, runTransaction on each
// peer's inbox entry (unreadCount +1), mark-read zeroes unreadCount.
// =========================================================
import { auth, db } from '../js/firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import {
  ref, onValue, push, update, get, set, runTransaction, query, limitToLast
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

const $ = (id) => document.getElementById(id);
const SUPER_ADMIN_UID = 'IrcAY3gUELNjiRUhMkr7muxNIpm2';

const MC_HTML = `
<div id="mini-chat-modal" class="mc-overlay mc-off">
  <div class="mc-card">
    <header class="mc-head">
      <button id="mc-back" type="button" class="mc-icon-btn mc-off" title="Back to conversations" aria-label="Back">
        <i class="fa-solid fa-arrow-left"></i>
      </button>
      <span id="mc-badge" class="mc-head-badge"><i class="fa-solid fa-comments"></i></span>
      <div class="mc-head-text">
        <h3 id="mc-title" class="mc-h3">Messages</h3>
        <p id="mc-sub" class="mc-sub">Loading…</p>
      </div>
      <span id="mc-streak" class="mc-streak mc-off" title="Chat streak"></span>
      <a href="chat/" class="mc-icon-btn" title="Open the full chat app" aria-label="Open full chat">
        <i class="fa-solid fa-up-right-from-square"></i>
      </a>
      <button id="mc-close" type="button" class="mc-icon-btn" title="Close" aria-label="Close">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </header>
    <div id="mc-list" class="mc-list"></div>
    <div id="mc-thread" class="mc-thread mc-off">
      <div id="mc-msgs" class="mc-msgs"></div>
      <div id="mc-ban-bar" class="mc-ban mc-off">🚫 You are banned from Hangout Chat.</div>
      <div id="mc-reply-banner" class="mc-banner mc-off">
        <i class="fa-solid fa-reply mc-banner-icon"></i>
        <span id="mc-reply-text" class="mc-banner-text"></span>
        <button id="mc-reply-cancel" type="button" class="mc-banner-x" title="Cancel reply" aria-label="Cancel reply"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div id="mc-edit-banner" class="mc-banner mc-edit mc-off">
        <i class="fa-solid fa-pen mc-banner-icon"></i>
        <span class="mc-banner-text">Editing message</span>
        <button id="mc-edit-cancel" type="button" class="mc-banner-x" title="Cancel edit" aria-label="Cancel edit"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <form id="mc-form" class="mc-form" autocomplete="off">
        <input id="mc-input" class="mc-input" type="text" placeholder="Message…" maxlength="1500" aria-label="Message">
        <button id="mc-send" class="mc-send" type="submit" title="Send" aria-label="Send">
          <span id="mc-emoji" class="mc-emoji mc-off">😊</span>
          <i id="mc-plane" class="fa-solid fa-paper-plane"></i>
        </button>
      </form>
    </div>
    <div id="mc-menu" class="mc-menu mc-off" role="menu"></div>
  </div>
</div>`;

// Same placeholder the full app injects when the thread is missing from the
// user's inbox (chat/js/app.js handleInbox) — keeps announcements visible.
const ANNOUNCE_PLACEHOLDER = {
  isGroup: true,
  name: '📢 Global Announcements',
  pic: 'https://api.dicebear.com/7.x/bottts/svg?seed=announcements&backgroundColor=transparent',
  lastMessage: 'Welcome to Announcements',
  lastTimestamp: 0,
  unreadCount: 0,
  members: {},
  creatorId: 'admin'
};

// Same 5 quick reactions as chat/js/app.js (full-app parity).
const REACTIONS = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', sad: '😢' };

// Messenger-style send button — SAME constants and localStorage key as
// chat/js/app.js, so the preferred emoji is shared with the full chat app.
const PREFERRED_EMOJI_KEY = 'hangout-preferred-emoji';
const EMOJI_CHOICES = ['😊','😍','🥰','😂','🤣','😎','🥳','🤗','😢','😡','👍','🙏','🎉','❤️','🔥','💯'];
const EXTRA_EMOJIS = [
  '😁','😅','😉','😇','🙃','😘','😭','😮',
  '😴','🤩','🤔','😐','🙄','😱','🥺','😤',
  '👌','👏','💪','🤝','✌️','✨','⭐','💔'
];
function getPreferredEmoji() { try { return localStorage.getItem(PREFERRED_EMOJI_KEY) || '😊'; } catch (e) { return '😊'; } }
function setPreferredEmoji(emoji) { try { localStorage.setItem(PREFERRED_EMOJI_KEY, emoji); } catch (e) {} updateSendMode(); }

// Streak date/path helpers — replicas of chat/js/app.js so both UIs read and
// write ONE chatStreaks node (groups use groupStreak, DMs use the uid key).
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function streakPath(tid) {
  const isGroup = Boolean(mc.inbox[tid]?.isGroup || tid.startsWith('group_') || tid === 'global_announcements');
  return isGroup ? `chatStreaks/${tid}/groupStreak` : `chatStreaks/${tid}/${mc.user?.uid}`;
}

// Timestamp until which bubble-taps are ignored — set when long-press /
// right-click opens the menu, so the release tap doesn't immediately close
// it again (same guard the full app uses for its long-press menu).
let menuGuardUntil = 0;

const mc = {
  built: false,
  open: false,
  ready: false,          // first inbox snapshot arrived
  user: null,
  inbox: {},             // tid -> summary (mirrors the full app's state.inbox)
  showThread: false,
  tid: null,
  messages: {},          // msgId -> message (active thread, last 30)
  clears: {},            // tid -> clearTimestamp (chatClears/{uid})
  stopInbox: null,
  stopMessages: null,
  stopClears: null,
  threadStops: {},       // tid -> unsubscribe for chatThreads child watchers
  replyTo: null,         // preview payload of the message being replied to
  editMid: null,         // msgId currently being edited via the composer
  menuMid: null,         // msgId whose action menu is open
  touchStartXY: null,    // scroll-guard: touch origin for the tap-vs-drag check
  lastListHtml: '',
  lastMsgHtml: '',
  msgsPainted: false,
  streaks: {},           // tid -> streak data (shared hangout-streaks-{uid} cache)
  stopStreak: null,      // live chatStreaks listener for the open thread
  emojiMode: false,      // send button is currently showing the preferred emoji
  lastBadgeHtml: '',     // header badge markup (skip rewrite when unchanged)
  unsubAuth: null
};

/* ------------------------------- helpers ------------------------------- */

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function notify(msg) {
  if (typeof window.showToast === 'function') window.showToast(msg);
  else console.info('[mini-chat]', msg);
}

// Same convention as chat/js/app.js: today -> clock time, else short date.
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Read-only: the feed already maintains window.onlineUsers via its presence
// child listeners — no new listeners needed here.
function isOnline(uid) {
  const p = window.onlineUsers?.[uid];
  return p === true || Boolean(p && typeof p === 'object' && Object.keys(p).length > 0);
}

function userName(uid) {
  return window.globalUsersCache?.[uid]?.name || 'Member';
}

// Same peer rule as chat/js/app.js getThreadPeers.
function threadPeers(item) {
  if (item.isGroup) return Object.keys(item.members || {}).filter((u) => u !== mc.user?.uid);
  return item.peerId ? [item.peerId] : [];
}

// Same name fallback chain as getThreadName (thread name -> per-thread
// nicknames -> real names).
function nameOf(tid, item) {
  if (tid === 'global_announcements') return item.name || ANNOUNCE_PLACEHOLDER.name;
  const nick = (uid) => (item.nicknames && item.nicknames[uid]) || userName(uid);
  if (item.isGroup) {
    if (item.name) return item.name;
    const peers = threadPeers(item);
    return peers.length ? peers.map(nick).join(', ') : 'Group';
  }
  if (item.peerId === mc.user?.uid) return 'Notes (Me)';
  return nick(item.peerId);
}

// Sender label inside group threads — nicknames first, like getNickname.
function senderName(uid) {
  const nick = mc.inbox[mc.tid]?.nicknames?.[uid];
  return nick || userName(uid);
}

function avatarHtml(tid, item) {
  if (item.isGroup) {
    if (item.pic) return `<img class="mc-ava" src="${esc(item.pic)}" alt="">`;
    return `<span class="mc-ava mc-ava-fallback">👥</span>`;
  }
  if (item.peerId === mc.user?.uid) return `<span class="mc-ava mc-ava-fallback">📝</span>`;
  const u = window.globalUsersCache?.[item.peerId] || {};
  const pic = u.pic ? (window.optAvatar ? window.optAvatar(u.pic, 100) : u.pic) : '';
  if (pic) return `<img class="mc-ava" src="${esc(pic)}" alt="">`;
  const initial = esc((userName(item.peerId) || '?').charAt(0).toUpperCase());
  return `<span class="mc-ava mc-ava-fallback">${initial}</span>`;
}

// Admin gates — replicas of the full app's isSiteAdmin / announcements rules.
function isSiteAdmin(uid) {
  return uid === SUPER_ADMIN_UID || window.globalUsersCache?.[uid]?.isAdmin === true;
}

function linkify(escapedText) {
  return escapedText.replace(/https?:\/\/[^\s<]+/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

/* --------------------- messenger-style send button --------------------- */

function updateSendMode() {
  const btn = $('mc-send');
  if (!btn) return;
  const emoji = $('mc-emoji');
  const plane = $('mc-plane');
  const input = $('mc-input');
  const empty = !(input?.value || '').trim();
  mc.emojiMode = empty;
  btn.classList.toggle('emoji-mode', empty);
  if (emoji) { emoji.textContent = getPreferredEmoji(); emoji.classList.toggle('mc-off', !empty); }
  if (plane) plane.classList.toggle('mc-off', empty);
  const label = empty ? 'Tap to send your emoji — long-press to change it' : 'Send';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

/* Preferred-emoji popover — simplified twin of the full app's picker (same
   choices, same "+"/"−" extra set, same localStorage key). Painted once. */
let _emojiPop = null;
let _emojiPopAnchor = null;
let _emojiPopExpanded = false;

function emojiRowHtml() {
  const btn = (e) => `<button type="button" data-emoji="${e}">${e}</button>`;
  return EMOJI_CHOICES.map(btn).join('')
    + `<span class="mc-emoji-extra">${EXTRA_EMOJIS.map(btn).join('')}</span>`
    + `<button type="button" class="mc-emoji-more" data-more="1" aria-label="More emojis" title="More emojis">+</button>`;
}

function positionEmojiPop() {
  if (!_emojiPop || !_emojiPopAnchor) return;
  _emojiPop.classList.remove('mc-off');
  const r = _emojiPopAnchor.getBoundingClientRect();
  const pw = _emojiPop.offsetWidth || 250;
  const ph = _emojiPop.offsetHeight || 120;
  const x = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - 8));
  let y = r.top - ph - 8;
  if (y < 8) y = r.bottom + 8;
  _emojiPop.style.left = `${x}px`;
  _emojiPop.style.top = `${y}px`;
}

function applyEmojiExpanded() {
  if (!_emojiPop) return;
  _emojiPop.classList.toggle('expanded', _emojiPopExpanded);
  const toggle = _emojiPop.querySelector('.mc-emoji-more');
  if (!toggle) return;
  toggle.textContent = _emojiPopExpanded ? '−' : '+';
}

function closeEmojiPicker() {
  if (!_emojiPop) return;
  _emojiPop.classList.add('mc-off');
  _emojiPopExpanded = false;
  applyEmojiExpanded();
}

function openEmojiPicker(anchor) {
  if (!_emojiPop) {
    _emojiPop = document.createElement('div');
    _emojiPop.className = 'mc-emoji-pop mc-off';
    _emojiPop.innerHTML = emojiRowHtml(); // painted once, never rebuilt
    _emojiPop.addEventListener('mousedown', (e) => e.preventDefault()); // keep composer focus
    _emojiPop.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.more) {
        _emojiPopExpanded = !_emojiPopExpanded;
        applyEmojiExpanded();
        positionEmojiPop();
        return;
      }
      if (!btn.dataset.emoji) return;
      setPreferredEmoji(btn.dataset.emoji);
      closeEmojiPicker();
      notify('Preferred emoji updated!');
    });
    document.body.appendChild(_emojiPop);
    document.addEventListener('click', (e) => {
      if (!_emojiPop || _emojiPop.classList.contains('mc-off')) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      const inside = path ? path.includes(_emojiPop) : _emojiPop.contains(e.target);
      if (inside || e.target.closest('#mc-send')) return;
      closeEmojiPicker();
    });
  }
  _emojiPopAnchor = anchor;
  _emojiPopExpanded = false;
  applyEmojiExpanded();
  positionEmojiPop();
}

/* ------------------------------- shell ------------------------------- */

function build() {
  if (mc.built) return;
  mc.built = true;

  const holder = document.createElement('div');
  holder.innerHTML = MC_HTML;
  while (holder.firstChild) document.body.appendChild(holder.firstChild);

  $('mini-chat-modal').addEventListener('click', (e) => {
    if (e.target.id !== 'mini-chat-modal') return;
    // Tapping the scrim while the menu is open only dismisses the menu.
    if (mc.menuMid) { closeMsgMenu(); return; }
    close();
  });
  $('mc-close').addEventListener('click', close);
  $('mc-back').addEventListener('click', backToList);

  // One delegated listener covers sign-in CTA + conversation rows.
  $('mc-list').addEventListener('click', (e) => {
    if (e.target.id === 'mc-signin') {
      close();
      document.getElementById('auth-modal')?.classList.remove('hidden');
      return;
    }
    const row = e.target.closest('.mc-row');
    if (row) openThread(row.dataset.tid);
  });

  $('mc-form').addEventListener('submit', send);
  $('mc-reply-cancel').addEventListener('click', clearReply);
  $('mc-edit-cancel').addEventListener('click', cancelEdit);

  // Messenger-style send button (replica of chat/js/app.js): empty composer →
  // preferred emoji, typing → paper plane; long-press / right-click the emoji
  // opens the preferred-emoji picker. Same touch-vs-click guards as the full
  // app so a long-press never also submits.
  $('mc-input').addEventListener('input', updateSendMode);
  const sendBtn = $('mc-send');
  let pressTimer = null;
  let longPressed = false;
  let emojiTap = false; // emoji-mode as it was when the tap STARTED (see touchend)
  sendBtn.addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep composer focus (keyboard stays up)
    longPressed = false;
    if (mc.emojiMode) pressTimer = setTimeout(() => { longPressed = true; openEmojiPicker(sendBtn); }, 500);
  });
  sendBtn.addEventListener('mouseup', () => clearTimeout(pressTimer));
  sendBtn.addEventListener('click', (e) => {
    if (longPressed) { e.preventDefault(); e.stopPropagation(); longPressed = false; }
  });
  sendBtn.addEventListener('contextmenu', (e) => {
    if (!mc.emojiMode) return;
    e.preventDefault();
    openEmojiPicker(sendBtn);
  });
  sendBtn.addEventListener('touchstart', (e) => {
    if (e.cancelable) e.preventDefault(); // suppress the synthetic click — we drive submit below
    longPressed = false;
    emojiTap = mc.emojiMode; // capture mode at tap start — an edit-save below mutates it
    if (sendBtn.disabled) return;
    if (mc.emojiMode) {
      pressTimer = setTimeout(() => { longPressed = true; openEmojiPicker(sendBtn); }, 500);
    } else {
      $('mc-form').requestSubmit();
    }
  }, { passive: false });
  sendBtn.addEventListener('touchend', (e) => {
    clearTimeout(pressTimer);
    if (longPressed) { if (e.cancelable) e.preventDefault(); longPressed = false; return; }
    // Non-emoji taps already submitted on touchstart; emoji taps never do, so
    // exactly ONE submit happens per tap. Use the mode captured at touchstart:
    // an edit-save on touchstart clears the composer (finishEdit → cancelEdit),
    // which flips mc.emojiMode to true — reading it live here would race a
    // second submit that sends the preferred emoji as a new message.
    if (emojiTap && !sendBtn.disabled) $('mc-form').requestSubmit();
  });
  sendBtn.addEventListener('touchcancel', () => clearTimeout(pressTimer));
  updateSendMode(); // empty composer on first paint → emoji mode

  // Touch origin for the tap-vs-scroll guard: browsers suppress clicks after
  // a drag, but a fast flick can still slip one through on some devices —
  // any touch that moved >12px from its start never opens the menu.
  $('mc-msgs').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    mc.touchStartXY = t ? [t.clientX, t.clientY] : null;
  }, { passive: true });

  // Tap a bubble -> action menu. Chips, quotes, links and media controls are
  // handled before this (they return early below).
  $('mc-msgs').addEventListener('click', (e) => {
    const chip = e.target.closest('.mc-chip');
    if (chip) {
      if (mc.menuMid) closeMsgMenu();
      toggleReaction(chip.dataset.mid, chip.dataset.mcReact);
      return;
    }
    const quote = e.target.closest('.mc-quote');
    if (quote) {
      if (mc.menuMid) closeMsgMenu();
      jumpToMessage(quote.dataset.mcJump);
      return;
    }
    if (e.target.closest('a, audio, video')) { // native behaviour wins
      if (mc.menuMid) closeMsgMenu();
      return;
    }
    const bub = e.target.closest('.mc-bub[data-mid], .mc-sys[data-mid]');
    if (!bub) {
      // Tapping empty space inside the thread closes the open menu.
      if (mc.menuMid) closeMsgMenu();
      return;
    }
    if (mc.touchStartXY) {
      const [sx, sy] = mc.touchStartXY;
      mc.touchStartXY = null;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12) return; // was a scroll
    }
    // The release tap right after a long-press opened the menu must not
    // toggle it straight back closed.
    if (Date.now() < menuGuardUntil) return;
    if (mc.menuMid === bub.dataset.mid) { closeMsgMenu(); return; }
    openMsgMenu(bub.dataset.mid, e.clientX, e.clientY);
  });

  // Right-click / mobile long-press (contextmenu) opens the same menu —
  // matches the full app. Guard the follow-up release tap.
  $('mc-msgs').addEventListener('contextmenu', (e) => {
    const bub = e.target.closest('.mc-bub[data-mid], .mc-sys[data-mid]');
    if (!bub) return;
    e.preventDefault();
    menuGuardUntil = Date.now() + 500;
    openMsgMenu(bub.dataset.mid, e.clientX, e.clientY);
  });

  // Menu actions (reactions, reply, copy, edit, delete).
  $('mc-menu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mc-action]');
    if (!btn || !mc.menuMid) return;
    const mid = mc.menuMid;
    const m = mc.messages[mid];
    const action = btn.dataset.mcAction;
    closeMsgMenu();
    if (!m) return;
    if (action === 'react') return toggleReaction(mid, btn.dataset.reaction);
    if (action === 'reply') return setReply(m, mid);
    if (action === 'copy') {
      try {
        navigator.clipboard.writeText(m.text || '');
        notify('Message copied.');
      } catch (_) { notify('Could not copy text.'); }
      return;
    }
    if (action === 'edit') return startEdit(m, mid);
    if (action === 'delete') return confirmDelete(m, mid);
  });

  // Click anywhere else closes the menu (other bubbles re-target it above).
  document.addEventListener('click', (e) => {
    if (!mc.menuMid || !mc.open) return;
    if (e.target.closest('#mc-menu') || e.target.closest('#mc-msgs')) return;
    closeMsgMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !mc.open) return;
    if (mc.menuMid) { closeMsgMenu(); return; }
    if (mc.showThread) backToList();
    else close();
  });

  // Auth listener stays for the page's lifetime (cheap single callback).
  mc.unsubAuth = onAuthStateChanged(auth, (user) => {
    const changed = (user?.uid || null) !== (mc.user?.uid || null);
    mc.user = user || null;
    if (changed) {
      // Account switched / signed out — drop the previous inbox snapshot so
      // another user's conversations can never show, open or closed.
      detachAll();
      mc.inbox = {};
      mc.ready = false;
      mc.streaks = {}; // never leak the previous account's 🔥 badges
      if (mc.open) {
        if (mc.showThread) backToList();
        hydrateStreaksCache(); // instant paint from the NEW uid's shared cache
        hydrateInboxCache();
        attachInbox();
        attachClears();
      }
    }
    renderList();
    renderHeader();
  });
}

function open() {
  build();
  if (mc.open) return;
  mc.open = true;
  $('mini-chat-modal').classList.remove('mc-off');
  // Refresh the shared users table (5-min debounced by the feed) so names
  // and avatars aren't stale, then repaint the list.
  if (window.ensureUsersFresh) {
    Promise.resolve(window.ensureUsersFresh()).then(() => { if (mc.open) renderList(); }).catch(() => {});
  }
  if (mc.user) {
    hydrateStreaksCache(); // instant 🔥 badges from the shared cache
    hydrateInboxCache();
    attachInbox();
    attachClears();
    refreshStreaks();      // then refresh every inbox thread's streak
  }
  else { renderList(); renderHeader(); }
}

function close() {
  if (!mc.open) return;
  mc.open = false;
  $('mini-chat-modal').classList.add('mc-off');
  detachAll();
  closeMsgMenu();
  clearComposerModes();
  const input = $('mc-input');
  if (input) input.value = '';
  updateSendMode();
  // Reset view state so reopening always starts from the conversation list.
  mc.showThread = false;
  mc.tid = null;
  mc.messages = {};
  mc.lastMsgHtml = '';
  mc.lastListHtml = '';
  $('mc-thread').classList.add('mc-off');
  $('mc-list').classList.remove('mc-off');
  $('mc-back').classList.add('mc-off');
}

function detachAll() {
  [mc.stopInbox, mc.stopMessages, mc.stopClears, mc.stopStreak].forEach((fn) => {
    try { if (fn) fn(); } catch (_) { /* already gone */ }
  });
  mc.stopInbox = mc.stopMessages = mc.stopClears = mc.stopStreak = null;
  Object.values(mc.threadStops).forEach((fn) => { try { fn(); } catch (_) {} });
  mc.threadStops = {};
}

/* ------------------------- shared inbox cache -------------------------
   EXACT same key, shape and 250ms debounce as chat/js/app.js saveInboxCache
   — the full chat app and this widget read and write ONE localStorage
   entry, so first paint gets real group names / nicknames / pics instantly
   instead of flashing member-name fallbacks until the thread watchers land
   (the same "no flicker" restore the full app does in its auth callback). */
let _saveInboxTimer = null;
function saveInboxCache() {
  if (!mc.user) return;
  clearTimeout(_saveInboxTimer);
  _saveInboxTimer = setTimeout(() => {
    try {
      if (mc.user) localStorage.setItem(`hangout-inbox-${mc.user.uid}`, JSON.stringify(mc.inbox));
    } catch (_) { /* private mode / quota — memory is best-effort */ }
  }, 250);
}

// Instant first paint from that shared cache. The live snapshot replaces it
// a moment later; handleInbox's merge keeps the watched display fields, so
// rows never regress to fallback names in between.
function hydrateInboxCache() {
  if (!mc.user || mc.ready) return;
  try {
    const cached = localStorage.getItem(`hangout-inbox-${mc.user.uid}`);
    if (!cached) return;
    const parsed = JSON.parse(cached);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    mc.inbox = parsed;
    if (!mc.inbox['global_announcements']) {
      mc.inbox['global_announcements'] = { ...ANNOUNCE_PLACEHOLDER };
    }
    mc.ready = true;
    syncThreadWatchers(); // start name/pic round-trips NOW, in parallel
    renderList();
    renderHeader();
  } catch (_) { /* corrupted cache — fall back to waiting on live data */ }
}

/* ------------------------------- listeners ------------------------------- */

function attachInbox() {
  try { if (mc.stopInbox) mc.stopInbox(); } catch (_) {}
  mc.stopInbox = null;
  if (!mc.user) return;
  mc.stopInbox = onValue(ref(db, `chatInboxes/${mc.user.uid}`), handleInbox,
    (err) => console.warn('[mini-chat] inbox read failed:', err));
}

function attachClears() {
  try { if (mc.stopClears) mc.stopClears(); } catch (_) {}
  mc.stopClears = null;
  if (!mc.user) return;
  mc.stopClears = onValue(ref(db, `chatClears/${mc.user.uid}`), (snap) => {
    mc.clears = snap.val() || {};
    if (mc.showThread) renderMessages();
  }, (err) => console.warn('[mini-chat] clears read failed:', err));
}

function handleInbox(snap) {
  const previous = mc.inbox;
  const next = snap.val() || {};
  // Preserve thread-watched display fields across snapshots — the exact merge
  // the full app's handleInbox performs, so name/pic/members/nicknames
  // patched by syncThreadWatchers aren't wiped by the next inbox update.
  Object.keys(next).forEach((id) => {
    const prev = previous[id];
    if (!prev) return;
    ['name', 'pic', 'members', 'nicknames', 'creatorId'].forEach((k) => {
      if (prev[k] !== undefined) next[id][k] = prev[k];
    });
  });
  // Announcements may be virtual (absent from the DB) — keep the live
  // preview fields the thread watchers patched instead of reverting to the
  // welcome text on every unrelated inbox update.
  if (!next['global_announcements']) {
    const prev = previous['global_announcements'];
    next['global_announcements'] = prev
      ? { ...ANNOUNCE_PLACEHOLDER, ...prev }
      : { ...ANNOUNCE_PLACEHOLDER };
  }
  const firstReady = !mc.ready;
  mc.inbox = next;
  mc.ready = true;
  saveInboxCache();
  syncThreadWatchers();
  renderList();
  renderHeader();
  // First authoritative inbox snapshot (no usable cache) → fetch streak badges.
  if (firstReady) refreshStreaks();

  if (!mc.showThread) return;
  if (!mc.tid || !mc.inbox[mc.tid]) { backToList(); return; }
  // Keep the thread read while it's on screen (same effect as the full
  // app's markThreadRead): zero unread, which flows back through this
  // listener — guarded above so it can never loop.
  const current = mc.inbox[mc.tid];
  if (Number(current.unreadCount || 0) > 0 && document.visibilityState === 'visible') {
    update(ref(db, `chatInboxes/${mc.user.uid}/${mc.tid}`), { unreadCount: 0 }).catch(() => {});
  }
}

// Thread display fields live on chatThreads, NOT in the inbox — the full
// app watches the same children per thread (syncThreadSummaryWatchers).
// Watch only these tiny fields per inbox thread while the widget is open;
// lastMessage/lastTimestamp/lastSenderId keep previews live for threads the
// inbox listener can't refresh (e.g. the virtual announcements entry).
function syncThreadWatchers() {
  const wanted = new Set(Object.keys(mc.inbox));
  Object.entries(mc.threadStops).forEach(([tid, stop]) => {
    if (wanted.has(tid)) return;
    try { stop(); } catch (_) {}
    delete mc.threadStops[tid];
  });
  wanted.forEach((tid) => {
    if (mc.threadStops[tid]) return;
    const stops = [];
    const watch = (child, apply) => {
      stops.push(onValue(ref(db, `chatThreads/${tid}/${child}`), (snap) => {
        if (!snap.exists()) return;
        const cur = mc.inbox[tid];
        if (!cur) return;
        mc.inbox[tid] = { ...cur, ...apply(snap.val()) };
        saveInboxCache(); // persist watched names too (debounced)
        renderList();
        if (mc.showThread && mc.tid === tid) renderHeader();
      }, (err) => console.warn('[mini-chat] thread field:', err)));
    };
    watch('name', (v) => ({ name: v || '' }));
    watch('pic', (v) => ({ pic: v || '' }));
    watch('members', (v) => ({ members: v || {} }));
    watch('nicknames', (v) => ({ nicknames: v || {} }));
    watch('lastMessage', (v) => ({ lastMessage: v || '' }));
    watch('lastTimestamp', (v) => ({ lastTimestamp: v || 0 }));
    watch('lastSenderId', (v) => ({ lastSenderId: v || '' }));
    mc.threadStops[tid] = () => stops.forEach((s) => { try { s(); } catch (_) {} });
  });
}


/* ------------------------------- list view ------------------------------- */

function renderList() {
  const list = $('mc-list');
  if (!list) return;

  if (!mc.user) {
    const html = `<div class="mc-empty"><p>Sign in to see your conversations.</p>
      <button id="mc-signin" class="mc-cta" type="button">Sign in</button></div>`;
    if (html !== mc.lastListHtml) { mc.lastListHtml = html; list.innerHTML = html; }
    return;
  }
  if (!mc.ready) {
    const html = `<p class="mc-empty">Loading conversations…</p>`;
    if (html !== mc.lastListHtml) { mc.lastListHtml = html; list.innerHTML = html; }
    return;
  }

  const items = Object.entries(mc.inbox)
    .map(([tid, it]) => ({ tid, ...it }))
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
    });

  if (!items.length) {
    const html = `<div class="mc-empty"><p>No conversations yet.</p>
      <a class="mc-cta" href="chat/">Open the full chat</a></div>`;
    if (html !== mc.lastListHtml) { mc.lastListHtml = html; list.innerHTML = html; }
    return;
  }

  const uid = mc.user.uid;
  const html = items.map((it) => {
    const unread = Number(it.unreadCount || 0);
    const preview = it.lastSenderId === uid
      ? `You: ${it.lastMessage || ''}`
      : (it.lastMessage || 'Start chatting');
    const online = !it.isGroup && it.peerId && it.peerId !== uid && isOnline(it.peerId);
    const streak = mc.streaks[it.tid];
    const streakHtml = streak && streak.count >= 1 ? `<b class="mc-streak-badge">🔥${streak.count}</b>` : '';
    return `<button type="button" class="mc-row${unread ? ' mc-unread' : ''}" data-tid="${esc(it.tid)}">
      <span class="mc-ava-wrap">${avatarHtml(it.tid, it)}${online ? '<i class="mc-dot"></i>' : ''}</span>
      <span class="mc-copy">
        <span class="mc-top">
          <span class="mc-name">${it.pinned ? '📌 ' : ''}${esc(nameOf(it.tid, it))}</span>${streakHtml}
          <span class="mc-time">${esc(fmtTime(it.lastTimestamp))}</span>
        </span>
        <span class="mc-prev">
          <span>${esc(preview)}</span>
          ${unread ? `<b class="mc-ubadge">${unread > 99 ? '99+' : unread}</b>` : ''}
        </span>
      </span>
    </button>`;
  }).join('');

  if (html !== mc.lastListHtml) {
    mc.lastListHtml = html;
    list.innerHTML = html;
  }
}

function renderHeader() {
  const title = $('mc-title');
  const sub = $('mc-sub');
  const badge = $('mc-badge');
  if (!title || !sub) return;

  if (mc.showThread && mc.tid) {
    const it = mc.inbox[mc.tid] || {};
    // Header icon follows the conversation: peer avatar / group pic (the same
    // avatarHtml the list rows use) instead of the generic comments glyph.
    const bh = avatarHtml(mc.tid, it);
    if (badge && bh !== mc.lastBadgeHtml) { mc.lastBadgeHtml = bh; badge.innerHTML = bh; }
    title.textContent = nameOf(mc.tid, it);
    if (it.isGroup) {
      const n = Object.keys(it.members || {}).length;
      sub.textContent = `${n} member${n === 1 ? '' : 's'}`;
    } else if (it.peerId && mc.user && it.peerId !== mc.user.uid) {
      sub.textContent = isOnline(it.peerId) ? 'Online' : 'Offline';
    } else {
      sub.textContent = 'Conversation';
    }
    renderStreakBadge();
    return;
  }

  const defBadge = '<i class="fa-solid fa-comments"></i>';
  if (badge && mc.lastBadgeHtml !== defBadge) { mc.lastBadgeHtml = defBadge; badge.innerHTML = defBadge; }
  renderStreakBadge(); // hides the pill outside a thread
  title.textContent = 'Messages';
  if (!mc.user) sub.textContent = 'Sign in to chat';
  else if (!mc.ready) sub.textContent = 'Loading…';
  else {
    const unread = Object.values(mc.inbox)
      .reduce((n, it) => n + (Number(it.unreadCount || 0) > 0 ? 1 : 0), 0);
    const total = Object.keys(mc.inbox).length;
    sub.textContent = unread > 0
      ? `${unread} unread`
      : `${total} conversation${total === 1 ? '' : 's'}`;
  }
}

/* ------------------------------- thread view ------------------------------- */

function openThread(tid) {
  const item = mc.inbox[tid];
  if (!item || !mc.user) return;
  mc.showThread = true;
  mc.tid = tid;
  mc.messages = {};
  mc.lastMsgHtml = '';
  mc.msgsPainted = false;
  loadMsgsCache(tid); // instant paint: last known snapshot (live data replaces it)

  $('mc-list').classList.add('mc-off');
  $('mc-thread').classList.remove('mc-off');
  $('mc-back').classList.remove('mc-off');
  renderHeader();
  renderComposer();
  renderMessages();

  // Same mark-read as the full app's markThreadRead.
  if (Number(item.unreadCount || 0) > 0) {
    update(ref(db, `chatInboxes/${mc.user.uid}/${tid}`), { unreadCount: 0 }).catch(() => {});
  }

  // Live streak for this thread (same path rule as the full app's watchStreak).
  try { if (mc.stopStreak) mc.stopStreak(); } catch (_) {}
  mc.stopStreak = onValue(ref(db, streakPath(tid)), (snap) => {
    const data = snap.val() || null;
    if (data && data.count >= 1) mc.streaks[tid] = data;
    else delete mc.streaks[tid];
    if (mc.showThread && mc.tid === tid) renderStreakBadge();
    renderList();
  }, () => { /* read errors leave the cached badge in place */ });

  try { if (mc.stopMessages) mc.stopMessages(); } catch (_) {}
  mc.stopMessages = onValue(query(ref(db, `chatMessages/${tid}`), limitToLast(30)), (snap) => {
    mc.messages = snap.val() || {};
    if (mc.showThread && mc.tid === tid) {
      renderMessages();
      saveMsgsCache(tid, mc.messages);
    }
  }, (err) => console.warn('[mini-chat] messages read failed:', err));
}

function backToList() {
  try { if (mc.stopMessages) mc.stopMessages(); } catch (_) {}
  mc.stopMessages = null;
  try { if (mc.stopStreak) mc.stopStreak(); } catch (_) {}
  mc.stopStreak = null;
  closeMsgMenu();
  clearComposerModes();
  const input = $('mc-input');
  if (input) input.value = '';
  updateSendMode();
  mc.showThread = false;
  mc.tid = null;
  mc.messages = {};
  mc.lastMsgHtml = '';
  $('mc-thread').classList.add('mc-off');
  $('mc-list').classList.remove('mc-off');
  $('mc-back').classList.add('mc-off');
  renderList();
  renderHeader();
}

// Media block: voice notes, videos and images — same detection as the full
// app. Images and videos open the main site's shared viewer modal
// (window.viewImage — same #image-viewer-modal the feed/My Day use), matching
// the full chat's tap-to-view behaviour. Voice notes stay inline.
function mediaHtml(m) {
  const imageSrc = m.image || '';
  const isVoice = Boolean(m.audio || (imageSrc && /\.(mp3|wav|ogg|m4a|aac|opus)$/i.test(imageSrc)));
  if (isVoice) {
    return `<audio class="mc-audio" controls preload="none" src="${esc(m.audio || m.image)}"></audio>`;
  }
  if (!imageSrc) return '';
  if (imageSrc.includes('/video/upload/') || /\.(mp4|webm|mov|ogg)$/i.test(imageSrc)) {
    const vid = window.optVideo ? window.optVideo(imageSrc, 720) : imageSrc;
    const poster = window.optVideoPoster ? window.optVideoPoster(imageSrc, 480) : '';
    return `<video class="mc-media" preload="none" controls src="${esc(vid)}"${poster ? ` poster="${esc(poster)}"` : ''} onclick="event.stopPropagation(); window.viewImage('${esc(imageSrc)}')"></video>`;
  }
  const img = window.optMedia ? window.optMedia(imageSrc, { width: 600 }) : imageSrc;
  return `<img class="mc-media" loading="lazy" src="${esc(img)}" alt="" onclick="event.stopPropagation(); window.viewImage('${esc(imageSrc)}')">`;
}

function msgRowHtml(id, m) {
  const mine = m.senderId === mc.user?.uid;
  const time = esc(fmtTime(m.timestamp));
  const rowId = `id="mc-msg-${esc(id)}" data-mid="${esc(id)}"`;

  if (m.isSystem) {
    return `<div class="mc-sys" ${rowId}>${esc(senderName(m.senderId))} ${esc(m.text || '')}</div>`;
  }
  if (m.isDeleted) {
    return `<div class="mc-bub ${mine ? 'mine' : 'theirs'} mc-deleted" ${rowId}>🚫 Message deleted<span class="mc-mtime">${time}</span></div>`;
  }
  if (m.isGame) {
    return `<div class="mc-sys" ${rowId}>🎮 Game message — open the full chat to play · ${time}</div>`;
  }

  const senderLabel = (mc.inbox[mc.tid]?.isGroup && !mine)
    ? `<span class="mc-sender">${esc(senderName(m.senderId))}</span>`
    : '';
  // Reply quote — same data the full app renders; tap jumps to the original.
  let quote = '';
  if (m.replyTo) {
    quote = `<button type="button" class="mc-quote" data-mc-jump="${esc(m.replyTo.id || '')}">`
      + `<b>Reply to ${esc(senderName(m.replyTo.senderId))}</b>`
      + `<span>${esc(quotePreview(m.replyTo))}</span></button>`;
  }
  const text = m.text ? linkify(esc(m.text)) : '';
  const media = mediaHtml(m);
  const edited = m.editedAt ? '<span class="mc-edited">Edited</span>' : '';
  // Reaction chips — emoji + count, my own mark highlighted, tap to toggle.
  const chipParts = [];
  Object.entries(m.reactions || {}).forEach(([type, people]) => {
    const count = Object.keys(people || {}).length;
    if (!count) return;
    const active = Boolean(people?.[mc.user?.uid]);
    chipParts.push(`<button type="button" class="mc-chip${active ? ' mine' : ''}" data-mc-react="${esc(type)}" data-mid="${esc(id)}">${esc(REACTIONS[type] || type)}${count > 1 ? ` ${count}` : ''}</button>`);
  });
  const chips = chipParts.length ? `<span class="mc-chips">${chipParts.join('')}</span>` : '';

  if (!text && !media && !quote) {
    return `<div class="mc-bub ${mine ? 'mine' : 'theirs'}" ${rowId}>${senderLabel}<span class="mc-text mc-faded">Shared a message</span>${chips}<span class="mc-mtime">${time}</span></div>`;
  }
  return `<div class="mc-bub ${mine ? 'mine' : 'theirs'}" ${rowId}>${senderLabel}${quote}${text ? `<span class="mc-text">${text}</span>` : ''}${media}${chips}<span class="mc-mtime">${time}${edited}</span></div>`;
}

function renderMessages() {
  const box = $('mc-msgs');
  if (!box || !mc.tid) return;

  const clearTime = Number(mc.clears?.[mc.tid] || 0);
  const rows = Object.entries(mc.messages || {})
    .filter(([, m]) => Number(m?.timestamp || 0) > clearTime)
    // Order by Firebase push key — server-assigned and strictly chronological
    // (same rule as the full app; a wrong device clock can't reorder history).
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 250;

  if (!rows.length) {
    if (box.innerHTML !== '<p class="mc-empty">No messages yet. Say hello!</p>') {
      box.innerHTML = '<p class="mc-empty">No messages yet. Say hello!</p>';
      box.scrollTop = box.scrollHeight;
    }
    return;
  }

  const html = rows.map(([id, m]) => msgRowHtml(id, m)).join('');
  if (html !== mc.lastMsgHtml) {
    mc.lastMsgHtml = html;
    box.innerHTML = html;
    const lastMine = rows[rows.length - 1][1]?.senderId === mc.user?.uid;
    if (!mc.msgsPainted || lastMine || wasNearBottom) box.scrollTop = box.scrollHeight;
    mc.msgsPainted = true;
  }
}

// Hides the composer for banned users and non-admins in announcements —
// mirrors the full app's openThread form gating.
function renderComposer() {
  const form = $('mc-form');
  const bar = $('mc-ban-bar');
  if (!form || !bar) return;
  const u = window.globalUsersCache?.[mc.user?.uid] || {};
  const banned = Boolean(u.isBanned);
  const announcementsLocked = mc.tid === 'global_announcements'
    && !(u.isAdmin === true || u.isCreator === true);
  form.classList.toggle('mc-off', banned || announcementsLocked);
  bar.classList.toggle('mc-off', !banned);
}

/* --------------------------- message action menu --------------------------- */

function closeMsgMenu() {
  const menu = $('mc-menu');
  if (menu) { menu.classList.add('mc-off'); menu.innerHTML = ''; }
  mc.menuMid = null;
}

// Tap/right-click popup: 5 quick reactions + reply + copy (+ edit/delete on
// your own non-deleted messages) — the core of the full app's action menu.
function openMsgMenu(mid, x, y) {
  const menu = $('mc-menu');
  const m = mc.messages[mid];
  if (!menu || !m || m.isGame || m.isGameBump || m.isSystem) return;

  const uid = mc.user?.uid;
  const isMine = m.senderId === uid;
  const notDeleted = !m.isDeleted;

  const quick = Object.entries(REACTIONS).map(([type, emoji]) => {
    const active = Boolean(m.reactions?.[type]?.[uid]);
    return `<button type="button" class="mc-mreact${active ? ' active' : ''}" data-mc-action="react" data-reaction="${type}" title="${type}" aria-label="React ${type}">${emoji}</button>`;
  }).join('');

  const icon = (cls, action, title) =>
    `<button type="button" class="mc-micon" data-mc-action="${action}" title="${title}" aria-label="${title}"><i class="fa-solid ${cls}"></i></button>`;
  const ownerBtns = (isMine && notDeleted)
    ? icon('fa-pen', 'edit', 'Edit') + icon('fa-trash', 'delete', 'Delete')
    : '';

  menu.innerHTML =
    `<div class="mc-menu-row">${quick}</div>` +
    `<div class="mc-menu-sep"></div>` +
    `<div class="mc-menu-row">${notDeleted ? icon('fa-reply', 'reply', 'Reply') : ''}${icon('fa-copy', 'copy', 'Copy text')}${ownerBtns}</div>`;

  menu.classList.remove('mc-off');
  mc.menuMid = mid;

  // Clamp inside the viewport — same padding/flipping rule as the full app.
  const pad = 14;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const left = Math.max(pad, Math.min(x, window.innerWidth - mw - pad));
  let top = y + 8;
  if (top + mh > window.innerHeight - pad) top = Math.max(pad, y - mh - 24);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// Replica of the full app's toggleReaction: one reaction per user per
// message — all of my existing marks are cleared, then the picked one is
// set (or unset when it was already active). The live messages listener
// re-delivers the window, so chips update without any extra listener.
async function toggleReaction(mid, type) {
  const uid = mc.user?.uid;
  const m = mc.messages[mid];
  if (!uid || !mc.tid || !m || !REACTIONS[type]) return;

  const current = m.reactions || {};
  const isActive = Boolean(current[type]?.[uid]);
  const updates = {};
  Object.keys(current).forEach((key) => {
    if (current[key]?.[uid]) updates[`${key}/${uid}`] = null;
  });
  Object.keys(REACTIONS).forEach((key) => { updates[`${key}/${uid}`] = null; });
  if (!isActive) updates[`${type}/${uid}`] = true;

  try {
    await update(ref(db, `chatMessages/${mc.tid}/${mid}/reactions`), updates);
  } catch (err) {
    notify('Could not react: ' + String(err?.message || err).replace('Firebase: ', ''));
  }
}

function jumpToMessage(mid) {
  const el = document.getElementById(`mc-msg-${mid}`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  notify('That message isn’t in the loaded history — open the full chat to find it.');
}

/* --------------------------- reply / edit / delete --------------------------- */

// Short human preview for a replyTo payload (shape matches the full app's).
function quotePreview(rt = {}) {
  if (rt.text) return String(rt.text).slice(0, 120);
  if (rt.image && (rt.image.includes('/video/upload/') || /\.(mp4|webm|mov|ogg)$/i.test(rt.image))) return '🎬 Video';
  if (rt.hasImage || rt.image) return '📷 Photo';
  return 'Message';
}

function clearComposerModes() {
  mc.replyTo = null;
  mc.editMid = null;
  $('mc-reply-banner')?.classList.add('mc-off');
  $('mc-edit-banner')?.classList.add('mc-off');
}

function setReply(m, mid) {
  if (!m || m.isDeleted) return;
  clearComposerModes();
  mc.replyTo = { id: mid, senderId: m.senderId, text: String(m.text || '').slice(0, 120), hasImage: Boolean(m.image), image: m.image || null };
  const text = $('mc-reply-text');
  if (text) {
    text.innerHTML = `Replying to <b>${esc(senderName(m.senderId))}</b>: ${esc(quotePreview(mc.replyTo))}`;
  }
  $('mc-reply-banner')?.classList.remove('mc-off');
  $('mc-input')?.focus();
}

function clearReply() {
  mc.replyTo = null;
  $('mc-reply-banner')?.classList.add('mc-off');
}

function startEdit(m, mid) {
  if (!m || m.senderId !== mc.user?.uid || m.isDeleted || !m.text) return;
  clearComposerModes();
  mc.editMid = mid;
  const input = $('mc-input');
  if (input) { input.value = m.text; input.focus(); }
  updateSendMode(); // text present → paper plane
  $('mc-edit-banner')?.classList.remove('mc-off');
}

function cancelEdit() {
  mc.editMid = null;
  $('mc-edit-banner')?.classList.add('mc-off');
  const input = $('mc-input');
  if (input) input.value = '';
  updateSendMode();
}

// Save an in-progress edit: owner-only write (server rule) + preview refresh,
// exactly like the full app's editMessage.
async function finishEdit(text) {
  const mid = mc.editMid;
  const uid = mc.user?.uid;
  const tid = mc.tid;
  const m = mc.messages[mid];
  cancelEdit();
  if (!m || !uid || !tid) return;
  if (m.senderId !== uid) return notify('You can only edit your own messages.');
  if (!text) return notify('Message cannot be empty.');
  if (text === m.text) return;
  try {
    const timestamp = Date.now();
    await update(ref(db, `chatMessages/${tid}/${mid}`), { text, editedAt: timestamp });
    // Refresh conversation previews with the new text (full-app parity).
    const item = mc.inbox[tid] || {};
    await updateSummaries(tid, item, text, timestamp, uid);
    notify('Message edited.');
  } catch (err) {
    notify('Could not edit message: ' + String(err?.message || err).replace('Firebase: ', ''));
    // Put the text back so a failed save doesn't eat the user's work.
    const input = $('mc-input');
    if (input) input.value = text;
  }
}

// Delete = soft-delete flag (server rule: owner-only, even for admins).
// Reuses the feed's existing confirm modal.
function confirmDelete(m, mid) {
  if (!m || m.senderId !== mc.user?.uid || m.isDeleted) return;
  const run = async () => {
    try {
      await update(ref(db, `chatMessages/${mc.tid}/${mid}`), { isDeleted: true });
      notify('Message deleted.');
    } catch (_) {
      notify('Could not delete message. Check permissions.');
    }
  };
  if (typeof window.showConfirm === 'function') window.showConfirm('Are you sure you want to delete this message?', run);
  else if (window.confirm('Are you sure you want to delete this message?')) run();
}



/* ------------------------------- streaks -------------------------------
   Replicas of chat/js/app.js: same chatStreaks nodes, same shared localStorage
   cache (hangout-streaks-{uid}) so the full app and this widget light up each
   other's 🔥 badges instantly. Restore stays in the full app (scope note above). */

const streaksCacheKey = () => `hangout-streaks-${mc.user?.uid || 'anon'}`;

function hydrateStreaksCache() {
  if (!mc.user) return;
  try {
    const raw = localStorage.getItem(streaksCacheKey());
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') mc.streaks = { ...parsed, ...mc.streaks };
  } catch (_) { /* corrupted cache — live data will refill */ }
}

function saveStreaksCache() {
  if (!mc.user) return;
  try {
    let base = {};
    try { base = JSON.parse(localStorage.getItem(streaksCacheKey())) || {}; } catch (_) {}
    if (!base || typeof base !== 'object') base = {};
    // Merge (not replace): the full chat app writes the same key, and neither
    // side should drop entries the other knows about.
    localStorage.setItem(streaksCacheKey(), JSON.stringify({ ...base, ...mc.streaks }));
  } catch (_) { /* quota / private mode — best-effort */ }
}

// One get() per inbox thread — runs when the widget opens and on the first
// live inbox snapshot only (never later: inbox changes fire on every message,
// which would refetch N streaks constantly).
function refreshStreaks() {
  if (!mc.user) return;
  const tids = Object.keys(mc.inbox);
  if (!tids.length) return;
  Promise.all(tids.map((tid) =>
    get(ref(db, streakPath(tid)))
      .then((s) => ({ tid, ok: true, data: s.val() || null }))
      .catch(() => ({ tid, ok: false }))
  )).then((rows) => {
    rows.forEach((r) => {
      if (!r.ok) return;
      if (r.data && r.data.count >= 1) mc.streaks[r.tid] = r.data;
      else delete mc.streaks[r.tid];
    });
    saveStreaksCache();
    renderList();
  }).catch(() => { /* individual rows keep their cached badge */ });
}

function renderStreakBadge() {
  const el = $('mc-streak');
  if (!el) return;
  const data = mc.tid ? mc.streaks[mc.tid] : null;
  if (!data || !data.count || data.count < 1) {
    el.classList.add('mc-off');
    el.textContent = '';
    return;
  }
  el.textContent = `🔥 ${data.count}`;
  el.classList.remove('mc-off');
}

/* ------------------------- messages cache -------------------------
   Instant re-entry paint: the last snapshot of the most recently opened
   threads lives in localStorage (250ms debounced writes, max 8 threads).
   openThread() fills mc.messages from it BEFORE the live listener attaches —
   the listener's first snapshot then replaces it with authoritative state. */
const MSG_CACHE_MAX = 8;
const _pendingMsgWrites = {};
let _saveMsgsTimer = null;
const msgsCacheKey = () => `hangout-mc-msgs-${mc.user?.uid || 'anon'}`;

function saveMsgsCache(tid, msgs) {
  if (!mc.user || !tid) return;
  _pendingMsgWrites[tid] = { at: Date.now(), msgs };
  if (_saveMsgsTimer) return;
  _saveMsgsTimer = setTimeout(() => {
    _saveMsgsTimer = null;
    try {
      let store = {};
      try { store = JSON.parse(localStorage.getItem(msgsCacheKey())) || {}; } catch (_) {}
      if (!store || typeof store !== 'object' || Array.isArray(store)) store = {};
      Object.assign(store, _pendingMsgWrites);
      Object.keys(_pendingMsgWrites).forEach((k) => delete _pendingMsgWrites[k]);
      Object.keys(store)
        .sort((a, b) => ((store[b]?.at) || 0) - ((store[a]?.at) || 0))
        .slice(MSG_CACHE_MAX)
        .forEach((k) => delete store[k]);
      localStorage.setItem(msgsCacheKey(), JSON.stringify(store));
    } catch (_) { /* quota / private mode — best-effort */ }
  }, 250);
}

function loadMsgsCache(tid) {
  if (!mc.user || !tid) return;
  try {
    const store = JSON.parse(localStorage.getItem(msgsCacheKey())) || {};
    const entry = store[tid];
    if (entry && entry.msgs && typeof entry.msgs === 'object') mc.messages = entry.msgs;
  } catch (_) { /* corrupted — start empty */ }
}

/* ------------------------------- sending ------------------------------- */

// Replica of chat/js/app.js updateStreak: count once per day per thread,
// extend when the last one was yesterday, otherwise restart at 1 (previousCount
// saved so the full app can offer its restore flow). Fire-and-forget after send.
async function updateStreak(tid) {
  if (!mc.user || !tid) return;
  try {
    const snap = await get(ref(db, streakPath(tid)));
    const data = snap.val() || {};
    const today = todayStr();
    const yesterday = yesterdayStr();
    const lastDate = data.lastDate || '';
    if (lastDate === today) return; // already counted today
    const out = { lastDate: today, lastSenderId: mc.user.uid };
    let count = data.count || 0;
    if (lastDate === yesterday) {
      count += 1;
    } else {
      if (count > 1) { out.previousCount = count; out.brokenDate = today; }
      count = 1;
    }
    out.count = count;
    await set(ref(db, streakPath(tid)), { ...data, ...out });
    mc.streaks[tid] = { ...data, ...out };
    saveStreaksCache();
    renderList();
    if (mc.showThread && mc.tid === tid) renderStreakBadge();
  } catch (err) {
    console.warn('[mini-chat] streak update failed:', err);
  }
}

// Replica of chat/js/app.js checkChatCooldown (same settings node mirrored
// into window.siteSettings; fail-open on read errors).
async function cooldownOk(uid) {
  const cd = Number(window.siteSettings?.chatCooldownSec ?? 0);
  if (!cd || cd <= 0) return true;
  try {
    const snap = await get(ref(db, `users/${uid}/lastChatAt`));
    const waitMs = cd * 1000 - (Date.now() - Number(snap.val() || 0));
    if (waitMs > 0) {
      notify(`Please wait ${Math.ceil(waitMs / 1000)}s before sending again.`);
      return false;
    }
    update(ref(db, `users/${uid}`), { lastChatAt: Date.now() }).catch(() => {});
    return true;
  } catch (_) {
    return true; // fail-open on read errors, same as the full app
  }
}

// EXACT replica of chat/js/app.js updateConversationSummaries so the two UIs
// never drift: thread summary fields, own inbox entry (unread 0), and a
// runTransaction per peer inbox entry (unread +1, capped at 99).
async function updateSummaries(tid, item, preview, timestamp, uid) {
  const own = { ...item, lastMessage: preview, lastTimestamp: timestamp, lastSenderId: uid, unreadCount: 0 };
  if (!item.isGroup && item.peerId) own.peerId = item.peerId;
  delete own.name;
  delete own.nicknames;
  delete own.creatorId;
  await update(ref(db), {
    [`chatThreads/${tid}/lastMessage`]: preview,
    [`chatThreads/${tid}/lastTimestamp`]: timestamp,
    [`chatThreads/${tid}/lastSenderId`]: uid,
    [`chatInboxes/${uid}/${tid}`]: own
  });
  const peers = threadPeers(item);
  const isGroup = Boolean(item.isGroup);
  peers.forEach((id) => {
    runTransaction(ref(db, `chatInboxes/${id}/${tid}`), (current) => {
      const base = { ...(current || own) };
      if (isGroup) {
        base.isGroup = true;
        base.members = item.members || own.members || {};
        delete base.peerId;
      } else {
        base.peerId = uid;
      }
      base.lastMessage = preview;
      base.lastTimestamp = timestamp;
      base.lastSenderId = uid;
      base.unreadCount = Math.min(Number(base.unreadCount || 0) + 1, 99);
      return base;
    }).catch(() => { /* best-effort, same as the full app */ });
  });
}

async function send(e) {
  e.preventDefault();
  const tid = mc.tid;
  const uid = mc.user?.uid;
  if (!uid || !tid) return;

  const input = $('mc-input');
  let text = (input?.value || '').trim(); // re-assigned by the emoji fallback below

  // Edit mode: saving replaces sending (no cooldown — the full app doesn't
  // apply one to edits either; the server enforces owner-only).
  if (mc.editMid) return finishEdit(text);

  const u = window.globalUsersCache?.[uid] || {};
  if (u.isBanned) return notify('You are banned from using Hangout Chat.');
  if (window.siteSettings?.pauseChat === true && !isSiteAdmin(uid)) {
    return notify('Chat is temporarily paused by the admin.');
  }
  if (tid === 'global_announcements' && !(u.isAdmin === true || u.isCreator === true)) {
    return notify('Only admins can post announcements.');
  }
  if (!text) {
    // Messenger-style: tapping the emoji button with an empty composer sends
    // the user's preferred emoji (same behaviour as the full app).
    if (!mc.emojiMode) return;
    text = getPreferredEmoji();
  }
  if (!(await cooldownOk(uid))) return;

  const btn = $('mc-send');
  if (btn) btn.disabled = true;
  try {
    const timestamp = Date.now();
    // replyTo must be part of the CREATE payload — server rules only allow
    // it when the message is first written (same as the full app).
    const payload = { senderId: uid, text, timestamp };
    if (mc.replyTo) {
      payload.replyTo = {
        id: mc.replyTo.id,
        senderId: mc.replyTo.senderId,
        text: mc.replyTo.text || '',
        hasImage: Boolean(mc.replyTo.hasImage),
        image: mc.replyTo.image || null
      };
    }
    await push(ref(db, `chatMessages/${tid}`), payload);
    if (input) { input.value = ''; updateSendMode(); }
    clearReply();
    updateStreak(tid); // fire-and-forget — same as the full app
    const item = mc.inbox[tid] || {};
    await updateSummaries(tid, item, text, timestamp, uid);
  } catch (err) {
    notify('Could not send: ' + String(err?.message || err).replace('Firebase: ', ''));
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ------------------------------- exports ------------------------------- */

export function openMiniChat() { open(); }
export function closeMiniChat() { close(); }
export function toggleMiniChat() { mc.open ? close() : open(); }

// Inline-handler surface, matching the rest of the site's global-first style.
window.MiniChat = { open: openMiniChat, close: closeMiniChat, toggle: toggleMiniChat };




