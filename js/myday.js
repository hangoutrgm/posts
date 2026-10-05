// ============================================================
// myday.js — FB-style My Day / stories for the main feed.
//
// Where it lives: the strip replaces the always-visible composer.
// It shows by default; opening the + composer hides the strip.
//
// Data — all in db2 (hangoutrgm2):
//   /notes/{uid} = { text, updatedAt, reactions?, song? }     (chat notes — always shown)
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
let mydayComments = {}; // postId -> { commentId: { uid, text, timestamp } } (Reels tab)
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

// ----- My Day post ids → reaction target (used by the Reels tab feed) -----
//   `myday_vid_{uid}` / `myday_pic_{uid}` = the user's active 24h story
//     → the shared story node: /myday/{uid}/reactions/{reactor}
//   `myday_arch_{uid}_{itemId}` = one archived upload
//     → that archive entry:    /myday_collections/{uid}/{itemId}/reactions/{reactor}
function parseMyDayPostId(postId) {
    const s = String(postId || '');
    if (s.startsWith('myday_vid_')) return { kind: 'active', uid: s.slice(10) };
    if (s.startsWith('myday_pic_')) return { kind: 'active', uid: s.slice(10) };
    if (s.startsWith('myday_arch_')) {
        const rest = s.slice(11);
        const i = rest.indexOf('_');
        if (i < 0) return null;
        return { kind: 'arch', uid: rest.slice(0, i), itemId: rest.slice(i + 1) };
    }
    return null;
}

// The live reactions object the feed renders for a story (shares the node with
// the original My Day, so a react shows in both places).
function mydayReactionBag(parsed) {
    if (!parsed) return null;
    if (parsed.kind === 'arch') {
        return allCollectionsCache.find((x) => x && x.id === `myday_arch_${parsed.uid}_${parsed.itemId}`) || null;
    }
    return storyOf(parsed.uid);
}

function mydayReactionPath(parsed, reactorUid) {
    if (!parsed || !reactorUid) return null;
    return parsed.kind === 'arch'
        ? `myday_collections/${parsed.uid}/${parsed.itemId}/reactions/${reactorUid}`
        : `myday/${parsed.uid}/reactions/${reactorUid}`;
}

// Tell the owner they were reacted to. Lands on the same RTDB 2 notification
// node the posts page listens to, so it shows in the bell list immediately.
// Never notifies yourself, and never fires for an un-react (toggling off).
function notifyReaction(targetUid, type, emoji, postId) {
    const me = myUid();
    if (!me || !targetUid || targetUid === me) return;
    const payload = { type, sourceUid: me, reactType: emoji, timestamp: Date.now(), read: false };
    // Include the My Day post id when known, so the alert can open that exact post.
    if (postId) payload.postId = postId;
    push(ref(db2, `notifications/${targetUid}`), payload).catch(() => {});
}

// Force an MP4 / H.264 delivery URL so Mobile Safari (no .webm playback) and
// Android can always play My Day videos. Cloudinary transcodes and compresses on the fly.
function videoPlayUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (window.optVideo) return window.optVideo(url, 720);
    return String(url || '').replace('/video/upload/', '/video/upload/f_mp4,q_auto,w_720,c_limit/');
}

