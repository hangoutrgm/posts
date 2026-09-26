// ============================================================
// myday.js — FB-style My Day / stories for the main feed.
//
// Where it lives: the strip replaces the always-visible composer.
// It shows by default; opening the + composer hides the strip.
//
// Data — all in db2 (hangoutrgm2):
//   /notes/{uid} = { text, updatedAt, reactions? }         (chat notes — always shown)
//   /myday/{uid} = { video | pic, createdAt, reactions? }  (one story per user; 24h TTL)
//   /myday_collections/{uid}/{id} = { video | pic, createdAt, hidden? }  (permanent archive — profile section)
//
// Reactions: /notes/{uid}/reactions/{reactorUid} = emoji
//            /myday/{uid}/reactions/{reactorUid} = emoji
// Chat and My Day render the SAME note node, so a react placed on a chat note
// appears on My Day (and vice-versa) with no extra wiring.
// `hidden: true` on a collection entry hides it from everyone except its owner
// (who still sees it dimmed, with the eye toggle to unhide it).
//
// Ordering priority: video stories → pic stories → note-only users.
// Media opens the main site's shared viewer modal (window.viewImage)
// — NOT a full-screen player. Notes open the small note modal.
// ============================================================
import { db2 } from "./firebase-config.js";
import { ref, onValue, set, remove, get, push } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { auth } from "./firebase-config.js";

const STORY_TTL_MS = 24 * 60 * 60 * 1000; // FB-style: media stories last 24h

let myNotes = {};       // uid -> { text, updatedAt }
let myVideos = {};      // uid -> { video, createdAt } (unexpired only)
let myPics = {};        // uid -> { pic, createdAt }   (unexpired only)
let usersReadySeen = false;
let pendingRender = false; // render queued until auth + user names/avatars resolve
let authSettled = false;   // Firebase auth has resolved at least once
let authUid = null;        // the signed-in uid (read from auth itself, not window.currentUser)

// localStorage cache so the strip paints instantly on reload — same pattern
// as users-cache.js and the chat notes cache. Live db2 listeners refresh
// the in-memory state + rewrite the cache on every change.
const MYDAY_CACHE_KEY = 'hangout-mydays-v1';
function cacheAllData() {
    try {
        localStorage.setItem(MYDAY_CACHE_KEY, JSON.stringify({
            notes: myNotes,
            myday: { video: myVideos, pic: myPics },
            savedAt: Date.now()
        }));
    } catch (e) {}
}
function restoreCache() {
    try {
        const raw = localStorage.getItem(MYDAY_CACHE_KEY);
        if (!raw) return;
        const v = JSON.parse(raw);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        if (v.notes && typeof v.notes === 'object' && !Array.isArray(v.notes)) myNotes = v.notes;
        const md = v.myday;
        if (md && typeof md === 'object') {
            if (md.video && typeof md.video === 'object' && !Array.isArray(md.video)) myVideos = md.video;
            if (md.pic && typeof md.pic === 'object' && !Array.isArray(md.pic)) myPics = md.pic;
        }
        // Prune expired media so stale stories never flash before the live listener
        const now = Date.now();
        Object.keys(myVideos).forEach((uid) => { if (Number(myVideos[uid]?.createdAt || 0) <= now - STORY_TTL_MS) delete myVideos[uid]; });
        Object.keys(myPics).forEach((uid) => { if (Number(myPics[uid]?.createdAt || 0) <= now - STORY_TTL_MS) delete myPics[uid]; });
    } catch (e) {}
}

const $ = (id) => document.getElementById(id);

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

// ------------------------------------------------------------
// REACTIONS — shared by My Day stories and notes
// Same 6 emojis chat uses for message reactions, so both match.
// ------------------------------------------------------------
const REACT_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'];

const myUid = () => auth.currentUser?.uid || null;

