// ============================================================
// myday.js — FB-style My Day / stories for the main feed.
//
// Where it lives: the strip replaces the always-visible composer.
// It shows by default; opening the + composer hides the strip.
//
// Data — all in db2 (hangoutrgm2):
//   /notes/{uid} = { text, updatedAt }           (chat notes — always shown)
//   /myday/{uid} = { video | pic, createdAt }    (one story per user; 24h TTL)
//
// Ordering priority: video stories → pic stories → note-only users.
// Media opens the main site's shared viewer modal (window.viewImage)
// — NOT a full-screen player. Notes open the small note modal.
// ============================================================
import { db2 } from "./firebase-config.js";
import { ref, onValue, set, remove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
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

// A story card for someone else
function cardHtml(uid) {
    const type = storyType(uid);
    const avatar = esc(avatarOf(uid));
    const name = esc(nameOf(uid));
    if (type === 'video') {
        return `
    <div class="myday-card" onclick="window.viewImage('${esc(videoPlayUrl(myVideos[uid].video))}')" title="Watch My Day video">
        <img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">
        <span class="myday-card-avatar video-ring"><img src="${avatar}" alt=""></span>
        <span class="myday-play"><i class="fa-solid fa-play"></i></span>
        <span class="myday-card-label">${name}</span>
    </div>`;
    }
    if (type === 'pic') {
        return `
    <div class="myday-card" onclick="window.viewImage('${esc(myPics[uid].pic)}')" title="View My Day photo">
        <img class="myday-card-bg" src="${esc(myPics[uid].pic)}" alt="" loading="lazy">
        <span class="myday-card-avatar"><img src="${avatar}" alt=""></span>
        <span class="myday-card-label">${name}</span>
    </div>`;
    }
    const noteText = (myNotes[uid]?.text || '').slice(0, 90);
    return `
    <div class="myday-card" onclick="window.MyDay.openNote('${uid}')" title="${esc('Note: ' + noteText)}">
        <img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">
        <span class="myday-card-avatar"><img src="${avatar}" alt=""></span>
        <span class="myday-cloud"><span class="myday-cloud-text">${esc(noteText)}</span></span>
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
    const ring = `<span class="myday-card-avatar ${type === 'video' ? 'video-ring' : ''}"><img src="${avatar}" alt=""></span>`;
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
// PUBLIC API + MEDIA UPLOAD (own My Day bubble — photo OR video)
// ------------------------------------------------------------
window.MyDay = {
    openNote: (uid) => {
        const note = myNotes[uid];
        if (!note || !note.text) return;
        const avEl = $('myday-note-avatar');
        const nmEl = $('myday-note-name');
        const txEl = $('myday-note-text');
        if (avEl) avEl.src = avatarOf(uid);
        if (nmEl) nmEl.textContent = nameOf(uid);
        if (txEl) txEl.textContent = note.text;
        const modal = $('myday-note-modal');
        if (modal) modal.classList.remove('hidden');
    },
    closeNote: () => {
        const modal = $('myday-note-modal');
        if (modal) modal.classList.add('hidden');
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
                await set(ref(db2, `myday/${window.currentUser.uid}`), { video: url, createdAt: Date.now() });
                if (window.incrementVideoUploadLimit) window.incrementVideoUploadLimit();
            } else {
                // Count against the admin's Posts Upload Limits → photo quota
                if (window.checkUploadLimit && !window.checkUploadLimit()) return;
                const b64 = await window.compressImage(file);
                const url = await window.uploadToCloudinary(b64, window.currentUser.uid);
                await set(ref(db2, `myday/${window.currentUser.uid}`), { pic: url, createdAt: Date.now() });
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
            if (v.video) myVideos[uid] = { video: v.video, createdAt: v.createdAt };
            else if (v.pic) myPics[uid] = { pic: v.pic, createdAt: v.createdAt };
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