function avatarOf(uid) {
    const u = window.globalUsersCache?.[uid] || {};
    const own = window.currentUser && uid === window.currentUser.uid ? (window.currentUser.photoURL || '') : '';
    const url = u.pic || own;
    const finalUrl = url || (window.generateAvatar ? window.generateAvatar(uid) : `https://api.dicebear.com/7.x/bottts/svg?seed=${uid}&backgroundColor=transparent`);
    return window.optAvatar ? window.optAvatar(finalUrl, 100) : finalUrl;
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
        const poster = window.optVideoPoster ? window.optVideoPoster(myVideos[uid].video, 300) : avatar;
        return `
    <div class="myday-card" onclick="window.viewImage('${esc(videoPlayUrl(myVideos[uid].video))}')" title="Watch My Day video">
        <img class="myday-card-bg" src="${esc(poster)}" alt="" loading="lazy">
        ${avatarTag}
        <span class="myday-play"><i class="fa-solid fa-play"></i></span>
        ${reactChipHtml(`story:${uid}`, myVideos[uid].reactions)}
        <span class="myday-card-label">${name}</span>
    </div>`;
    }
    if (type === 'pic') {
        const thumb = window.optMedia ? window.optMedia(myPics[uid].pic, { width: 300 }) : myPics[uid].pic;
        return `
    <div class="myday-card" onclick="window.viewImage('${esc(myPics[uid].pic)}')" title="View My Day photo">
        <img class="myday-card-bg" src="${esc(thumb)}" alt="" loading="lazy">
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
        <span class="myday-cloud"><span class="myday-cloud-text">${myNotes[uid]?.song?.youtubeId ? '🎵 ' : ''}${esc(noteText)}</span></span>
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
    const ownVideoPoster = (window.optVideoPoster && myVideos[me]?.video) ? window.optVideoPoster(myVideos[me].video, 300) : avatar;
    const ownPicThumb = (window.optMedia && myPics[me]?.pic) ? window.optMedia(myPics[me].pic, { width: 300 }) : (myPics[me]?.pic || '');
    const bg = type === 'pic'
        ? `<img class="myday-card-bg" src="${esc(ownPicThumb)}" alt="" loading="lazy">`
        : type === 'video'
            ? `<img class="myday-card-bg" src="${esc(ownVideoPoster)}" alt="" loading="lazy">`
            : (hasContent ? `<img class="myday-card-bg" src="${avatar}" alt="" loading="lazy">` : '');
    const ring = `<span class="myday-card-avatar ${type === 'video' ? 'video-ring' : ''}" onclick="event.stopPropagation(); window.openProfile('${me}')" title="View profile"><img src="${avatar}" alt=""></span>`;
    let body = '';
    if (type === 'video') body = '<span class="myday-play"><i class="fa-solid fa-play"></i></span>';
    else if (type === 'note') body = `<span class="myday-cloud"><span class="myday-cloud-text">${myNotes[me]?.song?.youtubeId ? '🎵 ' : ''}${esc((myNotes[me]?.text || '').slice(0, 90))}</span></span>`;
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
        // Video preview: a Cloudinary poster frame (0s thumbnail), same as the feed strip.
        const poster = window.optVideoPoster ? window.optVideoPoster(item.video, 300) : avatar;
        return `
    <div class="${cls}" style="height:120px;min-height:120px" onclick="window.viewImage('${esc(videoPlayUrl(item.video))}')" title="Watch My Day video">
        <img class="myday-card-bg" src="${esc(poster)}" alt="" loading="lazy">
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
let allCollectionsCache = [];
let allCollectionsLoaded = false;
let allCollectionsInFlight = null;

async function loadAllCollections() {
    if (allCollectionsLoaded) return allCollectionsCache;
    if (allCollectionsInFlight) return allCollectionsInFlight;
    allCollectionsInFlight = get(ref(db2, 'myday_collections'))
        .then((snap) => {
            const raw = snap.val() || {};
            const items = [];
            Object.keys(raw).forEach((uid) => {
                const userStories = raw[uid] || {};
                Object.keys(userStories).forEach((storyId) => {
                    const s = userStories[storyId];
                    if (!s || s.hidden) return;
                    const media = s.video || s.pic;
                    if (!media) return;
                    items.push({
                        id: `myday_arch_${uid}_${storyId}`,
                        authorId: uid,
                        text: '',
                        image: media,
                        category: 'Reels',
                        timestamp: Number(s.createdAt) || Date.now(),
                        reactions: s.reactions || {},
                        isMyDay: true,
                        visibility: 'public'
                    });
                });
            });
            allCollectionsCache = items;
            allCollectionsLoaded = true;
            allCollectionsInFlight = null;
            return allCollectionsCache;
        })
        .catch(() => {
            allCollectionsInFlight = null;
            return [];
        });
    return allCollectionsInFlight;
}

async function archiveMyDay(media) {
    const uid = window.currentUser?.uid;
    if (!uid) return;
    try {
        const newRef = await push(ref(db2, `myday_collections/${uid}`), media);
        delete collectionsCache[uid]; // refresh on the next profile open
        if (allCollectionsLoaded) {
            allCollectionsCache.unshift({
                id: `myday_arch_${uid}_${newRef.key}`,
                authorId: uid,
                text: '',
                image: media.video || media.pic,
                category: 'Reels',
                timestamp: Number(media.createdAt) || Date.now(),
                reactions: {},
                isMyDay: true,
                visibility: 'public'
            });
        }
    } catch (e) { /* archive is best-effort */ }
}

// ------------------------------------------------------------
// NOTE SONG — mirrors the chat note song on the shared /notes/{uid} node.
// Opening the note plays it through a visually-hidden YouTube frame and the
// chip shows a small equalizer while the audio is live; the frame is removed
// on close, which stops the sound.
// ------------------------------------------------------------
let _noteSongFrame = null; // hidden <iframe> currently playing
let _noteSongUid = null;   // uid of the note the frame belongs to
let _noteSongTimer = null; // safety net that cuts a clipped song at its chosen end

function stopNoteSong() {
    if (_noteSongTimer) { clearTimeout(_noteSongTimer); _noteSongTimer = null; }
    if (_noteSongFrame) { _noteSongFrame.remove(); _noteSongFrame = null; }
    _noteSongUid = null;
    $('myday-note-song')?.classList.remove('playing');
}

function playNoteSong(uid, song) {
    stopNoteSong();
    if (!song || !song.youtubeId) return;
    // Optional clip (Messenger-style "only part of the song") — seconds on the note.
    const startAt = Math.floor(Number(song.startAt) || 0);
    const endAt = Math.floor(Number(song.endAt) || 0);
    const hasClip = endAt > startAt;
    const params = ['autoplay=1', 'playsinline=1', 'rel=0'];
    if (startAt > 0) params.push(`start=${startAt}`);
    if (hasClip) params.push(`end=${endAt}`);
    const frame = document.createElement('iframe');
    frame.className = 'myday-note-song-frame';
    frame.title = song.title || 'Note song';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.src = `https://www.youtube.com/embed/${encodeURIComponent(song.youtubeId)}?${params.join('&')}`;
    document.body.appendChild(frame);
    _noteSongFrame = frame;
    _noteSongUid = uid;
    $('myday-note-song')?.classList.add('playing');
    if (hasClip) {
        const clipMs = (endAt - startAt) * 1000;
        const arm = (ms) => { if (_noteSongTimer) clearTimeout(_noteSongTimer); _noteSongTimer = setTimeout(stopNoteSong, ms); };
        // Most embeds stop themselves at `end=`; the timers guarantee the cut even
        // when a browser ignores it. Counting starts when the player document has
        // loaded (autoplay begins right after); the creation-time arm is fallback.
        frame.addEventListener('load', () => arm(clipMs + 800), { once: true });
        arm(clipMs + 5000);
    }
}

function fmtClipTime(sec) {
    const t = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// "0:15–0:30" / "0:00–0:30" / "from 0:15" — shown on the chip when a clip is set.
function noteSongClipLabel(song) {
    const s = Math.floor(Number(song.startAt) || 0);
    const e = Math.floor(Number(song.endAt) || 0);
    if (e > 0 && e > s) return s > 0 ? `${fmtClipTime(s)}–${fmtClipTime(e)}` : `0:00–${fmtClipTime(e)}`;
    if (s > 0) return `from ${fmtClipTime(s)}`;
    return '';
}

// Fill the chip inside the note modal (playback itself starts in openNote, so
// a react re-render never restarts the song).
function fillNoteSongChip(uid, note) {
    const chip = $('myday-note-song');
    if (!chip) return;
    const song = note && note.song && note.song.youtubeId ? note.song : null;
    chip.classList.toggle('hidden', !song);
    if (!song) return;
    $('myday-note-song-thumb').src = `https://i.ytimg.com/vi/${encodeURIComponent(song.youtubeId)}/default.jpg`;
    $('myday-note-song-title').textContent = song.title || 'Untitled';
    const artistEl = $('myday-note-song-artist');
    const clipLabel = noteSongClipLabel(song);
    artistEl.textContent = [song.artist || '', clipLabel].filter(Boolean).join(' · ');
    artistEl.classList.toggle('hidden', !song.artist && !clipLabel);
    const playing = Boolean(_noteSongFrame && _noteSongUid === uid);
    chip.title = playing ? `Stop “${song.title || 'song'}”` : `Play “${song.title || 'song'}”`;
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
    fillNoteSongChip(uid, note);
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
        // composedPath() is captured at dispatch, so a target that a handler already
        // re-rendered away still counts as inside the picker.
        const path = typeof ev.composedPath === 'function' ? ev.composedPath() : null;
        const inside = path ? path.includes(reactPickerEl) : reactPickerEl.contains(ev.target);
        if (inside) return;
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
    ensureAllCollectionsLoaded: () => {
        if (allCollectionsLoaded || allCollectionsInFlight) return;
        loadAllCollections().then(() => {
            if (window.currentFilter === 'Reels' && typeof window.renderFeed === 'function') {
                window.renderFeed(false);
            }
        });
    },
    getAllStoryPosts: () => {
        const posts = [];
        const seenUrls = new Set();
        const now = Date.now();

        // 1. Current active stories (highest priority)
        Object.keys(myVideos).forEach((uid) => {
            const item = myVideos[uid];
            if (item && item.video && Number(item.createdAt || 0) > now - STORY_TTL_MS) {
                seenUrls.add(item.video);
                posts.push({
                    id: `myday_vid_${uid}`,
                    authorId: uid,
                    text: '',
                    image: item.video,
                    category: 'Reels',
                    timestamp: Number(item.createdAt) || now,
                    reactions: item.reactions || {},
                    comments: mydayComments[`myday_vid_${uid}`] || {},
                    isMyDay: true,
                    visibility: 'public'
                });
            }
        });
        Object.keys(myPics).forEach((uid) => {
            const item = myPics[uid];
            if (item && item.pic && Number(item.createdAt || 0) > now - STORY_TTL_MS) {
                seenUrls.add(item.pic);
                posts.push({
                    id: `myday_pic_${uid}`,
                    authorId: uid,
                    text: '',
                    image: item.pic,
                    category: 'Reels',
                    timestamp: Number(item.createdAt) || now,
                    reactions: item.reactions || {},
                    comments: mydayComments[`myday_pic_${uid}`] || {},
                    isMyDay: true,
                    visibility: 'public'
                });
            }
        });

        // 2. All past archived MyDay collections
        // Synchronize with the currently loaded Firestore timeline: only include archived stories
        // down to the oldest post currently fetched from Firestore, or include all if history is complete.
        // This prevents old MyDays (e.g. from 3 weeks ago) from jumping ahead of un-fetched recent photo posts.
        let minLoadedTs = 0;
        if (window.hasMorePosts && Array.isArray(window.allPosts) && window.allPosts.length > 0) {
            for (let i = 0; i < window.allPosts.length; i++) {
                const p = window.allPosts[i];
                if (!p) continue;
                const ts = p.timestamp?.toMillis ? p.timestamp.toMillis() : (typeof p.timestamp === 'number' ? p.timestamp : 0);
                if (ts > 0 && (minLoadedTs === 0 || ts < minLoadedTs)) minLoadedTs = ts;
            }
        }

        allCollectionsCache.forEach((arch) => {
            if (arch && arch.image && !seenUrls.has(arch.image)) {
                const archTs = Number(arch.timestamp) || 0;
                if (!minLoadedTs || archTs >= minLoadedTs || !window.hasMorePosts) {
                    seenUrls.add(arch.image);
                    posts.push({ ...arch, reactions: arch.reactions || {}, comments: mydayComments[arch.id] || {} });
                }
            }
        });

        return posts;
    },
    // Look up a single My Day post by its feed id (myday_vid_/myday_pic_/myday_arch_).
    // Used by goToPost/goToMyDayPost so a comment notification opens the exact post.
    // Reads the live caches directly (no minLoadedTs filter) so archived posts older
    // than the loaded Firestore timeline still resolve.
    getPostById: (postId) => {
        const s = String(postId || '');
        const now = Date.now();
        if (s.startsWith('myday_vid_') || s.startsWith('myday_pic_')) {
            const isVideo = s.startsWith('myday_vid_');
            const uid = s.slice(10);
            const item = isVideo ? myVideos[uid] : myPics[uid];
            const media = item && (isVideo ? item.video : item.pic);
            if (!media) return null;
            return {
                id: s, authorId: uid, text: '', image: media, category: 'Reels',
                timestamp: Number(item.createdAt) || now,
                reactions: item.reactions || {}, comments: mydayComments[s] || {},
                isMyDay: true, visibility: 'public'
            };
        }
        const arch = allCollectionsCache.find((x) => x && x.id === s);
        if (arch) return { ...arch, reactions: arch.reactions || {}, comments: mydayComments[s] || {} };
        return null;
    },
    openNote: (uid) => {
        if (!myNotes[uid]?.text) return;
        fillNoteModal(uid);
        const modal = $('myday-note-modal');
        if (modal) modal.classList.remove('hidden');
        // Opening a note plays its attached song (same behaviour as chat).
        const song = myNotes[uid]?.song;
        if (song && song.youtubeId) playNoteSong(uid, song);
        else stopNoteSong();
    },
    closeNote: () => {
        stopNoteSong();
        const modal = $('myday-note-modal');
        if (modal) modal.classList.add('hidden');
    },
    // Tap the chip in the note modal to stop the audio / start it again.
    toggleNoteSong: () => {
        const uid = currentNoteUid;
        const song = myNotes[uid]?.song;
        if (!song || !song.youtubeId) return;
        const chip = $('myday-note-song');
        if (_noteSongFrame && _noteSongUid === uid) {
            stopNoteSong();
            if (chip) chip.title = `Play “${song.title || 'song'}”`;
        } else {
            playNoteSong(uid, song);
            if (chip) chip.title = `Stop “${song.title || 'song'}”`;
        }
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
        const removing = current === emoji;
        const path = `${isNote ? 'notes' : 'myday'}/${uid}/reactions/${me}`;
        try {
            if (removing) await remove(ref(db2, path));
            else await set(ref(db2, path), emoji);
        } catch (e) {
            window.showToast('Could not react: ' + e.message);
            return;
        }
        // Notify the owner (skipped for your own cards and for un-reacts).
        // A story reaction carries its feed post id so the alert can open that post.
        if (!removing) {
            const story = isNote ? null : storyOf(uid);
            const notifPostId = story ? (story.video ? `myday_vid_${uid}` : `myday_pic_${uid}`) : undefined;
            notifyReaction(uid, isNote ? 'react_note' : 'react_myday', emoji, notifPostId);
        }
        // The live db2 listener repaints; update locally first so the tap feels instant.
        setLocalReaction(uid, isNote, me, current === emoji ? null : emoji);
        renderStrip();
        if (isNote && currentNoteUid === uid) fillNoteModal(uid);
    },
    // Reels-tab reactions. Active stories sync with the shared /myday/{uid}/reactions
    // node (same as the original My Day); an archived upload stores its reactions on
    // that archive entry. Tapping the same emoji removes it.
    reactToPost: async (postId, emoji) => {
        const me = myUid();
        if (!me) {
            const am = document.getElementById('auth-modal');
            if (am) am.classList.remove('hidden');
            return;
        }
        const parsed = parseMyDayPostId(postId);
        if (!parsed || !emoji) return;
        const bag = mydayReactionBag(parsed);
        const removing = (bag?.reactions?.[me] || null) === emoji;
        try {
            const path = mydayReactionPath(parsed, me);
            if (removing) await remove(ref(db2, path));
            else await set(ref(db2, path), emoji);
        } catch (e) {
            window.showToast('Could not react: ' + e.message);
            return;
        }
        if (!removing) notifyReaction(parsed.uid, 'react_myday', emoji, postId);
        // Optimistic local write so the tap repaints before the live listener answers.
        const target = bag || allCollectionsCache.find((x) => x && x.id === postId);
        if (target) {
            const rx = { ...(target.reactions || {}) };
            if (removing) delete rx[me]; else rx[me] = emoji;
            target.reactions = Object.keys(rx).length ? rx : null;
        }
        renderStrip();
        if (typeof window.renderFeed === 'function') window.renderFeed(false);
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

// Owner-only: edit / delete your own My Day comment (stored in RTDB 2).
window.editMyDayComment = (postId, commentId) => {
    const c = mydayComments[postId] && mydayComments[postId][commentId];
    if (!c || !window.currentUser || c.uid !== window.currentUser.uid) return;
    if (typeof window.openEditModal === 'function') {
        window.openEditModal({ path: `myday_comments/${postId}/${commentId}`, postId: postId, db2: true }, c.text);
    }
};
window.deleteMyDayComment = (postId, commentId) => {
    const c = mydayComments[postId] && mydayComments[postId][commentId];
    if (!c || !window.currentUser || c.uid !== window.currentUser.uid) return;
    window.showConfirm('Delete this comment?', async () => {
        try {
            await remove(ref(db2, `myday_comments/${postId}/${commentId}`));
        } catch (e) {
            window.showToast('Could not delete comment: ' + e.message);
        }
    });
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
        if (window.currentFilter === 'Reels' && typeof window.renderFeed === 'function') {
            window.renderFeed(false);
        }
    }, () => {});

    // My Day comments (Reels tab) — RTDB 2, one node keyed by the post id:
    //   /myday_comments/{postId}/{commentId} = { uid, text, timestamp }
    onValue(ref(db2, 'myday_comments'), (snap) => {
        mydayComments = snap.val() || {};
        if (window.currentFilter === 'Reels' && typeof window.renderFeed === 'function') {
            window.renderFeed(false);
        }
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