// [{ emoji, count }] sorted by popularity — powers the card chip.
function reactTotals(reactions) {
    const counts = {};
    Object.values(reactions || {}).forEach((e) => { if (e) counts[e] = (counts[e] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function myReactionOf(reactions) {
    const me = myUid();
    return me ? (reactions && reactions[me]) || null : null;
}

// The story record (video or pic) for a uid — reactions ride along on it.
function storyOf(uid) { return myVideos[uid] || myPics[uid] || null; }

// Emoji row shown inside the note modal: one button per emoji, each carrying its
// own count and highlighted when it is MY reaction (tap again to remove).
function reactRowHtml(target, reactions) {
    const mine = myReactionOf(reactions);
    return REACT_EMOJIS.map((e) => {
        const count = Object.values(reactions || {}).filter((v) => v === e).length;
        return `<button type="button" class="myday-react-btn${mine === e ? ' mine' : ''}" onclick="window.MyDay.react('${target}','${e}')" title="React ${e}">${e}${count ? `<b>${count}</b>` : ''}</button>`;
    }).join('');
}

// Small "👍 3" badge painted on a story / note card — tapping it opens the picker.
function reactChipHtml(target, reactions) {
    const totals = reactTotals(reactions);
    const total = totals.reduce((n, [, c]) => n + c, 0);
    if (!total) {
        return `<span class="myday-react-chip empty" onclick="event.stopPropagation(); window.MyDay.openReactPicker('${target}', this)" title="React to this"><i class="fa-regular fa-face-smile"></i></span>`;
    }
    const mine = myReactionOf(reactions);
    return `<span class="myday-react-chip${mine ? ' mine' : ''}" onclick="event.stopPropagation(); window.MyDay.openReactPicker('${target}', this)" title="React to this">${esc(mine || totals[0][0])}${total > 1 ? ` <b>${total}</b>` : ''}</span>`;
}

// Optimistic local write so a tap repaints before the live listener answers.
function setLocalReaction(uid, isNote, reactor, emoji) {
    const bag = isNote ? myNotes[uid] : storyOf(uid);
    if (!bag) return;
    const rx = { ...(bag.reactions || {}) };
    if (emoji) rx[reactor] = emoji; else delete rx[reactor];
    bag.reactions = Object.keys(rx).length ? rx : null;
}

// Force an MP4 / H.264 delivery URL so Mobile Safari (no .webm playback) and
// Android can always play My Day videos. Cloudinary transcodes on the fly.
function videoPlayUrl(url) {
    return String(url || '').replace('/video/upload/', '/video/upload/f_mp4/');
}

function avatarOf(uid) {
    const u = window.globalUsersCache?.[uid] || {};
    const own = window.currentUser && uid === window.currentUser.uid ? (window.currentUser.photoURL || '') : '';
    const url = u.pic || own;
    return url || (window.generateAvatar ? window.generateAvatar(uid) : `https://api.dicebear.com/7.x/bottts/svg?seed=${uid}&backgroundColor=transparent`);
}

function nameOf(uid) {
    const u = window.globalUsersCache?.[uid];
    let name = u && u.name ? u.name : (window.currentUser && uid === window.currentUser.uid ? 'You' : 'Member');
    if (!name || name === 'undefined') name = uid === window.currentUser?.uid ? 'You' : 'Member';
    return String(name);
}

// videos first (newest first), then pics (newest first), then note-only (newest first)
function orderedUids() {
    const videoUids = Object.keys(myVideos)
        .filter((uid) => myVideos[uid] && myVideos[uid].video)
        .sort((a, b) => (myVideos[b].createdAt || 0) - (myVideos[a].createdAt || 0));
    const picUids = Object.keys(myPics)
        .filter((uid) => myPics[uid] && myPics[uid].pic && !videoUids.includes(uid))
        .sort((a, b) => (myPics[b].createdAt || 0) - (myPics[a].createdAt || 0));
    const noteUids = Object.keys(myNotes)
        .filter((uid) => myNotes[uid] && myNotes[uid].text && !videoUids.includes(uid) && !picUids.includes(uid))
        .sort((a, b) => (myNotes[b].updatedAt || 0) - (myNotes[a].updatedAt || 0));
    return [...videoUids, ...picUids, ...noteUids];
}

// What kind of story this user has: 'video' | 'pic' | 'note' | 'none'
function storyType(uid) {
    if (myVideos[uid] && myVideos[uid].video) return 'video';
    if (myPics[uid] && myPics[uid].pic) return 'pic';
    if (myNotes[uid] && myNotes[uid].text) return 'note';
    return 'none';
}

// A story card for someone else. Tapping the avatar opens their profile;
// tapping anywhere else opens the media / note as before.
function cardHtml(uid) {
    const type = storyType(uid);
    const avatar = esc(avatarOf(uid));
    const name = esc(nameOf(uid));
    const openProfile = `event.stopPropagation(); window.openProfile('${uid}')`;
    const avatarTag = `<span class="myday-card-avatar${type === 'video' ? ' video-ring' : ''}" onclick="${openProfile}" title="View profile"><img src="${avatar}" alt=""></span>`;
    if (type === 'video') {
        return `
    <div class="myday-card" onclick="window.viewImage('${esc(videoPlayUrl(myVideos[uid].video))}')" title="Watch My Day video">
        <img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">
        ${avatarTag}
        <span class="myday-play"><i class="fa-solid fa-play"></i></span>
        ${reactChipHtml(`story:${uid}`, myVideos[uid].reactions)}
        <span class="myday-card-label">${name}</span>
    </div>`;
    }
    if (type === 'pic') {
        return `
    <div class="myday-card" onclick="window.viewImage('${esc(myPics[uid].pic)}')" title="View My Day photo">
        <img class="myday-card-bg" src="${esc(myPics[uid].pic)}" alt="" loading="lazy">
        ${avatarTag}
        ${reactChipHtml(`story:${uid}`, myPics[uid].reactions)}
        <span class="myday-card-label">${name}</span>
    </div>`;
    }
    const noteText = (myNotes[uid]?.text || '').slice(0, 90);
    return `
    <div class="myday-card" onclick="window.MyDay.openNote('${uid}')" title="${esc('Note: ' + noteText)}">
        <img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">
        ${avatarTag}
        <span class="myday-cloud"><span class="myday-cloud-text">${esc(noteText)}</span></span>
        ${reactChipHtml(`note:${uid}`, myNotes[uid]?.reactions)}
        <span class="myday-card-label">${name}</span>
    </div>`;
}

// Merged OWN card — add/replace My Day (photo or video) + preview in one
function ownCardHtml(me) {
    if (!me) {
        return `
    <div class="myday-card own own-empty" onclick="window.MyDay.addMedia()" title="Sign in to add your My Day">
        <span class="myday-card-avatar add-avatar"><i class="fa-solid fa-plus"></i></span>
        <span class="myday-plus" onclick="event.stopPropagation(); window.MyDay.addMedia()" title="Add My Day"><i class="fa-solid fa-plus"></i></span>
        <span class="myday-card-label">My Day</span>
    </div>`;
    }
    const type = storyType(me);
    const avatar = esc(avatarOf(me));
    const hasContent = type !== 'none';
    const openAction = type === 'video'
        ? `window.viewImage('${esc(videoPlayUrl(myVideos[me].video))}')`
        : type === 'pic'
            ? `window.viewImage('${esc(myPics[me].pic)}')`
            : type === 'note'
                ? `window.MyDay.openNote('${me}')`
                : 'window.MyDay.addMedia()';
    const bg = type === 'pic'
        ? `<img class="myday-card-bg" src="${esc(myPics[me].pic)}" alt="" loading="lazy">`
        : (hasContent ? `<img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">` : '');
    const ring = `<span class="myday-card-avatar ${type === 'video' ? 'video-ring' : ''}" onclick="event.stopPropagation(); window.openProfile('${me}')" title="View profile"><img src="${avatar}" alt=""></span>`;
    let body = '';
    if (type === 'video') body = '<span class="myday-play"><i class="fa-solid fa-play"></i></span>';
    else if (type === 'note') body = `<span class="myday-cloud"><span class="myday-cloud-text">${esc((myNotes[me]?.text || '').slice(0, 90))}</span></span>`;
    const removable = type === 'video' || type === 'pic';
    const removeBtn = removable
        ? `<span class="myday-remove" onclick="event.stopPropagation(); window.MyDay.removeStory()" title="Remove My Day"><i class="fa-solid fa-xmark"></i></span>`
        : '';
    return `
    <div class="myday-card own${hasContent ? '' : ' own-empty'}${removable ? ' has-remove' : ''}" onclick="${openAction}" title="${hasContent ? 'My My Day — tap to view, + to add or replace (photo or video)' : 'Add a photo or video to My Day'}">
        ${bg}
        ${ring}
        ${body}
        ${removeBtn}
        <span class="myday-plus" onclick="event.stopPropagation(); window.MyDay.addMedia()" title="Add / replace My Day"><i class="fa-solid fa-plus"></i></span>
        <span class="myday-card-label">My Day</span>
    </div>`;
}

function renderStrip() {
    const strip = $('myday-strip');
    if (!strip) return;
    // Don't paint cards until user names/avatars are available — otherwise
    // every card flashes the generated default avatar for ~1s before real
    // profile pictures load. The ready-timer in initMyDay flushes this.
    if (window.usersReady !== true) { pendingRender = true; return; }
    // Wait for BOTH auth and the users cache so cards always paint with the
    // correct CURRENT account and real avatars — no stale-account or
    // placeholder flashes while logging in / switching users.
    if (!authSettled || window.usersReady !== true) { pendingRender = true; return; }
    pendingRender = false;
    const me = authUid;

    let html = ownCardHtml(me);

    orderedUids().forEach((uid) => {
        if (me && uid === me) return;
        html += cardHtml(uid);
    });

    strip.innerHTML = html;
}

// ------------------------------------------------------------
// MY DAY COLLECTIONS — permanent archive of every My Day upload,
// shown in the user profile (below the Photos section).
//   /myday_collections/{uid}/{pushId} = { pic | video, createdAt, hidden? }
// Read ON DEMAND (one get per user, then cached in memory) so the
// profile never holds a listener on this ever-growing node.
// ------------------------------------------------------------
const collectionsCache = {};    // uid -> [ { id, pic|video, createdAt, hidden } ] (newest first)
const collectionsPending = {};  // uid -> in-flight promise (dedupes rapid re-renders)
let lastCollectionsView = { containerId: null, uid: null }; // re-render target after a hide/unhide

// One archived item — same card look as the feed strip. The avatar opens the
// owner's profile; when the viewer IS the owner, an eye toggle hides/unhides it.
function collectionCardHtml(item, uid, isOwner) {
    const avatar = esc(avatarOf(uid));
    const name = esc(nameOf(uid));
    const profileClick = `event.stopPropagation(); window.openProfile('${uid}')`;
    const hidden = item.hidden === true;
    const avatarTag = `<span class="myday-card-avatar${item.video ? ' video-ring' : ''}" onclick="${profileClick}" title="View profile"><img src="${avatar}" alt=""></span>`;
    const hideTag = isOwner
        ? `<span class="myday-hide" onclick="event.stopPropagation(); window.MyDay.toggleCollectionHidden('${esc(item.id)}', ${hidden ? 'false' : 'true'})" title="${hidden ? 'Unhide — show it on your profile again' : 'Hide — keep it private'}"><i class="fa-solid ${hidden ? 'fa-eye-slash' : 'fa-eye'}"></i></span>`
        : '';
    const cls = `myday-card${hidden ? ' is-hidden' : ''}${isOwner ? ' has-hide' : ''}`;
    if (item.video) {
        return `
    <div class="${cls}" style="height:120px;min-height:120px" onclick="window.viewImage('${esc(videoPlayUrl(item.video))}')" title="Watch My Day video">
        <img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">
        ${avatarTag}
        <span class="myday-play"><i class="fa-solid fa-play"></i></span>
        ${hideTag}
        <span class="myday-card-label">${name}</span>
    </div>`;
    }
    return `
    <div class="${cls}" style="height:120px;min-height:120px" onclick="window.viewImage('${esc(item.pic)}')" title="View My Day photo">
        <img class="myday-card-bg" src="${esc(item.pic)}" alt="" loading="lazy">
        ${avatarTag}
        ${hideTag}
        <span class="myday-card-label">${name}</span>
    </div>`;
}

function fetchCollections(uid) {
    if (collectionsCache[uid]) return Promise.resolve(collectionsCache[uid]);
    if (collectionsPending[uid]) return collectionsPending[uid];
    collectionsPending[uid] = get(ref(db2, `myday_collections/${uid}`))
        .then((snap) => {
            const raw = snap.val() || {};
            collectionsCache[uid] = Object.keys(raw)
                .map((id) => ({ id, ...raw[id] }))
                .filter((it) => it && (it.pic || it.video))
                .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
            return collectionsCache[uid];
        })
        .catch(() => { collectionsCache[uid] = []; return []; })
        .then((items) => { delete collectionsPending[uid]; return items; });
    return collectionsPending[uid];
}

// Fills the profile container. The wrapper stays hidden while there is nothing to show.
async function renderCollections(containerId, uid) {
    if (!uid) {
        const s = $(containerId);
        if (s && s.parentElement) s.parentElement.classList.add('hidden');
        return;
    }
    const items = await fetchCollections(uid);
    // Re-query the container AFTER the await: renderProfileData() rebuilds
    // #profile-header on every user/post/online update, so the node we started
    // with is usually already detached by the time the archive read returns.
    // Always paint into whichever node is live now.
    const box = $(containerId);
    if (!box) return;
    const section = box.parentElement;
    lastCollectionsView = { containerId, uid };
    const isOwner = Boolean(window.currentUser?.uid && window.currentUser.uid === uid);
    // Hidden entries stay private: only the owner still sees them (dimmed, so
    // they can be unhidden again).
    const visible = isOwner ? items : items.filter((it) => it.hidden !== true);
    if (!visible.length) { box.innerHTML = ''; if (section) section.classList.add('hidden'); return; }
    box.innerHTML = visible.map((it) => collectionCardHtml(it, uid, isOwner)).join('');
    if (section) section.classList.remove('hidden');
}

// Every My Day upload is also appended to the user's permanent collection.
// Best-effort: the live story still works even if the archive write fails.
async function archiveMyDay(media) {
    const uid = window.currentUser?.uid;
    if (!uid) return;
    try {
        await push(ref(db2, `myday_collections/${uid}`), media);
        delete collectionsCache[uid]; // refresh on the next profile open
    } catch (e) { /* archive is best-effort */ }
}

// ------------------------------------------------------------
// NOTE MODAL (tap a note card) — avatar opens the profile + reactions row.
// The note node is shared with chat, so reacts land on both surfaces.
// ------------------------------------------------------------
let currentNoteUid = null;

function fillNoteModal(uid) {
    const note = myNotes[uid];
    if (!note || !note.text) return;
    currentNoteUid = uid;
    const avEl = $('myday-note-avatar');
    const nmEl = $('myday-note-name');
    const txEl = $('myday-note-text');
    const barEl = $('myday-note-reactbar');
    if (avEl) { avEl.src = avatarOf(uid); avEl.title = `${nameOf(uid)} — view profile`; }
    if (nmEl) nmEl.textContent = nameOf(uid);
    if (txEl) txEl.textContent = note.text;
    if (barEl) barEl.innerHTML = reactRowHtml(`note:${uid}`, note.reactions);
}

// ------------------------------------------------------------
// REACT PICKER — one small floating emoji row, shared by every card chip
// (the note modal uses the inline row instead).
// ------------------------------------------------------------
let reactPickerEl = null;
let reactPickerTarget = null;

function closeReactPicker() {
    reactPickerTarget = null;
    if (reactPickerEl) reactPickerEl.classList.add('hidden');
}

function ensureReactPicker() {
    if (reactPickerEl) return reactPickerEl;
    reactPickerEl = document.createElement('div');
    reactPickerEl.id = 'myday-react-picker';
    reactPickerEl.className = 'myday-react-picker hidden';
    reactPickerEl.innerHTML = REACT_EMOJIS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
    reactPickerEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-emoji]');
        if (!btn || !reactPickerTarget) return;
        const target = reactPickerTarget;
        closeReactPicker();
        window.MyDay.react(target, btn.dataset.emoji);
    });
    document.body.appendChild(reactPickerEl);
    // Close on any outside click / Escape. The chip stops propagation, so the
    // tap that OPENS the picker never reaches these handlers.
    document.addEventListener('click', (ev) => {
        if (reactPickerEl.classList.contains('hidden')) return;
        if (reactPickerEl.contains(ev.target)) return;
        closeReactPicker();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeReactPicker(); });
    return reactPickerEl;
}

function openReactPicker(targetKey, anchorEl) {
    const el = ensureReactPicker();
    // Tapping the same chip again closes the picker.
    if (reactPickerTarget === targetKey && !el.classList.contains('hidden')) { closeReactPicker(); return; }
    reactPickerTarget = targetKey;
    const [kind, uid] = String(targetKey).split(':');
    const me = myUid();
    const current = kind === 'note' ? myNotes[uid]?.reactions?.[me] : storyOf(uid)?.reactions?.[me];
    el.querySelectorAll('button[data-emoji]').forEach((b) => b.classList.toggle('mine', Boolean(current) && b.dataset.emoji === current));
    el.classList.remove('hidden');
    const rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 40;
    let x = rect ? rect.left + rect.width / 2 - w / 2 : 12;
    let y = rect ? rect.bottom + 6 : 120;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    if (y + h > window.innerHeight - 8) y = Math.max(8, (rect ? rect.top : 120) - h - 6);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
}

// ------------------------------------------------------------
// PUBLIC API + MEDIA UPLOAD (own My Day bubble — photo OR video)
// ------------------------------------------------------------
window.MyDay = {
    openNote: (uid) => {
        if (!myNotes[uid]?.text) return;
        fillNoteModal(uid);
        const modal = $('myday-note-modal');
        if (modal) modal.classList.remove('hidden');
    },
    closeNote: () => {
        const modal = $('myday-note-modal');
        if (modal) modal.classList.add('hidden');
    },
    // Tapping the note avatar opens that member's profile.
    openNoteProfile: () => {
        const uid = currentNoteUid;
        window.MyDay.closeNote();
        if (uid && window.openProfile) window.openProfile(uid);
    },
    openReactPicker,
    closeReactPicker,
    // target = `note:{uid}` (a note) or `story:{uid}` (a My Day photo / video).
    // Tapping the emoji already picked removes it.
    react: async (target, emoji) => {
        const me = myUid();
        if (!me) {
            const am = document.getElementById('auth-modal');
            if (am) am.classList.remove('hidden');
            return;
        }
        const [kind, uid] = String(target || '').split(':');
        if (!uid) return;
        const isNote = kind === 'note';
        const current = (isNote ? myNotes[uid]?.reactions?.[me] : storyOf(uid)?.reactions?.[me]) || null;
        const path = `${isNote ? 'notes' : 'myday'}/${uid}/reactions/${me}`;
        try {
            if (current === emoji) await remove(ref(db2, path));
            else await set(ref(db2, path), emoji);
        } catch (e) {
            window.showToast('Could not react: ' + e.message);
            return;
        }
        // The live db2 listener repaints; update locally first so the tap feels instant.
        setLocalReaction(uid, isNote, me, current === emoji ? null : emoji);
        renderStrip();
        if (isNote && currentNoteUid === uid) fillNoteModal(uid);
    },
    // Owner-only: hide / unhide one archived My Day item from the profile.
    toggleCollectionHidden: async (id, hide) => {
        const uid = myUid();
        if (!uid || !id) return;
        try {
            const itemRef = ref(db2, `myday_collections/${uid}/${id}/hidden`);
            if (hide) await set(itemRef, true);
            else await remove(itemRef);
        } catch (e) {
            window.showToast('Could not update that item: ' + e.message);
            return;
        }
        const items = collectionsCache[uid];
        if (Array.isArray(items)) {
            const it = items.find((x) => x.id === id);
            if (it) it.hidden = hide ? true : null;
        }
        if (lastCollectionsView.containerId) renderCollections(lastCollectionsView.containerId, lastCollectionsView.uid);
        window.showToast(hide ? 'Hidden — only you can see it now.' : 'Visible on your profile again.');
    },
    addMedia: () => {
        if (!window.currentUser) {
            const am = document.getElementById('auth-modal');
            if (am) am.classList.remove('hidden');
            return;
        }
        if (window.checkBan && window.checkBan()) return;
        const input = $('myday-media-input');
        if (input) input.click();
    },
    removeStory: () => {
        if (!window.currentUser) return;
        window.showConfirm('Remove your My Day photo / video?', async () => {
            try {
                await remove(ref(db2, `myday/${window.currentUser.uid}`));
                window.showToast('My Day removed.');
            } catch (e) {
                window.showToast('Could not remove My Day: ' + e.message);
            }
        });
    },
    rerender: renderStrip,
    renderCollections,
    hide: () => { const s = $('myday-strip'); if (s) s.classList.add('hidden'); },
    show: () => { const s = $('myday-strip'); if (s) s.classList.remove('hidden'); },
    isVisible: () => { const s = $('myday-strip'); return Boolean(s && !s.classList.contains('hidden')); }
};

function bindMediaInput() {
    const input = $('myday-media-input');
    if (!input) return;
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
        const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(file.name);
        if (!isVideo && !isImage) return window.showToast('Please choose a photo or video.');

        if (isVideo) {
            const maxMB = Number(window.siteSettings?.videoSizeLimitMB ?? 20);
            if (file.size > maxMB * 1024 * 1024) {
                return window.showToast(`Video is too large. Max size is ${maxMB}MB.`);
            }
        }

        window.showToast('Uploading My Day…');
        try {
            if (isVideo) {
                // Count against the admin's Posts Upload Limits → video quota
                if (window.checkVideoUploadLimit && !window.checkVideoUploadLimit()) return;
                const url = await window.uploadToCloudinary(file, window.currentUser.uid);
                const createdAt = Date.now();
                await set(ref(db2, `myday/${window.currentUser.uid}`), { video: url, createdAt });
                await archiveMyDay({ video: url, createdAt });
                if (window.incrementVideoUploadLimit) window.incrementVideoUploadLimit();
            } else {
                // Count against the admin's Posts Upload Limits → photo quota
                if (window.checkUploadLimit && !window.checkUploadLimit()) return;
                const b64 = await window.compressImage(file);
                const url = await window.uploadToCloudinary(b64, window.currentUser.uid);
                const createdAt = Date.now();
                await set(ref(db2, `myday/${window.currentUser.uid}`), { pic: url, createdAt });
                await archiveMyDay({ pic: url, createdAt });
                if (window.incrementUploadLimit) window.incrementUploadLimit();
            }
            window.showToast('🎬 My Day posted!');
        } catch (e) {
            window.showToast('Could not post My Day: ' + e.message);
        }
    });
}

// ------------------------------------------------------------
// INIT — live listeners
// ------------------------------------------------------------
function initMyDay() {
    const strip = $('myday-strip');
    if (!strip) return;

    // Paint instantly from cache, then let the live listeners take over
    restoreCache();
    renderStrip();

    onValue(ref(db2, 'notes'), (snap) => {
        myNotes = snap.val() || {};
        cacheAllData();
        renderStrip();
    }, () => { });

    onValue(ref(db2, 'myday'), (snap) => {
        const raw = snap.val() || {};
        const now = Date.now();
        myVideos = {};
        myPics = {};
        Object.keys(raw).forEach((uid) => {
            const v = raw[uid];
            if (!v || !Number(v.createdAt) || Number(v.createdAt) <= now - STORY_TTL_MS) return;
            const reactions = (v.reactions && typeof v.reactions === 'object') ? v.reactions : null;
            if (v.video) myVideos[uid] = { video: v.video, createdAt: v.createdAt, reactions };
            else if (v.pic) myPics[uid] = { pic: v.pic, createdAt: v.createdAt, reactions };
        });
        renderStrip();
        cacheAllData();
    }, () => {});

    bindMediaInput();

    // Auth changes (login / logout / switching users) — read the uid straight from
    // auth so the strip always reflects the CURRENT account, never a previous
    // one (window.currentUser is set later by main.js on the same tick).
    onAuthStateChanged(auth, (user) => {
        authSettled = true;
        authUid = user ? user.uid : null;
        renderStrip();
    });

    // Flush any queued render once BOTH auth and the users cache are ready.
    // Safety fallback after 4s so the strip is never left empty.
    usersReadySeen = window.usersReady === true;
    const waitStart = Date.now();
    const readyTimer = setInterval(() => {
        const ready = authSettled === true && window.usersReady === true;
        const timedOut = Date.now() - waitStart > 4000;
        if (ready || timedOut) {
            clearInterval(readyTimer);
            if (!usersReadySeen) { usersReadySeen = true; renderStrip(); }
            else if (pendingRender) renderStrip();
        }
    }, 400);
}

export function init() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMyDay);
    } else {
        initMyDay();
    }
}
init();
window.MyDay.init = initMyDay;