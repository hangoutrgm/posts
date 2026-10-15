// main.js
import { app, auth, db, db2, db3, fsdb, fsdb2, fsdb3, getPostDocRef, getFirestoreForPost, getRoundRobinFsdb, getFirestoreBySource, getSourceByFirestore } from "./firebase-config.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, push, onValue, get, set, update, remove, increment, runTransaction, onDisconnect, serverTimestamp, query as dbQuery, limitToLast, onChildAdded, onChildChanged, onChildRemoved } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, doc, addDoc, getDoc, getDocs, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, where, serverTimestamp as fsServerTimestamp, startAfter, deleteField } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
window._getDocsFS = getDocs; // expose for loadMorePosts cursor pagination

// Local imports MUST carry the same ?v= as index.html's <script> tags. A query string
// makes a distinct module URL, so an unversioned "./helpers.js" here would be fetched and
// evaluated a second time alongside index.html's "js/helpers.js?v=66" (same for
// renderers.js, ~257 KB). Keep these versions in lockstep with index.html and sw.js.
import "./helpers.js?v=76";
import "./renderers.js?v=101";

let presenceInterval = null;
let serverTimeOffset = 0;

// Track our own session start time locally — avoids a get() RTDB download every heartbeat
const presenceSessionStart = Date.now();

onValue(ref(db, '.info/serverTimeOffset'), snap => {
    serverTimeOffset = snap.val() || 0;
});

window.allPosts = window.allPosts || [];
window.globalPinnedPosts = window.globalPinnedPosts || [];
window.profilePinnedPosts = window.profilePinnedPosts || [];
window.usersReady = (typeof window.usersReady === 'boolean') ? window.usersReady : false;
window._pendingPostRender = (typeof window._pendingPostRender === 'boolean') ? window._pendingPostRender : false;

const presenceSessionId = `posts_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const presenceSessionRef = (uid) => ref(db, `presence/${uid}/${presenceSessionId}`);

function startOwnPresence(user = auth.currentUser) {
    if (!user) return;
    const sessionRef = presenceSessionRef(user.uid);
    onDisconnect(sessionRef).remove();
    
    set(sessionRef, serverTimestamp());
    
    if (presenceInterval) clearInterval(presenceInterval);
    
    // Heartbeat every 2 min (was 60s). Each heartbeat write triggers every other
    // client's presence listeners; halving the rate halves that event flood while
    // "online" still updates within 2 minutes — invisible to users.
    presenceInterval = setInterval(async () => {
        try {
            // Just write our own heartbeat — no get() download needed
            await set(sessionRef, serverTimestamp());
        } catch(e) {}
    }, 120000);

    ensurePresenceWatch(user);
}

// Self-heal watcher: the 1-minute presence sweeper (below) deletes ALL presence
// entries so a stale session (e.g. a tab whose WebSocket stayed alive after the
// user walked away) can't keep that user shown as online. If THIS user is truly
// online and the tab is visible, we re-add our own session instantly so we never
// flicker off the members list.
function ensurePresenceWatch(user = auth.currentUser) {
    if (!user) return;
    if (window._presenceWatchUid === user.uid && window._presenceWatchUnsub) return;
    if (window._presenceWatchUnsub) window._presenceWatchUnsub();
    const uid = user.uid;
    window._presenceWatchUid = uid;
    window._presenceWatchUnsub = onValue(ref(db, `presence/${uid}`), (snap) => {
        const val = snap.val();
        const hasAny = val && typeof val === 'object' && Object.keys(val).length > 0;
        if (!hasAny && !document.hidden && auth.currentUser && auth.currentUser.uid === uid) {
            startOwnPresence(auth.currentUser);
        }
    });
}

function stopOwnPresence(user = auth.currentUser) {
    if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
    }
    if (window._presenceWatchUnsub) {
        window._presenceWatchUnsub();
        window._presenceWatchUnsub = null;
        window._presenceWatchUid = null;
    }
    if (user) {
        const sessionRef = presenceSessionRef(user.uid);
        onDisconnect(sessionRef).cancel();
        return remove(sessionRef);
    }
    return Promise.resolve();
}

// ==========================================
// PRESENCE SWEEPER — admin-controlled via /config → settings.presenceSweepSec.
// 0 = off. When set (>= 15 sec), ONLY the admin's own signed-in client checks
// the /presence node at that cadence. If it currently shows MORE THAN ONE
// online user, the whole node is removed (the exact same thing as deleting it
// manually in the Firebase console). No buckets, no transactions, no rule
// changes: "presence/.write: auth != null" already lets a signed-in user
// remove the node, and gating to admin means only ONE client ever wipes it.
// ==========================================
let lastPresenceSweepAt = 0;
setInterval(() => {
    const sec = Number(window.siteSettings?.presenceSweepSec);
    if (!(Number.isFinite(sec) && sec >= 15)) return;
    if (document.visibilityState !== 'visible' || !auth.currentUser) return;
    // Admin-only gate so a single client (the admin's) performs the wipe.
    const myLevel = window.getRole ? window.getRole(auth.currentUser.uid).level : 0;
    const isAdmin = auth.currentUser.uid === 'IrcAY3gUELNjiRUhMkr7muxNIpm2' || myLevel === 3;
    if (!isAdmin) return;
    // Honour the configured cadence (live changes to the setting take effect).
    const now = Date.now();
    if (now - lastPresenceSweepAt < sec * 1000) return;
    lastPresenceSweepAt = now;
    // Wipe only when the node shows more than 1 online user, like a manual delete.
    get(ref(db, 'presence')).then((snap) => {
        const p = snap.val();
        if (p && typeof p === 'object' && Object.keys(p).length > 1) {
            remove(ref(db, 'presence')).catch(() => {});
        }
    }).catch(() => {});
}, 5000);

// Same-IP LB shield: keep the flagged-groups mirror fresh on every client even if
// the admin just flagged a new group (tiny ~1KB node — 10-min cadence keeps cost ~0).
setInterval(() => {
    if (window.currentUser && window.refreshFlaggedGroups) window.refreshFlaggedGroups();
}, 10 * 60 * 1000);

// ==========================================
// SEARCH & FILTERS
// ==========================================
document.getElementById('post-search').addEventListener('input', window.debounce(() => window.renderFeed(true), 300));
document.getElementById('member-search').addEventListener('input', window.debounce(() => window.renderMembers(true), 300));

// In-memory tab session cache to eliminate duplicate Firestore reads on tab switching
window._filterCache = window._filterCache || {};

window._saveFilterState = (filterKey) => {
    if (!filterKey) return;
    window._filterCache[filterKey] = {
        allPosts: window.allPosts ? [...window.allPosts] : [],
        historyPosts1: window._historyPosts1 ? [...window._historyPosts1] : [],
        historyPosts2: window._historyPosts2 ? [...window._historyPosts2] : [],
        historyPosts3: window._historyPosts3 ? [...window._historyPosts3] : [],
        historyPosts: window._historyPosts ? [...window._historyPosts] : [],
        lastPostDoc1: window._lastPostDoc1,
        lastPostDoc2: window._lastPostDoc2,
        lastPostDoc3: window._lastPostDoc3,
        liveLastDoc1: window._liveLastDoc1,
        liveLastDoc2: window._liveLastDoc2,
        liveLastDoc3: window._liveLastDoc3,
        hasMorePosts1: window.hasMorePosts1,
        hasMorePosts2: window.hasMorePosts2,
        hasMorePosts3: window.hasMorePosts3,
        hasMorePosts: window.hasMorePosts,
        feedRenderLimit: window.feedRenderLimit || 15,
        savedAt: Date.now()
    };
};

window._restoreFilterState = (filterKey) => {
    const cached = window._filterCache && window._filterCache[filterKey];
    if (!cached || !cached.allPosts || cached.allPosts.length === 0) return false;
    window.allPosts = [...cached.allPosts];
    window._historyPosts1 = [...cached.historyPosts1];
    window._historyPosts2 = [...cached.historyPosts2];
    window._historyPosts3 = [...cached.historyPosts3];
    window._historyPosts = [...cached.historyPosts];
    window._lastPostDoc1 = cached.lastPostDoc1;
    window._lastPostDoc2 = cached.lastPostDoc2;
    window._lastPostDoc3 = cached.lastPostDoc3;
    window._liveLastDoc1 = cached.liveLastDoc1;
    window._liveLastDoc2 = cached.liveLastDoc2;
    window._liveLastDoc3 = cached.liveLastDoc3;
    window.hasMorePosts1 = cached.hasMorePosts1;
    window.hasMorePosts2 = cached.hasMorePosts2;
    window.hasMorePosts3 = cached.hasMorePosts3;
    window.hasMorePosts = cached.hasMorePosts;
    window.feedRenderLimit = cached.feedRenderLimit;
    return true;
};

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        window.clearIsolatedPost();
        const prevFilter = window.currentFilter;
        const newFilter = e.currentTarget.getAttribute('data-cat');
        const isExplicitRefresh = (prevFilter === newFilter);

        document.querySelectorAll('.filter-btn').forEach(b => { 
            b.classList.remove('bg-blue-600', 'text-white'); 
            b.classList.add('bg-gray-200', 'text-gray-700', 'dark:bg-slate-800', 'dark:text-gray-300'); 
        });
        e.currentTarget.classList.add('bg-blue-600', 'text-white'); 
        e.currentTarget.classList.remove('bg-gray-200', 'text-gray-700', 'dark:bg-slate-800', 'dark:text-gray-300');

        // Save state of outgoing filter before switching
        if (!isExplicitRefresh && prevFilter) {
            window._saveFilterState(prevFilter);
        }

        window.currentFilter = newFilter;

        // Serve from memory cache if recently visited (0 reads!), unless clicking current tab to refresh
        const cached = window._filterCache && window._filterCache[newFilter];
        const isCacheFresh = cached && (Date.now() - (cached.savedAt || 0) < 5 * 60 * 1000);

        if (!isExplicitRefresh && isCacheFresh && window._restoreFilterState(newFilter)) {
            if (window.postsUnsubscribe1) { window.postsUnsubscribe1(); window.postsUnsubscribe1 = null; }
            if (window.postsUnsubscribe2) { window.postsUnsubscribe2(); window.postsUnsubscribe2 = null; }
            if (window.postsUnsubscribe3) { window.postsUnsubscribe3(); window.postsUnsubscribe3 = null; }
            if (typeof window.postsUnsubscribe === 'function') { window.postsUnsubscribe(); window.postsUnsubscribe = null; }
            window.renderFeed(false);
            return;
        }

        window.postLimit = 15;
        window.feedRenderLimit = 15;
        window.hasMorePosts = true;
        window.listenPosts();
    });
});

// Floating action stack (mother button + three tools). Collapsed, only the
// mother (#floating-menu-btn) shows; body.fab-open fans the tools out at their
// fixed spots (refresh 24px → music 84px → create 144px) and hides the mother.
// Tapping a tool runs window.closeFabMenu() first (inline in index.html);
// tapping anywhere outside or pressing Escape closes the stack too.
const _setFabOpen = (open) => {
    document.body.classList.toggle('fab-open', open);
    const mother = document.getElementById('floating-menu-btn');
    if (mother) mother.setAttribute('aria-expanded', open ? 'true' : 'false');
};
window.toggleFabMenu = () => _setFabOpen(!document.body.classList.contains('fab-open'));
window.closeFabMenu = () => _setFabOpen(false);
document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('fab-open')) return;
    if (e.target && e.target.closest && e.target.closest('#floating-menu-btn, .fab-retract')) return;
    window.closeFabMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.closeFabMenu(); });

// Floating "back to top" refresh button (bottom-right, above the music button):
// smooth-scrolls the feed to the top, then refreshes it in place — the path of
// clicking the active category tab. ORDER MATTERS: the refresh repaint swaps the
// whole feed (pagination history gone, images not yet loaded), which transiently
// shrinks the page — a shrink DURING the smooth animation clamps the scroll and
// cancels it, stranding the user partway up (it used to take several taps to
// reach the top). So the refresh fires only once the glide lands, with a 2.5s
// fallback. The page itself never reloads; pull-to-refresh is disabled in
// css/styles.css, so this button is the way to refresh. Debounced to one refresh
// per second: every refresh tears down and re-creates the Firestore Listen
// channels, and hammering that on a weak network floods the console with
// reconnect/QUIC noise.
let _feedRefreshAt = 0;
let _pendingFeedRefresh = null;
window.refreshFeedFromTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const now = Date.now();
    if (now - _feedRefreshAt < 1000) return; // rapid taps only scroll
    _feedRefreshAt = now;
    // Refresh only AFTER the glide lands. The post-refresh repaint swaps the whole
    // feed (pagination history gone, images not yet loaded), which transiently
    // shrinks the page — a shrink DURING the smooth animation clamps the scroll
    // and cancels it, stranding the user partway up (it took several taps before).
    // Poll for arrival at the top, with a 2.5s fallback so the refresh always runs.
    if (_pendingFeedRefresh) clearInterval(_pendingFeedRefresh);
    const startedAt = Date.now();
    _pendingFeedRefresh = setInterval(() => {
        if (window.scrollY > 0 && Date.now() - startedAt <= 2500) return;
        clearInterval(_pendingFeedRefresh);
        _pendingFeedRefresh = null;
        // Spotlight posts clear before the re-listen — only when one is open.
        if (window.isolatedPostId && typeof window.clearIsolatedPost === 'function') window.clearIsolatedPost();
        window.postLimit = 15;
        window.hasMorePosts = true;
        window.listenPosts();
        const btn = document.getElementById('floating-refresh-btn');
        if (btn) {
            btn.classList.remove('spinning');
            void btn.offsetWidth; // reflow so the spin restarts on rapid taps
            btn.classList.add('spinning');
        }
    }, 80);
};

document.querySelectorAll('.member-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget;
        document.querySelectorAll('.member-filter-btn').forEach(b => { 
            b.classList.remove('bg-blue-600', 'text-white', 'border-transparent'); 
            b.classList.add('bg-gray-100', 'text-gray-700', 'dark:bg-slate-900', 'dark:text-gray-300', 'border-gray-200', 'dark:border-slate-700'); 
        });
        targetBtn.classList.add('bg-blue-600', 'text-white', 'border-transparent'); 
        targetBtn.classList.remove('bg-gray-100', 'text-gray-700', 'dark:bg-slate-900', 'dark:text-gray-300', 'border-gray-200', 'dark:border-slate-700');
        window.currentMemberFilter = targetBtn.getAttribute('data-filter');
        window.renderMembers(true);
    });
});

window.currentRankingFilter = 'Leaderboards';
document.querySelectorAll('.ranking-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetBtn = e.currentTarget;
        document.querySelectorAll('.ranking-filter-btn').forEach(b => { 
            b.classList.remove('bg-blue-600', 'text-white', 'border-transparent'); 
            b.classList.add('bg-gray-100', 'text-gray-700', 'dark:bg-slate-900', 'dark:text-gray-300', 'border-gray-200', 'dark:border-slate-700'); 
        });
        targetBtn.classList.add('bg-blue-600', 'text-white', 'border-transparent'); 
        targetBtn.classList.remove('bg-gray-100', 'text-gray-700', 'dark:bg-slate-900', 'dark:text-gray-300', 'border-gray-200', 'dark:border-slate-700');
        window.currentRankingFilter = targetBtn.getAttribute('data-filter');
        window._earningsCache = null;
        window._hostedGamesCache = null;
        window._recruitLbCache = null;
        if (window.updateLbPeriodBar) window.updateLbPeriodBar();
        if (window.renderRankings) window.renderRankings(true);
    });
});

// ==========================================
// V6.1 & V6.2 FEATURES: VISIBILITY & MENTIONS
// ==========================================
window.postVisibility = 'public';
window.currentMentionMatch = null;

// V6.2 & V6.9 OVERRIDE: Upgraded notification system with @everyone and @mods capability
window.notifyMentions = (text, postId) => {
    if(!window.currentUser) return;
    const myRole = window.getRole(window.currentUser.uid).level;
    const notifiedUids = new Set();
    const textLower = text.toLowerCase();
    
    // Check if user is Mod/Admin and triggered @everyone
    if (myRole >= 2 && textLower.includes('@everyone')) {
        Object.keys(window.globalUsersCache).forEach(uid => {
            const u = window.globalUsersCache[uid];
            // Skip self and guests
            if (uid !== window.currentUser.uid && !u.isGuest && !(u.name && u.name.startsWith("Guest_"))) {
                push(ref(db2, `notifications/${uid}`), {
                    type: 'mention', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false
                });
                notifiedUids.add(uid);
            }
        });
    }
    
    // Check for @mods — only mods/admins can use this
    if (myRole >= 2 && textLower.includes('@mods')) {
        Object.keys(window.globalUsersCache).forEach(uid => {
            // Notify if user is Mod/Admin, not self, and not already notified
            if (uid !== window.currentUser.uid && !notifiedUids.has(uid) && window.getRole(uid).level >= 2) {
                push(ref(db2, `notifications/${uid}`), {
                    type: 'mention', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false
                });
                notifiedUids.add(uid);
            }
        });
    }
    
    // Standard Individual Mentions
    const matches = text.match(/@(\w+)/g);
    if(matches) {
        matches.forEach(match => {
            const name = match.substring(1).toLowerCase();
            const targetUser = Object.values(window.globalUsersCache).find(u => u.name && u.name.toLowerCase() === name);
            if(targetUser && targetUser.uid !== window.currentUser.uid && !notifiedUids.has(targetUser.uid)) {
                push(ref(db2, `notifications/${targetUser.uid}`), {
                    type: 'mention', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false
                });
                notifiedUids.add(targetUser.uid);
            }
        });
    }
};

const setupVisibilityToggle = () => {
    const initToggle = () => {
        const submitBtn = document.getElementById('submit-post-btn');
        if (submitBtn && !document.getElementById('visibility-toggle-btn')) {
            const eyeBtn = document.createElement('button');
            eyeBtn.id = 'visibility-toggle-btn';
            eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 mr-1 text-xs"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
            eyeBtn.className = 'px-2.5 py-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 transition flex items-center shrink-0 cursor-pointer border border-gray-200 dark:border-slate-600 text-xs';
            eyeBtn.title = "Public Post";
            
            eyeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.postVisibility === 'public') {
                    window.postVisibility = 'private';
                    eyeBtn.innerHTML = '<i class="fas fa-eye-slash text-gray-400 mr-1 text-xs"></i><span class="text-xs font-bold text-gray-500">Private</span>';
                    eyeBtn.title = "Private Post (Only you and mentioned users)";
                    if(window.showAlert) window.showAlert("Post set to Private");
                } else {
                    window.postVisibility = 'public';
                    eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 mr-1 text-xs"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
                    eyeBtn.title = "Public Post";
                    if(window.showAlert) window.showAlert("Post set to Public");
                }
            });
            
            // Insert inside the flex group div, before the Post button
            submitBtn.parentNode.insertBefore(eyeBtn, submitBtn);
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initToggle);
    } else {
        initToggle();
    }
};

const setupMentionSystem = () => {
    const initMention = () => {
        let suggestionBox = document.getElementById('mention-suggestions-box');
        if (!suggestionBox) {
            suggestionBox = document.createElement('div');
            suggestionBox.id = 'mention-suggestions-box';
            suggestionBox.className = 'hidden absolute z-[120] bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 shadow-lg rounded-md mt-1 overflow-y-auto max-h-48';
            document.body.appendChild(suggestionBox);
        }

        let activeInput = null;

        document.addEventListener('input', (e) => {
            const target = e.target;
            if (!target.matches('textarea, input[type="text"]')) return;

            const text = target.value;
            const cursorPosition = target.selectionStart;
            const textBeforeCursor = text.substring(0, cursorPosition);
            
            const match = textBeforeCursor.match(/@(\w*)$/);

            if (match) {
                activeInput = target;
                const query = match[1].toLowerCase();
                window.currentMentionMatch = { query, start: match.index, end: cursorPosition };
                
                const myRole = window.currentUser ? window.getRole(window.currentUser.uid).level : 0;
                const allUsers = Object.values(window.globalUsersCache || {});
                let matchedUsers = allUsers.filter(u => u.name && u.name.toLowerCase().includes(query)).slice(0, 5);
                
                // V6.9 FEATURE: @mods suggestion — only visible to mods/admins
                if (myRole >= 2 && "mods".includes(query)) {
                    matchedUsers.unshift({ name: "mods", isMods: true });
                }
                
                // V6.2 FEATURE: @everyone suggestion for Mods and Admins
                if (myRole >= 2 && "everyone".includes(query)) {
                    matchedUsers.unshift({ name: "everyone", isEveryone: true });
                }
                
                if (matchedUsers.length > 0) {
                    suggestionBox.innerHTML = '';
                    matchedUsers.forEach(u => {
                        const item = document.createElement('div');
                        item.className = 'p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 transition';
                        
                        let iconHtml = `<img src="${u.pic || window.generateAvatar(u.uid || 'guest')}" class="w-6 h-6 rounded-full object-cover">`;
                        if (u.isEveryone) iconHtml = `<div class="w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] shadow-sm"><i class="fa-solid fa-bullhorn"></i></div>`;
                        else if (u.isMods) iconHtml = `<div class="w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center text-[10px] shadow-sm"><i class="fa-solid fa-shield"></i></div>`;

                        let textClass = '';
                        if (u.isEveryone) textClass = 'font-bold text-red-500';
                        else if (u.isMods) textClass = 'font-bold text-green-500';

                        item.innerHTML = `${iconHtml} <span class="${textClass}">${u.name}</span>`;
                        
                        item.addEventListener('mousedown', (ev) => {
                            ev.preventDefault(); 
                            const currentText = activeInput.value;
                            const newText = currentText.substring(0, window.currentMentionMatch.start) + `@${u.name} ` + currentText.substring(window.currentMentionMatch.end);
                            activeInput.value = newText;
                            suggestionBox.classList.add('hidden');
                            activeInput.focus();
                        });
                        suggestionBox.appendChild(item);
                    });

                    const rect = activeInput.getBoundingClientRect();
                    suggestionBox.style.top = `${rect.bottom + window.scrollY}px`;
                    suggestionBox.style.left = `${rect.left + window.scrollX}px`;
                    suggestionBox.style.width = `${Math.min(300, Math.max(200, rect.width))}px`;

                    suggestionBox.classList.remove('hidden');
                } else {
                    suggestionBox.classList.add('hidden');
                }
            } else {
                suggestionBox.classList.add('hidden');
                window.currentMentionMatch = null;
            }
        });

        document.addEventListener('focusout', (e) => {
            if (activeInput && e.target === activeInput) {
                setTimeout(() => suggestionBox.classList.add('hidden'), 200);
            }
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMention);
    } else {
        initMention();
    }
};

setupVisibilityToggle();
setupMentionSystem();

// ==========================================
// Typing Detection (v6.3)
// ==========================================

document.addEventListener("input", (e) => {
    if (
        e.target.tagName === "TEXTAREA" ||
        (e.target.tagName === "INPUT" &&
         (e.target.type === "text" || e.target.type === "search"))
    ) {

        window.isUserTyping = true;

        clearTimeout(window.typingTimer);

        window.typingTimer = setTimeout(() => {
            window.isUserTyping = false;

            // refresh once after typing stops
            if (window.activeProfileUid)
                window.renderProfileData(false);
            else
                window.renderFeed(false);

        }, 1000);
    }
});


// ==========================================
// DB LISTENERS
// ==========================================

// ==========================================
// AUTHENTICATION & INITIALIZATION
// ==========================================
window.lastNotifTime = Date.now();

window.requestNotificationPermission = async () => {
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
        try { await Notification.requestPermission(); } catch(e) {}
    }
};

onValue(ref(db, '.info/connected'), (snap) => {
    if (snap.val() === true && auth.currentUser) {
        startOwnPresence(auth.currentUser);
    }
});

onValue(ref(db, 'settings'), (snap) => {
    // The server has answered, so the settings are now known — whether it returned data
    // or nothing (in which case the hardcoded defaults are legitimately authoritative).
    // Until this point they are NOT: see helpers.js / globals.js siteSettingsLoaded note
    // and games.js getGameMaxLb(), which uses a conservative fallback in the meantime.
    window.siteSettingsLoaded = true;
    if (snap.exists()) {
        const prevHideAnswers = window.siteSettings.hideHostGameAnswers;
        window.siteSettings = { ...window.siteSettings, ...snap.val() };
        // Keep the Post-a-Game LB cap label/input in sync (covers both "settings arrived
        // after the modal was opened" and "admin changed the cap mid-session").
        if (typeof window.refreshGameLbCapUi === 'function') window.refreshGameLbCapUi();
        // Site Control → "Hide Host Game Answers" toggled in /config: re-render
        // immediately so hosts see the change without a refresh.
        if (window.siteSettings.hideHostGameAnswers !== prevHideAnswers) {
            if (window.usersReady && window.renderFeed) window.renderFeed(false);
            if (window.activeProfileUid && window.renderProfileData) window.renderProfileData(false);
        }
        // Same-IP LB shield: when it's switched ON, refresh flagged groups right
        // away so the next game award sees the groups even if the interval hasn't fired.
        if (window.siteSettings.zeroLbForFlaggedPair === true) window.refreshFlaggedGroups?.();
    }
});

// ============================================================
// PRESENCE LISTENER — Granular child listeners instead of full-tree onValue.
// onValue(ref(db, 'presence')) downloads the ENTIRE presence tree on every
// heartbeat (~every 60s), causing hundreds of MB of RTDB downloads per session.
// Using onChildAdded/Changed/Removed only streams the individual user entry
// that changed (~50 bytes), not the full tree.
// ============================================================
window.onlineUsers = {};

const _pendingUserFetches = new Set();
window.ensureSingleUserLoaded = async (uid) => {
    if (!uid || _pendingUserFetches.has(uid)) return;
    _pendingUserFetches.add(uid);
    try {
        const snap = await get(ref(db, `users/${uid}`));
        if (snap.exists()) {
            const userData = snap.val() || {};
            window.globalUsersCache[uid] = userData;
            if (window.usersCache?.updateUser) window.usersCache.updateUser(uid, userData);
            if (!document.getElementById('members-modal')?.classList.contains('hidden')) {
                window.renderMembers(false);
            }
            if (window.activeProfileUid === uid) window.renderProfileData(false);
        }
    } catch (e) {
        console.warn('Targeted user fetch failed for', uid, e);
    } finally {
        _pendingUserFetches.delete(uid);
    }
};

onChildAdded(ref(db, 'presence'), (snap) => {
    const uid = snap.key;
    window.onlineUsers[uid] = snap.val();
    const count = Object.keys(window.onlineUsers).length;
    const countEl = document.getElementById('online-count');
    if (countEl) countEl.innerText = count;

    if (uid && (!window.globalUsersCache[uid] || !window.globalUsersCache[uid].name)) {
        window.ensureSingleUserLoaded(uid);
    } else {
        if (!document.getElementById('members-modal')?.classList.contains('hidden')) window.renderMembers(false);
        if (window.activeProfileUid) window.renderProfileData(false);
    }
});

onChildChanged(ref(db, 'presence'), (snap) => {
    // Only update memory cache, do not trigger DOM reflow on every 60s heartbeat
    const uid = snap.key;
    window.onlineUsers[uid] = snap.val();
    if (uid && (!window.globalUsersCache[uid] || !window.globalUsersCache[uid].name)) {
        window.ensureSingleUserLoaded(uid);
    }
});

onChildRemoved(ref(db, 'presence'), (snap) => {
    delete window.onlineUsers[snap.key];
    const count = Object.keys(window.onlineUsers).length;
    const countEl = document.getElementById('online-count');
    if (countEl) countEl.innerText = count;
    if (!document.getElementById('members-modal')?.classList.contains('hidden')) window.renderMembers(false);
    if (window.activeProfileUid) window.renderProfileData(false);
});

window._updateNavUserUI = () => {
    if (window.currentUser && window.globalUsersCache[window.currentUser.uid]) {
        if (window.globalUsersCache[window.currentUser.uid].pic) {
            document.getElementById('nav-avatar').src = window.globalUsersCache[window.currentUser.uid].pic;
        }
        
        const role = window.getRole(window.currentUser.uid);
        document.querySelectorAll('.mod-only').forEach(opt => {
            if (role.level === 1) { opt.classList.add('hidden'); opt.disabled = true; }
            else { opt.classList.remove('hidden'); opt.disabled = false; }
        });
        const catSelect = document.getElementById('post-category');
        if (role.level === 1 && (catSelect.value === 'Announcements' || catSelect.value === 'Rules')) catSelect.value = 'General';
    }
    window.updateAdminButtons && window.updateAdminButtons();
};

// Granular Users Loading — download-saver refactor.
// Instead of re-downloading the ENTIRE /users table on every page load (get + 3
// whole-table child listeners each baseline-fetch the full tree), we now:
//   1. Apply a shared localStorage cache (≤2 min old) instantly on load — no RTDB read.
//   2. Fetch fresh /users only when the cache is stale/missing (one get).
//   3. Keep a LIVE single-user listener for the signed-in user (avatar/role/points).
//   4. Refresh on demand when the Members modal opens / a profile is viewed.
// Whole-table child listeners are gone (they re-downloaded everything per event).
let _lastUsersFreshCheck = 0;
window.applyUsersData = (raw) => {
    const wasReady = window.usersReady;
    window.globalUsersCache = raw || {};
    window.writeUsersCache && window.writeUsersCache(window.globalUsersCache);
    window.usersReady = true;
    if (!wasReady && window._pendingPostRender) {
        window._pendingPostRender = false;
        window.renderFeed(false);
    } else {
        if (window.activeProfileUid) window.renderProfileData(false);
        else window.renderFeed(false);
    }
    if (!document.getElementById('members-modal').classList.contains('hidden')) window.renderMembers(false);
    window._updateNavUserUI();
    window.handleDeepLinks();
};

window.ensureUsersFresh = async () => {
    const now = Date.now();
    if (now - _lastUsersFreshCheck < 300000) return; // 5 minutes debounce (bandwidth saver)
    _lastUsersFreshCheck = now;
    const cached = window.usersCache ? window.usersCache.read() : null;
    if (cached && window.usersCache.isFresh(cached)) return; // already fresh enough
    try {
        const snap = await get(ref(db, 'users'));
        window.applyUsersData(snap.val() || {});
    } catch (e) { /* keep last known */ }
};

// Manual "refresh" button in the Members modal. Bypasses the ensureUsersFresh
// debounce AND the localStorage freshness window so the list always reflects
// the latest /users data (applyUsersData rewrites the cache and repaints the
// open modal).
// Bandwidth guard: N manual pulls per local calendar day (counted in localStorage
// only — never on the server, so quota checks cost zero RTDB traffic). A failed
// pull does not consume quota. N is admin-configurable (/config → Limits →
// "Members List Refresh Limit") and falls back to this default until the live
// /settings snapshot lands (or if the admin never sets one).
const MEMBERS_REFRESH_DEFAULT = 5;
const membersRefreshLimit = () => {
    const n = parseInt(window.siteSettings?.membersRefreshLimit, 10);
    return (Number.isFinite(n) && n >= 1) ? n : MEMBERS_REFRESH_DEFAULT;
};
const MEMBERS_REFRESH_KEY = 'hangout-members-refresh';
const membersRefreshDay = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
// Returns { day, count } for TODAY — resets to 0 automatically when the
// stored day is not the current local calendar day.
const readMembersRefreshQuota = () => {
    const day = membersRefreshDay();
    let q = null;
    try { q = JSON.parse(localStorage.getItem(MEMBERS_REFRESH_KEY) || 'null'); } catch (e) { q = null; }
    if (!q || q.day !== day || typeof q.count !== 'number') q = { day: day, count: 0 };
    return q;
};
const paintMembersRefreshTitle = (q) => {
    const btn = document.getElementById('members-refresh-btn');
    const limit = membersRefreshLimit();
    if (btn) btn.title = 'Refresh members list (' + Math.max(0, limit - q.count) + ' of ' + limit + ' left today)';
};

window.refreshMembersList = async () => {
    const quota = readMembersRefreshQuota();
    const limit = membersRefreshLimit();
    paintMembersRefreshTitle(quota);
    if (quota.count >= limit) {
        window.showToast && window.showToast('Daily refresh limit reached (' + limit + '/day) — try again tomorrow.');
        return;
    }
    const btn = document.getElementById('members-refresh-btn');
    const icon = btn ? btn.querySelector('i') : null;
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('animate-spin');
    try {
        const snap = await get(ref(db, 'users'));
        _lastUsersFreshCheck = Date.now();
        window.applyUsersData(snap.val() || {});
        const q = readMembersRefreshQuota(); // re-read: the day may have rolled over mid-flight
        q.count += 1;
        try { localStorage.setItem(MEMBERS_REFRESH_KEY, JSON.stringify(q)); } catch (e) { /* quota skipped gracefully */ }
        paintMembersRefreshTitle(q);
    } catch (e) {
        window.showToast && window.showToast('Could not refresh members — showing last known list.');
    } finally {
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('animate-spin');
    }
};

(async () => {
    const cached = window.usersCache ? window.usersCache.read() : null;
    const fresh = cached && window.usersCache.isFresh(cached);
    if (cached && cached.users && typeof cached.users === 'object' && !Array.isArray(cached.users) && Object.keys(cached.users).length >= 2) {
        window.applyUsersData(cached.users); // instant paint, zero wait
        if (!fresh) {
            try {
                const snap = await get(ref(db, 'users'));
                window.applyUsersData(snap.val() || {});
            } catch (e) { /* keep cached on failure */ }
        }
    } else {
        const snap = await get(ref(db, 'users'));
        window.applyUsersData(snap.val() || {});
    }
})();

// Live own-record listener: keeps the signed-in user's avatar/role/points/bio
// current without watching (or re-downloading) other users' records.
// Exposed as a function and (re)started from onAuthStateChanged because
// `auth.currentUser` is still null while modules eval on a cold load — the old
// `if (auth.currentUser)` below never fired on a fresh page load, so the
// own-record listener (and therefore the .mod-only post-category toggle) only
// ever worked after an unrelated re-render happened. Now it always starts once
// the session is restored.
window.startOwnUserListener = (uid) => {
    if (window._stopOwnUserListener) { try { window._stopOwnUserListener(); } catch (_) {} window._stopOwnUserListener = null; }
    if (!uid) return;
    window._stopOwnUserListener = onValue(ref(db, `users/${uid}`), (snap) => {
        const v = snap.val();
        if (!v) return;
        window.globalUsersCache[uid] = v;
        if (window.writeUsersCache) window.writeUsersCache(window.globalUsersCache);
        window._updateNavUserUI && window._updateNavUserUI();
        if (window.activeProfileUid === uid && window.renderProfileData) window.renderProfileData(false);
    });
};
if (auth.currentUser) window.startOwnUserListener(auth.currentUser.uid);

// Wrap Members modal + profile opens with a cheap freshness prefetch so users
// see current data there even if the shared cache is a couple minutes old.
if (typeof window.renderMembers === 'function') {
    const _rmBase = window.renderMembers;
    window.renderMembers = (...a) => {
        const p = window.ensureUsersFresh ? window.ensureUsersFresh() : Promise.resolve();
        return p.finally(() => _rmBase(...a));
    };
}
if (typeof window.openProfile === 'function') {
    const _opBase = window.openProfile;
    window.openProfile = (uid, ...rest) => {
        const pre = uid ? get(ref(db, `users/${uid}`)).then((s) => {
            if (s.exists()) {
                window.globalUsersCache[uid] = s.val();
                if (window.writeUsersCache) window.writeUsersCache(window.globalUsersCache);
            }
        }).catch(() => {}) : Promise.resolve();
        return pre.finally(() => _opBase(uid, ...rest));
    };
}

// ============================================================
// NOTIFICATIONS LIVE IN RTDB 2 (hangoutrgm2).
// Moved off RTDB 1 so the main database stops carrying this ever-growing,
// per-user node (every reaction / comment / mention / poke / follow / chat
// mention writes here, and every client reads its own 50 latest on every open).
//   /notifications/{uid}/{notifId} = { type, sourceUid|fromUid, timestamp, read, ... }
// ============================================================

// One-time, per account: copy whatever is still on RTDB 1 into RTDB 2, then
// clear RTDB 1. Runs at most once per device+account (localStorage flag) and is
// retried on the next visit if the copy failed — the delete only ever happens
// AFTER a successful copy, and merging the same push keys twice is harmless.
window._migrateNotifications = async (uid) => {
    if (!uid) return;
    const flagKey = `hangout_notif_moved_${uid}`;
    try { if (localStorage.getItem(flagKey) === '1') return; } catch (e) { /* private mode */ }
    try {
        const legacy = await get(ref(db, `notifications/${uid}`));
        if (legacy.exists()) {
            await update(ref(db2, `notifications/${uid}`), legacy.val());
            await remove(ref(db, `notifications/${uid}`));
        }
        try { localStorage.setItem(flagKey, '1'); } catch (e) {}
    } catch (e) {
        console.warn('Notification move to RTDB 2 failed — retrying on the next visit:', e);
    }
};

// Dedicated notifications listener — only for the logged-in user, limited to last 50.
// Kept separate from /users so that notification changes don't re-download all user profiles.
window._notifUnsubscribe = null;
window._startNotifListener = (uid) => {
    if (window._notifUnsubscribe) window._notifUnsubscribe();
    const notifQuery = dbQuery(ref(db2, `notifications/${uid}`), limitToLast(50));
    window._notifUnsubscribe = onValue(notifQuery, (snap) => {
        window.myNotifications = snap.val() || {};
        window.updateNotifBadge();

        // Local push notification check
        let maxTime = window.lastNotifTime || Date.now();
        Object.values(window.myNotifications).forEach(n => {
            if (!n.read && n.timestamp > (window.lastNotifTime || Date.now())) {
                if ("Notification" in window && Notification.permission === "granted") {
                    const sourceUser = window.globalUsersCache[n.sourceUid];
                    const rxEmoji = window.REACT_EMOJI?.[n.reactType] || '❤️';
                    const msg = n.type === 'mention' ? `${sourceUser?.name || 'Someone'} mentioned you!` :
                                n.type === 'comment' ? `${sourceUser?.name || 'Someone'} commented on your post!` :
                                n.type === 'comment_myday' ? `${sourceUser?.name || 'Someone'} commented on your My Day!` :
                                n.type === 'react_post' ? `${sourceUser?.name || 'Someone'} reacted ${rxEmoji} to your post!` :
                                n.type === 'react_comment' ? `${sourceUser?.name || 'Someone'} reacted ${rxEmoji} to your comment!` :
                                n.type === 'react_reply' ? `${sourceUser?.name || 'Someone'} reacted ${rxEmoji} to your reply!` :
                                n.type === 'chat_mention' ? `${sourceUser?.name || 'Someone'} mentioned you in a chat!` :
                                `You have a new notification`;
                    const iconUrl = sourceUser?.pic || './icon-192.png';
                    if (navigator.serviceWorker) {
                        navigator.serviceWorker.ready.then(reg => {
                            reg.showNotification("Hangout", { body: msg, icon: iconUrl });
                        }).catch(() => new Notification("Hangout", { body: msg, icon: iconUrl }));
                    } else {
                        new Notification("Hangout", { body: msg, icon: iconUrl });
                    }
                }
                if (n.timestamp > maxTime) maxTime = n.timestamp;
            }
        });
        window.lastNotifTime = maxTime;
    });
};

window.allPosts = window.allPosts || [];
window.globalPinnedPosts = window.globalPinnedPosts || [];
window.profilePinnedPosts = window.profilePinnedPosts || [];
window.isLoadingHistory = false;
window.hasMorePosts = true;
window.postLimit = 15;
window.postsUnsubscribe = null;
window.usersReady = (typeof window.usersReady === 'boolean') ? window.usersReady : false;
window._pendingPostRender = (typeof window._pendingPostRender === 'boolean') ? window._pendingPostRender : false;
if (window.usersReady && window._pendingPostRender) {
    window._pendingPostRender = false;
    if (window.activeProfileUid) window.renderProfileData(false);
    else if (window.renderFeed) window.renderFeed(false);
}
window.loadPinnedPosts = () => {
    onSnapshot(doc(fsdb, 'settings', 'pinned'), (docSnap) => {
        if (!docSnap.exists()) return;
        const data = docSnap.data();
        window._applyPinnedIds(data.feedPinnedIds || [], 'feedPinned');
        window._applyPinnedIds(data.profilePinnedIds || [], 'profilePinned');
    });
};

// Store per-post realtime listeners keyed by postId so we can unsubscribe when a pin is removed
window._pinnedListeners = window._pinnedListeners || {};

window._applyPinnedIds = (ids, pinType) => {
    ids.forEach(id => {
        // If we already have a live listener for this post, nothing to do
        if (window._pinnedListeners[id]) return;

        // Start a real-time listener for this pinned post
        const postRef = getPostDocRef(id);
        const unsub = onSnapshot(postRef, (snap) => {
            if (!snap.exists()) {
                // If not found in primary and not yet checked secondary/tertiary, fallback check
                if (snap.ref.firestore === fsdb) {
                    const postRef2 = doc(fsdb2, 'community_posts', id);
                    onSnapshot(postRef2, (snap2) => {
                        if (snap2.exists()) {
                            const post2 = { id: snap2.id, ...snap2.data(), _dbSource: 2 };
                            window._postDbMap.set(id, 2);
                            window._updatePinnedPostInState(post2, pinType);
                        } else {
                            const postRef3 = doc(fsdb3, 'community_posts', id);
                            onSnapshot(postRef3, (snap3) => {
                                if (!snap3.exists()) return;
                                const post3 = { id: snap3.id, ...snap3.data(), _dbSource: 3 };
                                window._postDbMap.set(id, 3);
                                window._updatePinnedPostInState(post3, pinType);
                            });
                        }
                    });
                } else if (snap.ref.firestore === fsdb2) {
                    const postRef3 = doc(fsdb3, 'community_posts', id);
                    onSnapshot(postRef3, (snap3) => {
                        if (!snap3.exists()) return;
                        const post3 = { id: snap3.id, ...snap3.data(), _dbSource: 3 };
                        window._postDbMap.set(id, 3);
                        window._updatePinnedPostInState(post3, pinType);
                    });
                }
                return;
            }
            const dbSource = getSourceByFirestore(snap.ref.firestore);
            const post = { id: snap.id, ...snap.data(), _dbSource: dbSource };
            window._postDbMap.set(id, dbSource);
            window._updatePinnedPostInState(post, pinType);
        });
        window._pinnedListeners[id] = unsub;
    });

    // Cleanup: unsubscribe and remove posts that are no longer pinned
    if (pinType === 'feedPinned') {
        const removed = window.globalPinnedPosts.filter(p => !ids.includes(p.id));
        window.globalPinnedPosts = window.globalPinnedPosts.filter(p => ids.includes(p.id));
        removed.forEach(rp => {
            if (window._pinnedListeners[rp.id]) {
                window._pinnedListeners[rp.id]();
                delete window._pinnedListeners[rp.id];
            }
            const inHistory = (window._historyPosts || []).some(p => p.id === rp.id);
            if (!inHistory) window.allPosts = window.allPosts.filter(p => p.id !== rp.id);
        });
    } else {
        const removed = window.profilePinnedPosts.filter(p => !ids.includes(p.id));
        window.profilePinnedPosts = window.profilePinnedPosts.filter(p => ids.includes(p.id));
        removed.forEach(rp => {
            if (window._pinnedListeners[rp.id]) {
                window._pinnedListeners[rp.id]();
                delete window._pinnedListeners[rp.id];
            }
            const inHistory = (window._historyPosts || []).some(p => p.id === rp.id);
            if (!inHistory) window.allPosts = window.allPosts.filter(p => p.id !== rp.id);
        });
    }
    if (typeof window.renderFeed === 'function') {
        if (!window.usersReady) window._pendingPostRender = true;
        else if (!window.isolatedPostId) window.renderFeed(false);
    }
};

window._updatePinnedPostInState = (post, pinType) => {
    const id = post.id;
    const gpIdx = window.globalPinnedPosts.findIndex(p => p.id === id);
    if (gpIdx !== -1) window.globalPinnedPosts[gpIdx] = post;
    else if (pinType === 'feedPinned') window.globalPinnedPosts.push(post);

    const ppIdx = window.profilePinnedPosts.findIndex(p => p.id === id);
    if (ppIdx !== -1) window.profilePinnedPosts[ppIdx] = post;
    else if (pinType === 'profilePinned') window.profilePinnedPosts.push(post);

    const apIdx = window.allPosts.findIndex(p => p.id === id);
    if (apIdx !== -1) window.allPosts[apIdx] = post;

    if (typeof window.renderFeed === 'function') {
        if (!window.usersReady) window._pendingPostRender = true;
        else if (!window.isolatedPostId) window.renderFeed(false);
    }
};

// Build a base Firestore query with optional filter/author constraints for a specific Firestore instance
window._buildBaseQueryForDb = (targetFs) => {
    const postsRef = collection(targetFs, 'community_posts');
    if (window.activeProfileUid) {
        return query(postsRef, where('authorId', '==', window.activeProfileUid), orderBy('timestamp', 'desc'));
    } else if (window.currentFilter === 'My Posts' && window.currentUser) {
        return query(postsRef, where('authorId', '==', window.currentUser.uid), orderBy('timestamp', 'desc'));
    } else if (window.currentFilter === 'Reels') {
        // Query all non-game categories so Reels videos and photo posts from General/Announcements/Rules
        // are streamed cleanly in real time without being flooded by thousands of Games posts.
        return query(postsRef, where('category', 'in', ['Reels', 'General', 'Announcements', 'Rules']), orderBy('timestamp', 'desc'));
    } else if (window.currentFilter && window.currentFilter !== 'All') {
        return query(postsRef, where('category', '==', window.currentFilter), orderBy('timestamp', 'desc'));
    } else {
        return query(postsRef, orderBy('timestamp', 'desc'));
    }
};

// Backward-compatibility wrapper
window._buildBaseQuery = () => window._buildBaseQueryForDb(fsdb);

// listenPosts: sets live onSnapshot listeners on both Firestore 1 and Firestore 2 (merged real-time stream)
window.listenPosts = () => {
    if (window.postsUnsubscribe1) { window.postsUnsubscribe1(); window.postsUnsubscribe1 = null; }
    if (window.postsUnsubscribe2) { window.postsUnsubscribe2(); window.postsUnsubscribe2 = null; }
    if (window.postsUnsubscribe3) { window.postsUnsubscribe3(); window.postsUnsubscribe3 = null; }
    if (typeof window.postsUnsubscribe === 'function') { window.postsUnsubscribe(); window.postsUnsubscribe = null; }

    window._lastPostDoc1 = null;
    window._lastPostDoc2 = null;
    window._lastPostDoc3 = null;
    window._liveLastDoc1 = null;
    window._liveLastDoc2 = null;
    window._liveLastDoc3 = null;
    window._historyPosts1 = [];
    window._historyPosts2 = [];
    window._historyPosts3 = [];
    window._historyPosts = [];

    let livePosts1 = [];
    let livePosts2 = [];
    let livePosts3 = [];
    let initialSnap1 = false;
    let initialSnap2 = false;
    let initialSnap3 = false;
    let initialGraceElapsed = false;
    setTimeout(() => {
        initialGraceElapsed = true;
        mergeAndRender();
    }, 400);

    const safeMergeAndRender = () => {
        if ((initialSnap1 && initialSnap2 && initialSnap3) || initialGraceElapsed) {
            mergeAndRender();
        }
    };

    const mergeAndRender = () => {
        const rawDocs = {};
        [...livePosts1, ...livePosts2, ...livePosts3].forEach(p => { if (p && p.id) rawDocs[p.id] = p; });
        if (window.checkGameTimers) window.checkGameTimers(rawDocs);

        const allLive = [...livePosts1, ...livePosts2, ...livePosts3];
        allLive.sort((a, b) => {
            const tA = (a.timestamp && a.timestamp.toMillis) ? a.timestamp.toMillis() : (typeof a.timestamp === 'number' ? a.timestamp : 0);
            const tB = (b.timestamp && b.timestamp.toMillis) ? b.timestamp.toMillis() : (typeof b.timestamp === 'number' ? b.timestamp : 0);
            return tB - tA;
        });

        const allHistory = [...(window._historyPosts1 || []), ...(window._historyPosts2 || []), ...(window._historyPosts3 || [])];
        allHistory.sort((a, b) => {
            const tA = (a.timestamp && a.timestamp.toMillis) ? a.timestamp.toMillis() : (typeof a.timestamp === 'number' ? a.timestamp : 0);
            const tB = (b.timestamp && b.timestamp.toMillis) ? b.timestamp.toMillis() : (typeof b.timestamp === 'number' ? b.timestamp : 0);
            return tB - tA;
        });
        window._historyPosts = allHistory;

        const historyIds = new Set(allHistory.map(p => p.id));
        const mergedLive = allLive.filter(p => !historyIds.has(p.id));
        window.allPosts = [...mergedLive, ...allHistory];

        // Ensure currently isolated spotlight post is retained in allPosts
        if (window.isolatedPostId && window.isolatedPostData && !window.allPosts.some(p => p.id === window.isolatedPostId)) {
            window.allPosts.push(window.isolatedPostData);
        }

        if (!window.isUserTyping && !window._bingoGlobalSpinning) {
            if (!window.usersReady) {
                window._pendingPostRender = true;
            } else {
                if (window.activeProfileUid) window.renderProfileData(false);
                else if (!window.isolatedPostId) window.renderFeed(false);
                if (window.processBingoAnimations) window.processBingoAnimations();
            }
        }
        if (window.currentFilter && window._saveFilterState) window._saveFilterState(window.currentFilter);
        window.handleDeepLinks();
        window.isLoadingHistory = false;
    };

    const batchLimit = window.currentFilter === 'Reels' ? 20 : 15;

    const q1 = query(window._buildBaseQueryForDb(fsdb), limit(batchLimit));
    const q2 = query(window._buildBaseQueryForDb(fsdb2), limit(batchLimit));
    const q3 = query(window._buildBaseQueryForDb(fsdb3), limit(batchLimit));

    window.postsUnsubscribe1 = onSnapshot(q1, { includeMetadataChanges: false }, (snapshot) => {
        // Use docChanges() so only the 1-2 docs that actually changed are billed,
        // not the full 15-doc result set on every write (was 45 reads/write across 3 DBs).
        snapshot.docChanges().forEach(change => {
            const id = change.doc.id;
            if (change.type === 'removed') {
                livePosts1 = livePosts1.filter(p => p.id !== id);
            } else {
                // 'added' or 'modified' — upsert into the live array
                const p = { id, ...change.doc.data(), _dbSource: 1 };
                window._postDbMap.set(id, 1);
                const idx = livePosts1.findIndex(p => p.id === id);
                if (idx !== -1) livePosts1[idx] = p;
                else livePosts1.push(p);
            }
        });
        if (snapshot.docs.length > 0) {
            window._liveLastDoc1 = snapshot.docs[snapshot.docs.length - 1];
        }
        window.hasMorePosts1 = (snapshot.size >= batchLimit);
        window.hasMorePosts = window.hasMorePosts1 || window.hasMorePosts2 || window.hasMorePosts3;
        initialSnap1 = true;
        safeMergeAndRender();
    }, (err) => {
        console.warn("FS1 snapshot warning:", err);
        initialSnap1 = true;
        safeMergeAndRender();
    });

    window.postsUnsubscribe2 = onSnapshot(q2, { includeMetadataChanges: false }, (snapshot) => {
        snapshot.docChanges().forEach(change => {
            const id = change.doc.id;
            if (change.type === 'removed') {
                livePosts2 = livePosts2.filter(p => p.id !== id);
            } else {
                const p = { id, ...change.doc.data(), _dbSource: 2 };
                window._postDbMap.set(id, 2);
                const idx = livePosts2.findIndex(p => p.id === id);
                if (idx !== -1) livePosts2[idx] = p;
                else livePosts2.push(p);
            }
        });
        if (snapshot.docs.length > 0) {
            window._liveLastDoc2 = snapshot.docs[snapshot.docs.length - 1];
        }
        window.hasMorePosts2 = (snapshot.size >= batchLimit);
        window.hasMorePosts = window.hasMorePosts1 || window.hasMorePosts2 || window.hasMorePosts3;
        initialSnap2 = true;
        safeMergeAndRender();
    }, (err) => {
        console.warn("FS2 snapshot warning:", err);
        initialSnap2 = true;
        safeMergeAndRender();
    });

    window.postsUnsubscribe3 = onSnapshot(q3, { includeMetadataChanges: false }, (snapshot) => {
        snapshot.docChanges().forEach(change => {
            const id = change.doc.id;
            if (change.type === 'removed') {
                livePosts3 = livePosts3.filter(p => p.id !== id);
            } else {
                const p = { id, ...change.doc.data(), _dbSource: 3 };
                window._postDbMap.set(id, 3);
                const idx = livePosts3.findIndex(p => p.id === id);
                if (idx !== -1) livePosts3[idx] = p;
                else livePosts3.push(p);
            }
        });
        if (snapshot.docs.length > 0) {
            window._liveLastDoc3 = snapshot.docs[snapshot.docs.length - 1];
        }
        window.hasMorePosts3 = (snapshot.size >= batchLimit);
        window.hasMorePosts = window.hasMorePosts1 || window.hasMorePosts2 || window.hasMorePosts3;
        initialSnap3 = true;
        safeMergeAndRender();
    }, (err) => {
        console.warn("FS3 snapshot warning:", err);
        initialSnap3 = true;
        safeMergeAndRender();
    });

    window.postsUnsubscribe = () => {
        if (window.postsUnsubscribe1) window.postsUnsubscribe1();
        if (window.postsUnsubscribe2) window.postsUnsubscribe2();
        if (window.postsUnsubscribe3) window.postsUnsubscribe3();
    };
};

// loadMorePosts: fetches the next page of older posts from all Firestore instances using cursor pagination
window.loadMorePosts = async () => {
    if (window.isLoadingHistory || !window.hasMorePosts) return;
    window.isLoadingHistory = true;
    const batchLimit = window.currentFilter === 'Reels' ? 20 : 15;

    try {
        const cursor1 = window._lastPostDoc1 || window._liveLastDoc1;
        if (window.hasMorePosts1 !== false && cursor1) {
            try {
                const pageQuery1 = query(window._buildBaseQueryForDb(fsdb), startAfter(cursor1), limit(batchLimit));
                const pageSnap1 = await window._getDocsFS(pageQuery1);
                if (!pageSnap1.empty) {
                    window._lastPostDoc1 = pageSnap1.docs[pageSnap1.docs.length - 1];
                    const existingIds = new Set((window._historyPosts1 || []).map(p => p.id));
                    pageSnap1.forEach(docSnap => {
                        if (!existingIds.has(docSnap.id)) {
                            const p = { id: docSnap.id, ...docSnap.data(), _dbSource: 1 };
                            window._postDbMap.set(docSnap.id, 1);
                            window._historyPosts1.push(p);
                        }
                    });
                }
                window.hasMorePosts1 = (pageSnap1.size >= batchLimit);
            } catch (e) {
                console.warn("Error fetching page from fsdb 1:", e);
                window.hasMorePosts1 = false;
            }
        }

        const cursor2 = window._lastPostDoc2 || window._liveLastDoc2;
        if (window.hasMorePosts2 !== false && cursor2) {
            try {
                const pageQuery2 = query(window._buildBaseQueryForDb(fsdb2), startAfter(cursor2), limit(batchLimit));
                const pageSnap2 = await window._getDocsFS(pageQuery2);
                if (!pageSnap2.empty) {
                    window._lastPostDoc2 = pageSnap2.docs[pageSnap2.docs.length - 1];
                    const existingIds = new Set((window._historyPosts2 || []).map(p => p.id));
                    pageSnap2.forEach(docSnap => {
                        if (!existingIds.has(docSnap.id)) {
                            const p = { id: docSnap.id, ...docSnap.data(), _dbSource: 2 };
                            window._postDbMap.set(docSnap.id, 2);
                            window._historyPosts2.push(p);
                        }
                    });
                }
                window.hasMorePosts2 = (pageSnap2.size >= batchLimit);
            } catch (e) {
                console.warn("Error fetching page from fsdb 2:", e);
                window.hasMorePosts2 = false;
            }
        }

        const cursor3 = window._lastPostDoc3 || window._liveLastDoc3;
        if (window.hasMorePosts3 !== false && cursor3) {
            try {
                const pageQuery3 = query(window._buildBaseQueryForDb(fsdb3), startAfter(cursor3), limit(batchLimit));
                const pageSnap3 = await window._getDocsFS(pageQuery3);
                if (!pageSnap3.empty) {
                    window._lastPostDoc3 = pageSnap3.docs[pageSnap3.docs.length - 1];
                    const existingIds = new Set((window._historyPosts3 || []).map(p => p.id));
                    pageSnap3.forEach(docSnap => {
                        if (!existingIds.has(docSnap.id)) {
                            const p = { id: docSnap.id, ...docSnap.data(), _dbSource: 3 };
                            window._postDbMap.set(docSnap.id, 3);
                            window._historyPosts3.push(p);
                        }
                    });
                }
                window.hasMorePosts3 = (pageSnap3.size >= batchLimit);
            } catch (e) {
                console.warn("Error fetching page from fsdb 3:", e);
                window.hasMorePosts3 = false;
            }
        }

        window.hasMorePosts = (window.hasMorePosts1 || window.hasMorePosts2 || window.hasMorePosts3);

        const allHistory = [...(window._historyPosts1 || []), ...(window._historyPosts2 || []), ...(window._historyPosts3 || [])];
        allHistory.sort((a, b) => {
            const tA = (a.timestamp && a.timestamp.toMillis) ? a.timestamp.toMillis() : (typeof a.timestamp === 'number' ? a.timestamp : 0);
            const tB = (b.timestamp && b.timestamp.toMillis) ? b.timestamp.toMillis() : (typeof b.timestamp === 'number' ? b.timestamp : 0);
            return tB - tA;
        });
        window._historyPosts = allHistory;

        const historyIds = new Set(allHistory.map(p => p.id));
        const livePosts = (window.allPosts || []).filter(p => !historyIds.has(p.id));
        window.allPosts = [...livePosts, ...allHistory];

        if (window.currentFilter === 'Reels') {
            window.feedRenderLimit = (window.feedRenderLimit || 15) + 15;
        } else {
            window.feedRenderLimit = window.allPosts.length;
        }
        window.profileRenderLimit = window.allPosts.length;

        if (window.activeProfileUid) window.renderProfileData(false);
        else window.renderFeed(false);
        if (window.currentFilter && window._saveFilterState) window._saveFilterState(window.currentFilter);
    } catch (err) {
        console.error("Error loading more posts:", err);
    } finally {
        window.isLoadingHistory = false;
    }
};

window.loadPinnedPosts();
window.listenPosts();

// Tab Visibility Management: Pause listener and presence heartbeat when tab is inactive/hidden for >30s
let visibilityPauseTimer = null;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (visibilityPauseTimer) clearTimeout(visibilityPauseTimer);
        visibilityPauseTimer = setTimeout(() => {
            if (document.hidden) {
                if (window.postsUnsubscribe) {
                    window.postsUnsubscribe();
                    window.postsUnsubscribe = null;
                }
                if (presenceInterval) {
                    clearInterval(presenceInterval);
                    presenceInterval = null;
                }
            }
        }, 30000);
    } else {
        if (visibilityPauseTimer) {
            clearTimeout(visibilityPauseTimer);
            visibilityPauseTimer = null;
        }
        if (!window.postsUnsubscribe) {
            window.listenPosts();
        }
        if (!presenceInterval && auth.currentUser) {
            startOwnPresence(auth.currentUser);
        }
    }
});

// ==========================================
// ==========================================
// ACTIONS (POST/COMMENT/EDIT)
// ==========================================

window.checkUploadLimit = () => {
    if (!window.currentUser) return false;
    const today = new Date().toLocaleDateString('en-CA');
    const userData = window.globalUsersCache[window.currentUser.uid] || {};
    const uploadsToday = userData.dailyUploads?.date === today ? userData.dailyUploads.count : 0;
    const limit = window.siteSettings.imageUploadLimit ?? 10;
    if (uploadsToday >= limit) {
        window.showAlert(`You have reached your daily limit of ${limit} image uploads.`);
        return false;
    }
    return true;
};

window.incrementUploadLimit = () => {
    if (!window.currentUser) return;
    const today = new Date().toLocaleDateString('en-CA');
    const userData = window.globalUsersCache[window.currentUser.uid] || {};
    const currentCount = userData.dailyUploads?.date === today ? (userData.dailyUploads.count || 0) : 0;
    update(ref(db, `users/${window.currentUser.uid}/dailyUploads`), { date: today, count: currentCount + 1 });
};

window.checkVideoUploadLimit = () => {
    if (!window.currentUser) return false;
    const today = new Date().toLocaleDateString('en-CA');
    const userData = window.globalUsersCache[window.currentUser.uid] || {};
    const uploadsToday = userData.dailyVideoUploads?.date === today ? userData.dailyVideoUploads.count : 0;
    const limit = window.siteSettings.videoUploadLimit ?? 3;
    if (uploadsToday >= limit) {
        window.showAlert(`You have reached your daily limit of ${limit} video uploads.`);
        return false;
    }
    return true;
};

window.incrementVideoUploadLimit = () => {
    if (!window.currentUser) return;
    const today = new Date().toLocaleDateString('en-CA');
    const userData = window.globalUsersCache[window.currentUser.uid] || {};
    const currentCount = userData.dailyVideoUploads?.date === today ? (userData.dailyVideoUploads.count || 0) : 0;
    update(ref(db, `users/${window.currentUser.uid}/dailyVideoUploads`), { date: today, count: currentCount + 1 });
};

document.getElementById('post-image-file').addEventListener('change', function() {
    const files = Array.from(this.files || []);
    const preview = document.getElementById('media-preview-container');
    const fileNameEl = document.getElementById('file-name');
    const clearPreview = () => {
        if (preview) { preview.innerHTML = ''; preview.classList.add('hidden'); }
        if (fileNameEl) fileNameEl.innerText = '';
    };
    if (!files.length) { clearPreview(); return; }
    // Collage mode: photos only, max 4. A single video is allowed through (handled by the submit
    // path below); only reject videos that are combined with other files into a collage.
    if (files.length > 1 && files.some(f => f.type.startsWith('video/'))) {
        window.showAlert("Videos can't be combined into a collage. Please post the video by itself.");
        this.value = '';
        clearPreview();
        return;
    }
    if (files.length > 4) {
        window.showAlert("You can attach up to 4 photos per post. Only the first 4 will be used.");
        // Keep only the first 4 via DataTransfer so submit stays consistent with what the user sees
        try {
            const dt = new DataTransfer();
            files.slice(0, 4).forEach(f => dt.items.add(f));
            this.files = dt.files;
        } catch (e) { /* older browsers: submit handler also enforces the cap */ }
    }
    const kept = Array.from(this.files || []).slice(0, 4);
    if (!kept.length) { clearPreview(); return; }
    if (fileNameEl) fileNameEl.innerText = kept.length === 1 ? kept[0].name : `${kept.length} photos selected`;
    if (!preview) return;
    preview.classList.remove('hidden');
    preview.style.display = 'flex';
    preview.style.gap = '6px';
    preview.style.flexWrap = 'wrap';
    preview.innerHTML = kept.map((f, i) => {
        const media = f.type.startsWith('video/')
            ? `<video src="${URL.createObjectURL(f)}" class="w-full h-full object-cover" muted></video>`
            : `<img src="${URL.createObjectURL(f)}" class="w-full h-full object-cover" alt="preview ${i + 1}">`;
        return `
        <div class="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-200 dark:border-slate-600 shrink-0">
            ${media}
            <button type="button" onclick="window.removeCollageFile(${i})" class="absolute top-0.5 right-0.5 w-4 h-4 bg-black/70 text-white rounded-full text-[9px] flex items-center justify-center opacity-80 hover:opacity-100 transition" title="Remove">&times;</button>
        </div>
    `;}).join('');
});

// Remove one photo from the pending multi-file selection while keeping the others
window.removeCollageFile = (index) => {
    const input = document.getElementById('post-image-file');
    const files = Array.from(input.files || []);
    files.splice(index, 1);
    try {
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        input.files = dt.files;
    } catch (e) { input.value = ''; }
    input.dispatchEvent(new Event('change'));
};
// ==========================================
// + CREATE BUTTON & POST TYPE COMPOSER
// The + button opens a small chooser with 4 post types:
// post / photo / reels / voice message. Each one reveals the
// compose box pre-configured for that type.
// ==========================================
window.createComposerType = 'post';
window._pendingVoiceBlob = null;
window._pendingVoiceObjectUrl = null;

window.toggleCreateMenu = () => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    const modal = document.getElementById('create-type-modal');
    if (modal) modal.classList.toggle('hidden');
};

window.closeCreateMenu = () => {
    const modal = document.getElementById('create-type-modal');
    if (modal) modal.classList.add('hidden');
};

window.openAppsModal = () => {
    const modal = document.getElementById('apps-modal');
    if (modal) modal.classList.remove('hidden');
};

window.closeAppsModal = () => {
    const modal = document.getElementById('apps-modal');
    if (modal) modal.classList.add('hidden');
};

// Polls & Events now live in the "Create a post" menu. They reuse the game modal's
// form (which already carries the poll/event fields) with the type pre-selected.
window.openCreatePoll = () => { window.closeCreateMenu(); if (window.checkBan()) return; window.openPostGameModal('poll'); };
window.openCreateEvent = () => { window.closeCreateMenu(); if (window.checkBan()) return; window.openPostGameModal('event'); };

// ==========================================
// LOBBY (LFG) POSTS — structured MLBB matchmaking posts
// ==========================================
window.closeLobbyModal = () => document.getElementById('lobby-modal').classList.add('hidden');

// Custom lobbies need a room ID + password — show those fields only for Custom.
window.toggleLobbyRoomFields = () => {
    const fields = document.getElementById('lobby-room-fields');
    const modeSel = document.getElementById('lobby-mode');
    if (!fields || !modeSel) return;
    fields.classList.toggle('hidden', modeSel.value !== 'Custom');
};

window.openCreateLobby = () => {
    window.closeCreateMenu();
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;

    // Fresh form state
    document.getElementById('lobby-mode').value = 'Ranked';
    document.getElementById('lobby-looking').value = 'Duo';
    document.getElementById('lobby-rank').value = '';
    document.querySelectorAll('#lobby-roles .lobby-role').forEach(c => { c.checked = false; });
    document.getElementById('lobby-note').value = '';
    document.getElementById('lobby-room-id').value = '';
    document.getElementById('lobby-room-pass').value = '';
    document.getElementById('lobby-game').value = 'Mobile Legends: Bang Bang';
    window.toggleLobbyRoomFields();

    // Auto-pull the host's MLBB IGN + Game ID (saved via Edit Profile > Gaming)
    const mlbb = (window.globalUsersCache[window.currentUser.uid] || {}).mlbb || {};
    const ign = String(mlbb.ign || '').trim();
    const gameId = String(mlbb.gameId || '').trim();
    const server = String(mlbb.server || '').trim();
    window._lobbyIdText = gameId ? [gameId, server ? `(${server})` : ''].filter(Boolean).join(' ') : '';
    const hostLine = document.getElementById('lobby-host-line');
    const copyBtn = document.getElementById('lobby-copy-btn');
    if (ign || gameId) {
        hostLine.textContent = `${ign || 'Player'}${gameId ? ` · ${window._lobbyIdText}` : ''}`;
        hostLine.className = 'text-xs font-bold text-gray-800 dark:text-gray-100 truncate';
        copyBtn.classList.toggle('hidden', !gameId);
    } else {
        hostLine.textContent = 'Set your IGN & Game ID in Edit Profile → Gaming';
        hostLine.className = 'text-[11px] font-semibold text-gray-400 truncate';
        copyBtn.classList.add('hidden');
    }

    document.getElementById('lobby-modal').classList.remove('hidden');
};

// Copy a lobby value: accepts a raw string, a button carrying [data-id] (+ optional
// [data-toast] label for the confirmation), or falls back to the modal's Game ID.
window.copyLobbyId = async (value) => {
    const isEl = value && typeof value === 'object';
    const text = (typeof value === 'string' ? value : (isEl ? value.dataset.id : '')) || window._lobbyIdText || '';
    if (!text) return window.showAlert('Nothing to copy yet.');
    const label = (isEl && value.dataset.toast) || 'Game ID';
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e2) {}
        ta.remove();
    }
    window.showAlert(`${label} copied!`);
};

window.submitLobbyPost = async () => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    const mode = document.getElementById('lobby-mode').value;
    const roomId = (document.getElementById('lobby-room-id').value || '').trim();
    const roomPass = (document.getElementById('lobby-room-pass').value || '').trim();
    if (mode === 'Custom' && !roomId) return window.showAlert('Add your Room ID for custom games.');
    // Same cooldown bucket as regular posts so lobbies can't be spammed either.
    if (!(await window.checkActionCooldown('post'))) return;

    const roles = Array.from(document.querySelectorAll('#lobby-roles .lobby-role:checked')).map(c => c.value);
    const note = (document.getElementById('lobby-note').value || '').trim();
    const mlbb = (window.globalUsersCache[window.currentUser.uid] || {}).mlbb || {};

    const btn = document.getElementById('lobby-submit-btn');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;

    try {
        const { fsdb: targetFs, dbSource } = getRoundRobinFsdb();
        const postData = {
            authorId: window.currentUser.uid,
            text: note,
            image: '', hasPhoto: false,
            category: 'Lobby',
            isLobby: true,
            lobby: {
                game: (document.getElementById('lobby-game').value || '').trim() || 'Mobile Legends: Bang Bang',
                mode: document.getElementById('lobby-mode').value,
                lookingFor: document.getElementById('lobby-looking').value,
                rankReq: document.getElementById('lobby-rank').value || 'Any',
                roles,
                ign: String(mlbb.ign || '').trim(),
                gameId: String(mlbb.gameId || '').trim(),
                server: String(mlbb.server || '').trim(),
                roomId, roomPass,
                joins: {}
            },
            timestamp: Date.now(), pinned: false, edited: false, locked: false, reactions: {},
            visibility: 'public',
            _dbSource: dbSource
        };
        const newPostRef = await addDoc(collection(targetFs, 'community_posts'), postData);
        window._postDbMap.set(newPostRef.id, dbSource);

        const pointsToAdd = window.siteSettings.starsPerPost ?? 10;
        update(ref(db, `users/${window.currentUser.uid}`), { points: increment(pointsToAdd) });
        if (note) window.notifyMentions(note, newPostRef.id);
        window.logActivity("posted a lobby");

        window.closeLobbyModal();
        window.clearIsolatedPost();
        window.showAlert("Lobby posted! Good luck 🎮");
    } catch (error) {
        console.error("Lobby post failed", error);
        window.showAlert("Failed to post lobby. Please try again.");
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
};

// ==========================================
// LOBBY JOINING — pick a position, show up in the squad list
// ==========================================
window.closeLobbyJoin = () => document.getElementById('lobby-join-modal').classList.add('hidden');

window.openLobbyJoin = (postId) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    const post = (window.allPosts || []).find(p => p.id === postId)
        || (window.isolatedPostData && window.isolatedPostData.id === postId ? window.isolatedPostData : null);
    if (!post || !post.isLobby) return;
    if (post.authorId === window.currentUser.uid) return;
    window._lobbyJoinPostId = postId;

    const l = post.lobby || {};
    document.getElementById('lobby-join-info').textContent = [l.game || 'Mobile Legends', l.mode, l.lookingFor].filter(Boolean).join(' · ');
    document.getElementById('lobby-join-position').value = '';

    // Preview exactly what will be shared: your rank + Game ID from the gaming profile.
    const mlbb = (window.globalUsersCache[window.currentUser.uid] || {}).mlbb || {};
    const rank = String(mlbb.currentRank || mlbb.highestRank || '').trim();
    const id = [String(mlbb.gameId || '').trim(), mlbb.server ? `(${mlbb.server})` : ''].filter(Boolean).join(' ');
    document.getElementById('lobby-join-preview').textContent = [rank || 'No rank set', id].filter(Boolean).join(' · ');

    document.getElementById('lobby-join-modal').classList.remove('hidden');
};

window.confirmJoinLobby = async () => {
    if (!window.currentUser || !window._lobbyJoinPostId) return;
    const position = document.getElementById('lobby-join-position').value;
    if (!position) return window.showAlert('Pick the position you want to play.');

    const btn = document.getElementById('lobby-join-confirm');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;
    try {
        await updateDoc(getPostDocRef(window._lobbyJoinPostId), {
            [`lobby.joins.${window.currentUser.uid}`]: { role: position, joinedAt: Date.now() }
        });
        window.closeLobbyJoin();
        window.showAlert(`You're in! See you as ${position} 🎮`);
    } catch (error) {
        console.error('Join lobby failed', error);
        window.showAlert('Could not join the lobby. Please try again.');
    } finally {
        btn.innerHTML = originalHtml;
        btn.disabled = false;
    }
};

window.leaveLobby = async (postId) => {
    if (!window.currentUser) return;
    try {
        await updateDoc(getPostDocRef(postId), { [`lobby.joins.${window.currentUser.uid}`]: deleteField() });
        window.showAlert('You left the squad.');
    } catch (error) {
        console.error('Leave lobby failed', error);
        window.showAlert('Could not leave the squad. Please try again.');
    }
};

window.clearPendingVoice = () => {
    if (window._pendingVoiceObjectUrl) {
        URL.revokeObjectURL(window._pendingVoiceObjectUrl);
        window._pendingVoiceObjectUrl = null;
    }
    window._pendingVoiceBlob = null;
    const recBar = document.getElementById('create-voice-recorder-bar');
    if (recBar) recBar.classList.add('hidden');
};

window.closeCreateComposer = () => {
    if (window.VoiceRecorder && window.VoiceRecorder.isRecording()) window.VoiceRecorder.cancel();
    window.clearPendingVoice();
    const fileInput = document.getElementById('post-image-file');
    if (fileInput) fileInput.value = '';
    const previewEl = document.getElementById('media-preview-container');
    if (previewEl) { previewEl.innerHTML = ''; previewEl.classList.add('hidden'); }
    const textEl = document.getElementById('post-text');
    if (textEl) textEl.value = '';
    const box = document.getElementById('create-post-box');
    if (box) box.classList.add('hidden');
    // Restore My Day strip as the default view
    if (window.MyDay && window.MyDay.show) window.MyDay.show();
    else { const md = document.getElementById('myday-strip'); if (md) md.classList.remove('hidden'); }
    window.closeCreateMenu();
};

window.openCreateComposer = (type = 'post') => {
    window.closeCreateMenu();
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');

    window.createComposerType = type;
    window.clearPendingVoice();

    const box = document.getElementById('create-post-box');
    const attachLabel = document.getElementById('post-attach-label');
    const voiceBtn = document.getElementById('post-voice-btn');
    const fileInput = document.getElementById('post-image-file');
    const catSelect = document.getElementById('post-category');
    const titleEl = document.getElementById('create-post-title');
    const textEl = document.getElementById('post-text');
    const previewEl = document.getElementById('media-preview-container');

    // Fresh composer state
    box.classList.remove('hidden');
    // Composer replaces My Day (strip) while open
    if (window.MyDay && window.MyDay.hide) window.MyDay.hide();
    else { const md = document.getElementById('myday-strip'); if (md) md.classList.add('hidden'); }
    if (textEl) textEl.value = '';
    if (fileInput) fileInput.value = '';
    if (previewEl) { previewEl.innerHTML = ''; previewEl.classList.add('hidden'); }
    const fileNameEl = document.getElementById('file-name');
    if (fileNameEl) fileNameEl.innerText = '';
    window.postVisibility = 'public';
    const eyeBtn = document.getElementById('visibility-toggle-btn');
    if (eyeBtn) {
        eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 mr-1 text-xs"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
        eyeBtn.title = "Public Post";
    }

    // Per-type configuration
    // Category dropdown: show only what fits the post type —
    //   post/photo/voice -> General (+ Announcements/Rules for mods); Reels & Games hidden
    //   reels          -> Reels only
    // Announcements/Rules still follow the role-based mod-only logic.
    const catOptions = Array.from(catSelect.querySelectorAll('option'));
    const roleLevel = window.currentUser ? window.getRole(window.currentUser.uid).level : 1;
    const applyCat = (composerType) => {
        catOptions.forEach(o => {
            const isMod = o.classList.contains('mod-only');
            let hidden;
            if (composerType === 'reels') hidden = o.value !== 'Reels';
            else if (o.value === 'Reels' || o.value === 'Games') hidden = true;
            else if (isMod) hidden = roleLevel < 2;
            else hidden = false;
            o.classList.toggle('hidden', hidden);
            o.disabled = hidden;
        });
        // NOTE: use `o.disabled` (set above) to detect visibility — never the
        // `o.hidden` DOM property, because <option> elements do NOT reflect the
        // CSS `.hidden` class onto the `.hidden` property (every option would
        // look "visible" and the value would never switch to Reels).
        const firstVisible = catOptions.find(o => !o.disabled);
        if (firstVisible && !catOptions.some(o => !o.disabled && o.value === catSelect.value)) {
            catSelect.value = firstVisible.value;
        }
    };
    applyCat(type);

    if (type === 'post') {
        attachLabel.classList.add('hidden');
        voiceBtn.classList.add('hidden');
        fileInput.accept = 'image/*,video/*';
        if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-pen text-blue-500 mr-1.5"></i>New post';
        if (textEl) textEl.placeholder = 'Share something or @mention someone...';
    } else if (type === 'photo') {
        attachLabel.classList.remove('hidden');
        voiceBtn.classList.add('hidden');
        fileInput.accept = 'image/*';
        if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-image text-green-500 mr-1.5"></i>New photo post';
        if (textEl) textEl.placeholder = 'Say something about your photo...';
    } else if (type === 'reels') {
        attachLabel.classList.remove('hidden');
        voiceBtn.classList.add('hidden');
        fileInput.accept = 'video/*';
        if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-clapperboard text-purple-500 mr-1.5"></i>New reels post';
        if (textEl) textEl.placeholder = 'Upload a video or paste a link...';
    } else if (type === 'voice') {
        attachLabel.classList.add('hidden');
        voiceBtn.classList.remove('hidden');
        fileInput.accept = 'image/*,video/*';
        if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-microphone text-rose-500 mr-1.5"></i>New voice message';
        if (textEl) textEl.placeholder = 'Add a caption (optional)...';
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
// Voice-recording hooks for the post composer (backs onto voice-recorder.js)
window.startPostVoiceRecording = async () => {
    if (!window.currentUser) return;
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;

    // Daily voice-post limit (admin /config → Posts Upload Limits → Voice/Day)
    const voiceLimit = Number(window.siteSettings?.voicePostLimit ?? 10);
    const voiceDay = new Date().toISOString().slice(0, 10);
    const quotaSnap = await get(ref(db, `voicePostUploadQuota/${window.currentUser.uid}/${voiceDay}`)).catch(() => null);
    const usedCount = Number(quotaSnap?.val() || 0);
    if (usedCount >= voiceLimit) {
        return window.showAlert(`Daily voice post limit reached (${voiceLimit} recordings). Try again tomorrow.`);
    }

    window.clearPendingVoice();
    if (window.VoiceRecorder) window.VoiceRecorder.start();
};
window.stopPostVoice = () => { if (window.VoiceRecorder) window.VoiceRecorder.stop(); };
window.cancelPostVoice = () => { if (window.VoiceRecorder) window.VoiceRecorder.cancel(); };

// Wire the standalone voice recorder to the post composer
if (window.VoiceRecorder) {
    window.VoiceRecorder.init({
        barId: 'create-voice-recorder-bar',
        timerId: 'create-voice-rec-timer',
        onStop: async (audioBlob) => {
            window.clearPendingVoice();
            window._pendingVoiceBlob = audioBlob;
            const url = URL.createObjectURL(audioBlob);
            window._pendingVoiceObjectUrl = url;
            const previewEl = document.getElementById('media-preview-container');
            if (previewEl) {
                previewEl.innerHTML = `<div class="flex items-center justify-between bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-700 p-2">
                    <audio controls src="${url}" class="h-9" style="max-width:180px;"></audio>
                    <span class="text-[10px] font-bold text-rose-500 whitespace-nowrap">🎤 Voice ready</span>
                </div>`;
                previewEl.classList.remove('hidden');
            }
        },
        onCancel: () => window.clearPendingVoice()
    });
}

document.getElementById('submit-post-btn').addEventListener('click', async () => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return; 
    // Site Control: block when posts are paused (admins bypass)
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    
    const text = document.getElementById('post-text').value.trim();
    const fileInput = document.getElementById('post-image-file');
    const files = Array.from(fileInput.files || []).slice(0, 4);
    if (!text && !files.length && !window._pendingVoiceBlob) return;
    
    // Cooldown gate (settings.postCooldownSec)
    if (!(await window.checkActionCooldown('post'))) return;

    const isVideo = files.length === 1 && files[0].type.startsWith('video/');
    if (isVideo) {
        if (!window.checkVideoUploadLimit()) return;
        const sizeLimitMB = window.siteSettings.videoSizeLimitMB ?? 20;
        if (files[0].size > sizeLimitMB * 1024 * 1024) {
            window.showAlert(`Video is too large. Max size is ${sizeLimitMB}MB.`);
            return;
        }
    } else if (files.length === 1) {
        if (!window.checkUploadLimit()) return;
    } else if (files.length > 1) {
        // Collage mode: photos only — every photo counts toward the daily upload limit
        if (files.some(f => f.type.startsWith('video/'))) {
            window.showAlert("Videos can't be combined into a collage. Please post the video by itself.");
            return;
        }
        for (let i = 0; i < files.length; i++) { if (!window.checkUploadLimit()) return; }
    }
    
    const btn = document.getElementById('submit-post-btn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    btn.disabled = true;

    try {
        let finalImage = ''; 
        let collageImages = [];
        if (files.length === 1) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            if (isVideo) {
                finalImage = await window.uploadToCloudinary(files[0], window.currentUser.uid);
                window.incrementVideoUploadLimit();
            } else {
                const base64Img = await window.compressImage(files[0]); 
                finalImage = await window.uploadToCloudinary(base64Img, window.currentUser.uid);
                window.incrementUploadLimit();
            }
        } else if (files.length > 1) {
            // Collage upload: compress + upload each photo, showing progress
            for (let i = 0; i < files.length; i++) {
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${i + 1}/${files.length}`;
                const base64Img = await window.compressImage(files[i]);
                collageImages.push(await window.uploadToCloudinary(base64Img, window.currentUser.uid));
                window.incrementUploadLimit();
            }
            finalImage = collageImages[0];
        }

        // Voice-message post: upload the recorded audio (if any) alongside text
        let finalAudio = '';
        if (window._pendingVoiceBlob) {
            // Daily voice-post limit (admin /config → Posts Upload Limits → Voice/Day).
            // Transaction is the authoritative guard: race-proof even if two tabs
            // record/post at the same time.
            const voiceLimit = Number(window.siteSettings?.voicePostLimit ?? 10);
            const voiceDay = new Date().toISOString().slice(0, 10);
            const quotaRef = ref(db, `voicePostUploadQuota/${window.currentUser.uid}/${voiceDay}`);
            const voiceQuota = await runTransaction(quotaRef, (count) => (Number(count || 0) >= voiceLimit ? undefined : Number(count || 0) + 1));
            if (!voiceQuota.committed) {
                throw new Error(`Daily voice post limit reached (${voiceLimit} recordings). Try again tomorrow.`);
            }
            finalAudio = await window.uploadToCloudinary(window._pendingVoiceBlob, window.currentUser.uid);
            window.clearPendingVoice();
        }

        const hasPhoto = Boolean((finalImage && !isVideo) || (collageImages && collageImages.length > 0));
        const { fsdb: targetFs, dbSource } = getRoundRobinFsdb();
        const postData = {
            authorId: window.currentUser.uid, text: text, image: finalImage,
            hasPhoto: hasPhoto,
            category: document.getElementById('post-category').value,
            timestamp: Date.now(), pinned: false, edited: false, locked: false, reactions: {},
            visibility: window.postVisibility || 'public',
            ...(finalAudio ? { audio: finalAudio } : {}),
            _dbSource: dbSource
        };
        if (collageImages.length > 1) postData.images = collageImages;
        const newPostRef = await addDoc(collection(targetFs, 'community_posts'), postData);
        window._postDbMap.set(newPostRef.id, dbSource);
        
        const pointsToAdd = window.siteSettings.starsPerPost ?? 10;
        update(ref(db, `users/${window.currentUser.uid}`), { points: increment(pointsToAdd) });
        window.notifyMentions(text, newPostRef.id);
        window.logActivity("posted a new update");

        // Daily Quest progress — count composer posts by category (General /
        // Reels only; Lobby/Games/Announcements don't count). My Day cross-posts
        // never reach this path, so they can't double-count as Reels.
        if (window.questTrack) {
            const questCat = document.getElementById('post-category').value;
            if (questCat === 'General') window.questTrack('posts');
            else if (questCat === 'Reels') window.questTrack('reels');
        }
        
        document.getElementById('post-text').value = '';
        fileInput.value = '';
        const previewEl = document.getElementById('media-preview-container');
        if (previewEl) { previewEl.innerHTML = ''; previewEl.classList.add('hidden'); }
        const fileNameEl = document.getElementById('file-name');
        if (fileNameEl) fileNameEl.innerText = '';
        window.clearIsolatedPost();

        window.postVisibility = 'public';
        const eyeBtn = document.getElementById('visibility-toggle-btn');
        if(eyeBtn) {
            eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 mr-1 text-xs"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
            eyeBtn.title = "Public Post";
        }

        // Back to the default My Day view after a successful post
        window.closeCreateComposer();
        window._filterCache = {};
        
    } catch (err) { window.showAlert("Failed to post: " + err.message); }
    
    btn.innerText = "Post"; btn.disabled = false;
});

window.submitComment = async (postId, postAuthorId, prefix) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    // My Day posts (Reels tab) keep their comments in RTDB 2, keyed by the post id:
    //   /myday_comments/{postId}/{commentId} = { uid, text, timestamp }
    if (postId && postId.startsWith('myday_')) {
        const input = document.getElementById(`comment-input-${prefix}-${postId}`);
        const text = input ? input.value.trim() : '';
        if (!text) return;
        if (window.checkSitePaused && window.checkSitePaused('post')) return;
        if (!(await window.checkActionCooldown('comment'))) return;
        input.value = '';
        const btn = document.getElementById(`comment-submit-btn-${prefix}-${postId}`);
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; btn.disabled = true; }
        try {
            await push(ref(db2, `myday_comments/${postId}`), { uid: window.currentUser.uid, text: text, timestamp: Date.now() });
            // Tell the My Day owner (never yourself) — same RTDB 2 notification node
            // the bell list + local push already listen to.
            if (postAuthorId && postAuthorId !== window.currentUser.uid && postAuthorId !== 'undefined') {
                push(ref(db2, `notifications/${postAuthorId}`), { type: 'comment_myday', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false }).catch(() => {});
            }
        } catch (e) {
            window.showToast('Could not post comment: ' + e.message);
        }
        if (btn) { btn.innerText = 'Send'; btn.disabled = false; }
        input.focus();
        return;
    }
    // Site Control: block when posts are paused (admins bypass)
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    
    const input = document.getElementById(`comment-input-${prefix}-${postId}`); 
    const text = input.value.trim(); 
    const fileInput = document.getElementById(`comment-image-${prefix}-${postId}`);
    const file = fileInput ? fileInput.files[0] : null;
    
    if (!text && !file) return;
    // Cooldown gate (settings.commentCooldownSec) — checked before clearing input so text is kept
    if (!(await window.checkActionCooldown('comment'))) return;

    input.value = '';
    if (fileInput) { fileInput.value = ''; document.getElementById(`comment-img-name-${prefix}-${postId}`).innerText = ''; }
    
    const btn = document.getElementById(`comment-submit-btn-${prefix}-${postId}`);
    if(btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; btn.disabled = true; }
    
    if (file && !window.checkUploadLimit()) {
        if(btn) { btn.innerText = "Send"; btn.disabled = false; }
        return;
    }

    let finalImage = null;
    if (file) {
        try { 
            const base64Img = await window.compressImage(file, true);
            finalImage = await window.uploadToCloudinary(base64Img, window.currentUser.uid);
            window.incrementUploadLimit();
        } catch(e) { 
            console.error("Compression failed", e); 
            if(btn) { btn.innerText = "Send"; btn.disabled = false; }
            return;
        }
    }

    input.focus();

    const postDocRef = getPostDocRef(postId);
    const commentId = doc(collection(postDocRef.firestore, 'community_posts')).id;
    await updateDoc(postDocRef, { 
        [`comments.${commentId}`]: {
            uid: window.currentUser.uid, 
            text: text, 
            image: finalImage,
            timestamp: Date.now(), 
            edited: false 
        }
    });
    const pointsToAdd = window.siteSettings.starsPerLike ?? 1;
    update(ref(db, `users/${window.currentUser.uid}`), { points: increment(pointsToAdd) });
    // Daily Quest progress — post comments only (My Day comments & replies return earlier).
    if (window.questTrack) window.questTrack('comments');
    
    if(window.currentUser.uid !== postAuthorId && postAuthorId !== "undefined") {
        update(ref(db, `users/${postAuthorId}`), { points: increment(pointsToAdd) });
        push(ref(db2, `notifications/${postAuthorId}`), { 
            type: 'comment', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
        });
    }

    window.notifyMentions(text, postId);
    if(btn) { btn.innerText = "Send"; btn.disabled = false; }
};

window.submitReply = async (postId, commentId, prefix, commentAuthorId) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    const input = document.getElementById(`reply-input-${prefix}-${commentId}`); 
    const text = input.value.trim(); if (!text) return;
    // Cooldown gate (settings.commentCooldownSec) — checked before clearing input so text is kept
    if (!(await window.checkActionCooldown('comment'))) return;

    input.value = '';
    
    const postDocRef = getPostDocRef(postId);
    const replyId = doc(collection(postDocRef.firestore, 'community_posts')).id;
    await updateDoc(postDocRef, {
        [`comments.${commentId}.replies.${replyId}`]: { uid: window.currentUser.uid, text: text, timestamp: Date.now(), edited: false }
    });
    const pointsToAdd = window.siteSettings.starsPerComment ?? 1;
    update(ref(db, `users/${window.currentUser.uid}`), { points: increment(pointsToAdd) });
    const commentAuthorName = window.globalUsersCache?.[commentAuthorId]?.name || commentAuthorId;
    window.logActivity(`commented on a post by ${commentAuthorName}`);
    
    if(window.currentUser.uid !== commentAuthorId && commentAuthorId !== "undefined") {
        push(ref(db2, `notifications/${commentAuthorId}`), { 
            type: 'reply', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
        });
    }

    window.notifyMentions(text, postId);
    window.openRepliesList.add(commentId);
    input.focus();
};

// Feed helper used by the My Day reaction buttons in the Reels tab. Syncs with the
// original My Day (active stories) / the archive entry, then repaints the feed.
window.mydayReactPost = (postId, emoji) => {
    if (window.MyDay && typeof window.MyDay.reactToPost === 'function') {
        window.MyDay.reactToPost(postId, emoji);
    }
};

window.react = (postId, postAuthorId, type) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    if (postId && postId.startsWith('myday_')) {
        const emojiMap = { like: '👍', heart: '❤️', haha: '😂', wow: '😮', sad: '😢', angry: '😡' };
        window.mydayReactPost(postId, emojiMap[type] || '👍');
        return;
    }
    let post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId); if(!post) return;
    
    let userReactCount = 0;
    if (post.reactions) {
        for (let t in post.reactions) {
            if (post.reactions[t][window.currentUser.uid]) userReactCount++;
        }
    }
    
    const postDocRef = getPostDocRef(postId);
    const hasReacted = post.reactions && post.reactions[type] && post.reactions[type][window.currentUser.uid];
    if(hasReacted) {
        updateDoc(postDocRef, {
            [`reactions.${type}.${window.currentUser.uid}`]: deleteField()
        });
        const likePoints = window.siteSettings.starsPerLike ?? 1;
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") update(ref(db, `users/${postAuthorId}`), { points: increment(-likePoints) });
    } else {
        if (userReactCount >= 3) {
            window.showAlert("You can only have up to 3 simultaneous reactions on a post.");
            return;
        }
        updateDoc(postDocRef, {
            [`reactions.${type}.${window.currentUser.uid}`]: true
        });
        // Daily Quest progress — react given. questTrack's atomic marker
        // transaction dedupes per post, so react/unreact toggling can never
        // farm the counter. (Metric key is 'reacts' — plural, like QUEST_METRICS.)
        if (window.questTrack) window.questTrack('reacts', postId);
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") {
        const likePoints = window.siteSettings.starsPerLike ?? 1;
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") {
            update(ref(db, `users/${postAuthorId}`), { points: increment(likePoints) });
        }
            push(ref(db2, `notifications/${postAuthorId}`), { 
                type: 'react_post', sourceUid: window.currentUser.uid, postId: postId, reactType: type, timestamp: Date.now(), read: false 
            });
        }
        const postAuthorName = window.globalUsersCache?.[postAuthorId]?.name || postAuthorId;
        window.logActivity(`reacted to a post by ${postAuthorName}`);
    }
};

window.reactComment = (postId, commentId, commentAuthorId, type) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    let post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId); if(!post) return;
    let comment = post.comments && post.comments[commentId]; if(!comment) return;
    
    let userReactCount = 0;
    if (comment.reactions) {
        for (let t in comment.reactions) {
            if (comment.reactions[t][window.currentUser.uid]) userReactCount++;
        }
    }
    
    const postDocRef = getPostDocRef(postId);
    const hasReacted = comment.reactions && comment.reactions[type] && comment.reactions[type][window.currentUser.uid];
    if(hasReacted) {
        updateDoc(postDocRef, {
            [`comments.${commentId}.reactions.${type}.${window.currentUser.uid}`]: deleteField()
        });
        const likePoints = window.siteSettings.starsPerLike ?? 1;
        if(commentAuthorId !== window.currentUser.uid && commentAuthorId !== "undefined") update(ref(db, `users/${commentAuthorId}`), { points: increment(-likePoints) });
    } else {
        if (userReactCount >= 3) {
            window.showAlert("You can only have up to 3 simultaneous reactions on a comment.");
            return;
        }
        updateDoc(postDocRef, {
            [`comments.${commentId}.reactions.${type}.${window.currentUser.uid}`]: true
        });
        if(commentAuthorId !== window.currentUser.uid && commentAuthorId !== "undefined") {
            const likePoints = window.siteSettings.starsPerLike ?? 1;
            update(ref(db, `users/${commentAuthorId}`), { points: increment(likePoints) });
            push(ref(db2, `notifications/${commentAuthorId}`), { 
                type: 'react_comment', sourceUid: window.currentUser.uid, postId: postId, reactType: type, timestamp: Date.now(), read: false 
            });
        }
        const commentAuthorName = window.globalUsersCache?.[commentAuthorId]?.name || commentAuthorId;
        window.logActivity(`reacted to a comment by ${commentAuthorName}`);
    }
};

window.reactReply = (postId, commentId, replyId, replyAuthorId, type) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    let post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId); if(!post) return;
    let comment = post.comments && post.comments[commentId]; if(!comment) return;
    let reply = comment.replies && comment.replies[replyId]; if(!reply) return;
    
    let userReactCount = 0;
    if (reply.reactions) {
        for (let t in reply.reactions) {
            if (reply.reactions[t][window.currentUser.uid]) userReactCount++;
        }
    }
    
    const postDocRef = getPostDocRef(postId);
    const hasReacted = reply.reactions && reply.reactions[type] && reply.reactions[type][window.currentUser.uid];
    if(hasReacted) {
        updateDoc(postDocRef, {
            [`comments.${commentId}.replies.${replyId}.reactions.${type}.${window.currentUser.uid}`]: deleteField()
        });
        const likePoints = window.siteSettings.starsPerLike ?? 1;
        if(replyAuthorId !== window.currentUser.uid && replyAuthorId !== "undefined") update(ref(db, `users/${replyAuthorId}`), { points: increment(-likePoints) });
    } else {
        if (userReactCount >= 3) {
            window.showAlert("You can only have up to 3 simultaneous reactions on a reply.");
            return;
        }
        updateDoc(postDocRef, {
            [`comments.${commentId}.replies.${replyId}.reactions.${type}.${window.currentUser.uid}`]: true
        });
        if(replyAuthorId !== window.currentUser.uid && replyAuthorId !== "undefined") {
            const likePoints = window.siteSettings.starsPerLike ?? 1;
            update(ref(db, `users/${replyAuthorId}`), { points: increment(likePoints) });
            push(ref(db2, `notifications/${replyAuthorId}`), { 
                type: 'react_reply', sourceUid: window.currentUser.uid, postId: postId, reactType: type, timestamp: Date.now(), read: false 
            });
        }
    }
};

// ==========================================
// COMMENT & REPLY UI TOGGLES
// ==========================================
window.toggleComments = (postId, prefix) => {
    const elMain = document.getElementById(`comments-main-${postId}`);
    const elProf = document.getElementById(`comments-profile-${postId}`);
    if(window.openComments.has(postId)) { 
        window.openComments.delete(postId); 
        if(elMain) elMain.classList.add('hidden'); 
        if(elProf) elProf.classList.add('hidden'); 
    } else { 
        window.openComments.add(postId); 
        if(elMain) elMain.classList.remove('hidden'); 
        if(elProf) elProf.classList.remove('hidden'); 
    }
};

window.toggleReplyBox = (cId, prefix) => {
    const elMain = document.getElementById(`reply-box-main-${cId}`);
    const elProf = document.getElementById(`reply-box-profile-${cId}`);
    if(window.openReplies.has(cId)) { 
        window.openReplies.delete(cId); 
        if(elMain) { elMain.classList.add('hidden'); elMain.classList.remove('flex'); } 
        if(elProf) { elProf.classList.add('hidden'); elProf.classList.remove('flex'); } 
    } else { 
        window.openReplies.add(cId); 
        if(elMain) { elMain.classList.remove('hidden'); elMain.classList.add('flex'); } 
        if(elProf) { elProf.classList.remove('hidden'); elProf.classList.add('flex'); } 
    }
};

window.toggleRepliesList = (cId, prefix) => {
    const elMain = document.getElementById(`replies-list-main-${cId}`);
    const elProf = document.getElementById(`replies-list-profile-${cId}`);
    if(window.openRepliesList.has(cId)) { 
        window.openRepliesList.delete(cId); 
        if(elMain) elMain.classList.add('hidden'); 
        if(elProf) elProf.classList.add('hidden'); 
    } else { 
        window.openRepliesList.add(cId); 
        if(elMain) elMain.classList.remove('hidden'); 
        if(elProf) elProf.classList.remove('hidden'); 
    }
};

window.toggleCommentSort = (postId) => {
    const current = window.commentSortState[postId] || 'oldest';
    window.commentSortState[postId] = current === 'oldest' ? 'newest' : 'oldest';
    if (window.activeProfileUid) window.renderProfileData(false);
    else window.renderFeed(false);
};

window.prepareReplyToReply = (cId, prefix, targetUid) => {
    const targetName = window.globalUsersCache[targetUid]?.name || "User";
    const elMain = document.getElementById(`reply-box-main-${cId}`);
    const elProf = document.getElementById(`reply-box-profile-${cId}`);
    
    window.openReplies.add(cId); 
    if(elMain) { elMain.classList.remove('hidden'); elMain.classList.add('flex'); } 
    if(elProf) { elProf.classList.remove('hidden'); elProf.classList.add('flex'); } 
    
    window.openRepliesList.add(cId);
    const listMain = document.getElementById(`replies-list-main-${cId}`);
    const listProf = document.getElementById(`replies-list-profile-${cId}`);
    if (listMain) listMain.classList.remove('hidden');
    if (listProf) listProf.classList.remove('hidden');

    const input = document.getElementById(`reply-input-${prefix}-${cId}`);
    if(input) {
        input.value = `@${targetName} `;
        input.focus();
    }
};

// ==========================================
// EDITING & POST CONTROLS
// ==========================================
window.openEditModal = (targetData, currentText) => {
    window.activeEditTarget = targetData;
    document.getElementById('edit-content-input').value = currentText || "";

    // Reset shared modal (it is also used for custom reactions / comment-reply edits)
    const titleEl = document.querySelector('#edit-modal h2');
    if (titleEl) titleEl.innerHTML = '<i class="fa-solid fa-pen text-blue-500 mr-2"></i> Edit Content';
    const inputEl = document.getElementById('edit-content-input');
    if (inputEl) inputEl.placeholder = 'Edit your text here...';

    // Category change: only for top-level posts, authored by an Admin or Mod, and never game posts.
    const catWrap = document.getElementById('edit-category-wrap');
    const catSelect = document.getElementById('edit-category');
    let allowed = null;
    if (catWrap && catSelect && targetData && typeof targetData.path === 'string') {
        const parts = targetData.path.split('/');
        const isTopLevelPost = parts.length === 2 && parts[0] === 'community_posts';
        catSelect.innerHTML = '';
        if (isTopLevelPost) {
            const post = (window.allPosts || []).find(p => p.id === targetData.postId)
                || (window.globalPinnedPosts || []).find(p => p.id === targetData.postId)
                || (window.profilePinnedPosts || []).find(p => p.id === targetData.postId)
                || (window.isolatedPostData && window.isolatedPostData.id === targetData.postId ? window.isolatedPostData : null);
            const roleLevel = window.currentUser ? window.getRole(window.currentUser.uid).level : 1;
            const currentCat = post ? post.category : null;
            // Lobby posts are locked to their category — never offer a category change
            // for them (same treatment as game posts), so Lobby can't drift to General.
            if (post && !post.isGame && !post.isLobby && currentCat !== 'Games' && currentCat !== 'Lobby' && roleLevel >= 2) {
                allowed = roleLevel >= 3 ? ['General', 'Announcements', 'Rules', 'Reels'] : ['General', 'Announcements', 'Reels'];
                allowed.forEach(cat => {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.textContent = cat;
                    if (currentCat === cat) opt.selected = true;
                    catSelect.appendChild(opt);
                });
            }
        }
    }
    if (allowed && catSelect.childNodes.length > 0) {
        catWrap.classList.remove('hidden');
    } else {
        catWrap.classList.add('hidden');
    }
    window.activeEditTarget.allowedCategories = allowed;

    document.getElementById('edit-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('edit-content-input').focus(), 100);
};

document.getElementById('save-edit-btn').addEventListener('click', () => {
    if (!window.activeEditTarget) return;
    const newText = document.getElementById('edit-content-input').value.trim();
    if (newText !== "") {
        const dbPath = window.activeEditTarget.path;
        if (dbPath.startsWith('community_posts/')) {
            const parts = dbPath.split('/');
            const postId = parts[1];
            const postDocRef = getPostDocRef(postId);
            if (parts.length === 2) {
                const edits = { text: newText, edited: true };
                const catSelect = document.getElementById('edit-category');
                const allowed = window.activeEditTarget.allowedCategories;
                if (allowed && Array.isArray(allowed) && catSelect && allowed.includes(catSelect.value)) {
                    edits.category = catSelect.value;
                }
                updateDoc(postDocRef, edits);
            } else if (parts.length === 4 && parts[2] === 'comments') {
                const cId = parts[3];
                updateDoc(postDocRef, {
                    [`comments.${cId}.text`]: newText,
                    [`comments.${cId}.edited`]: true
                });
            } else if (parts.length === 6 && parts[2] === 'comments' && parts[4] === 'replies') {
                const cId = parts[3];
                const rId = parts[5];
                updateDoc(postDocRef, {
                    [`comments.${cId}.replies.${rId}.text`]: newText,
                    [`comments.${cId}.replies.${rId}.edited`]: true
                });
            }
        } else if (window.activeEditTarget.db2) {
            // RTDB 2 target (e.g. My Day comments in the Reels tab)
            update(ref(db2, window.activeEditTarget.path), { text: newText, edited: true });
        } else {
            // Fallback for RTDB (if any)
            update(ref(db, window.activeEditTarget.path), { text: newText, edited: true });
        }
        window.notifyMentions(newText, window.activeEditTarget.postId);
    }
    document.getElementById('edit-modal').classList.add('hidden');
    window.activeEditTarget = null;
});

window.editPost = (postId) => {
    const post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId);
    if (!post || post.authorId !== window.currentUser.uid) return;
    window.openEditModal({ path: `community_posts/${postId}`, postId: postId }, post.text);
};

window.editComment = (postId, cId) => {
    const post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId);
    if (!post || !post.comments || !post.comments[cId]) return;
    const c = post.comments[cId];
    if (c.uid !== window.currentUser.uid) return;
    window.openEditModal({ path: `community_posts/${postId}/comments/${cId}`, postId: postId }, c.text);
};

window.editReply = (postId, cId, rId) => {
    const post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId);
    if (!post || !post.comments || !post.comments[cId] || !post.comments[cId].replies || !post.comments[cId].replies[rId]) return;
    const r = post.comments[cId].replies[rId];
    if (r.uid !== window.currentUser.uid) return;
    window.openEditModal({ path: `community_posts/${postId}/comments/${cId}/replies/${rId}`, postId: postId }, r.text);
};

window.togglePostVisibility = (postId, currentVis) => {
    const newVis = currentVis === 'private' ? 'public' : 'private';
    updateDoc(getPostDocRef(postId), { visibility: newVis });
    if(window.showAlert) window.showAlert(`Post updated to ${newVis === 'private' ? 'Private' : 'Public'}`);
};


// ==========================================
// PROFILE EDITING
// ==========================================
document.getElementById('profile-relationship').addEventListener('change', (e) => {
    const val = e.target.value;
    if(['In a relationship', 'Engaged', 'Married', 'Complicated'].includes(val)) {
        document.getElementById('profile-partner').classList.remove('hidden');
    } else {
        document.getElementById('profile-partner').classList.add('hidden');
    }
});

// ==========================================
// NAV AVATAR MENU (small dropdown under the nav avatar)
// ==========================================
// Items: username -> profile page, Edit Profile, Install App, Logout.
// Markup lives in index.html (#user-menu); open/close is click-outside + Escape,
// same pattern as the floating action stack above.
const _userMenuEl = () => document.getElementById('user-menu');
const _userMenuBtn = () => document.getElementById('nav-avatar-btn');

window.closeUserMenu = () => {
    const m = _userMenuEl();
    if (!m) return;
    m.classList.add('hidden');
    const b = _userMenuBtn();
    if (b) b.setAttribute('aria-expanded', 'false');
};

window.toggleUserMenu = (e) => {
    if (e) e.stopPropagation(); // keep the document click handler below from closing it instantly
    const m = _userMenuEl();
    if (!m) return;
    if (!m.classList.contains('hidden')) { window.closeUserMenu(); return; }
    // Populate from the shared users cache (fall back to the auth record).
    const uid = window.currentUser ? window.currentUser.uid : null;
    const u = (uid && window.globalUsersCache[uid]) || {};
    const name = u.name || (window.currentUser && window.currentUser.displayName) || 'My Profile';
    const pic = u.pic || (window.currentUser && window.currentUser.photoURL) || (uid ? window.generateAvatar(uid) : '');
    const nameEl = document.getElementById('user-menu-name');
    const avatarEl = document.getElementById('user-menu-avatar');
    if (nameEl) nameEl.textContent = name;
    if (avatarEl && pic) avatarEl.src = pic;
    m.classList.remove('hidden');
    _userMenuBtn()?.setAttribute('aria-expanded', 'true');
};

window.userMenuProfile = () => {
    const uid = window.currentUser ? window.currentUser.uid : null;
    window.closeUserMenu();
    if (uid) window.openProfile(uid);
};
window.userMenuEditProfile = () => { window.closeUserMenu(); window.openEditProfile(); };
window.userMenuInstall = () => { window.closeUserMenu(); window.installHangout(); };
window.userMenuLogout = () => { window.closeUserMenu(); window.logoutUser(); };

// ==========================================
// RECRUITS MODAL (account menu -> Recruits)
// ==========================================
// Lists every account that picked the signed-in member as its recruiter and
// sorts them into Valid / Invalid. A recruit is INVALID when:
//   1. it appears in ANY group of the admin's flagged-group mirror (multi-account),
//   2. its IP matches the RECRUITER's own IP, or
//   3. its IP matches an EARLIER recruit's IP in the same chain.
// /user_ips stays admin+owner-only, so no client ever reads another account's
// IPs: the recruit stores a one-way fingerprint of its OWN IP, and (1) is served
// by /flaggedGroups — uids only, no IPs. Reads RTDB 3 at recruits/{myUid}/….
window._recruitsTab = 'valid';
window._recruitsRows = [];
// One shared verdict string so the judge and the claim-time re-check always
// agree. Must stay inside the 40-char cap in database3.rules.json.
const FLAGGED_GROUP_REASON = 'Flagged as multi-account (shared IP)';

window.userMenuRecruits = () => {
    window.closeUserMenu();
    const modal = document.getElementById('recruits-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    paintRecruitRewardInfo();
    window._recruitsTab = 'valid';
    window.renderRecruits();
};

// My own /user_ips -> fingerprints. Owner-readable, so this is always allowed.
// Returns null on a READ FAILURE so the caller can abort rather than judge a
// recruit with an empty IP set (which would silently disable Rule 1).
async function myIpFingerprints(uid) {
    const out = new Set();
    try {
        const snap = await get(ref(db, `user_ips/${uid}`));
        const ips = (snap.exists() && snap.val() && snap.val().ips) || {};
        for (const key of Object.keys(ips)) {
            // Stored keys swap "." for "_" (RTDB can't use dotted keys); undo that
            // so we hash the SAME string the recruit hashed. Legacy dotted keys and
            // IPv6 keys contain no "_" and pass through unchanged.
            const raw = key.includes('_') ? key.replace(/_/g, '.') : key;
            out.add(await ipFingerprint(raw));
        }
    } catch (e) {
        console.warn('Recruit IP check failed:', e);
        return null;
    }
    return out;
}

// Rule 3 — every uid sitting in ANY admin-flagged IP group.
// Read /flaggedGroups directly instead of reusing games.js's uid -> single-gid
// cache: a uid may legitimately sit in SEVERAL groups, so a single gid silently
// drops matches. Comparing raw membership here leaves games.js untouched.
// NOTE: this deliberately does NOT care WHO else is in the group — a recruit
// that shares an IP with any existing account is a multi-account risk even when
// that account isn't the recruiter.
async function allFlaggedUids() {
    try {
        const snap = await get(ref(db, 'flaggedGroups'));
        if (!snap.exists()) return new Set();
        // uids come back as an array, but tolerate the object form too.
        const toArr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
        const out = new Set();
        Object.values(snap.val() || {}).forEach(g => toArr(g && g.uids).forEach(u => out.add(u)));
        return out;
    } catch (e) {
        // null = READ FAILED (distinct from an empty set = genuinely unflagged)
        // so the caller can abort instead of judging — and caching — a wrong verdict.
        console.warn('[recruits] flaggedGroups read failed:', e);
        return null;
    }
}

// ── Recruits modal cache (localStorage) ──────────────────────────────────
// Paints straight from the cache and only revalidates against RTDB once the
// entry is older than RECRUITS_CACHE_TTL — so repeated opens cost ZERO reads.
// Keyed by recruiter uid so a shared device never bleeds one account's
// recruits into another. Every failure is swallowed: the cache is a nicety,
// never a blocker (same pattern as the users cache / pet local mirror).
const RECRUITS_CACHE_TTL = 2 * 60 * 1000;   // the 2-minute house cadence (README §10)
const recruitsCacheKey = (uid) => `hangout-recruits:${uid}`;

function readRecruitsCache(uid) {
    if (!uid) return null;
    try {
        const c = JSON.parse(localStorage.getItem(recruitsCacheKey(uid)) || 'null');
        return (c && Array.isArray(c.rows)) ? c : null;
    } catch (e) { return null; }
}

function writeRecruitsCache(uid, rows) {
    if (!uid) return;
    try { localStorage.setItem(recruitsCacheKey(uid), JSON.stringify({ at: Date.now(), rows })); }
    catch (e) { /* quota exceeded — drop it, the modal still works */ }
}

window.renderRecruits = async () => {
    const list = document.getElementById('recruits-list');
    const countEl = document.getElementById('recruits-count');
    const loader = document.getElementById('recruits-loader');
    if (!list) return;

    const uid = window.currentUser ? window.currentUser.uid : null;
    if (!uid) {
        window._recruitsRows = [];
        if (countEl) countEl.textContent = '0 Total';
        list.innerHTML = `<p class="text-center text-gray-500 dark:text-gray-400 text-xs py-6">Sign in to see your recruits.</p>`;
        return;
    }

    // 1) Paint straight from the cache — the modal never waits on the network.
    const cached = readRecruitsCache(uid);
    if (cached) {
        window._recruitsRows = cached.rows;
        if (countEl) countEl.textContent = `${cached.rows.length} Total`;
        window.paintRecruits();
    } else {
        // Cold load only: spinner + blank list.
        if (loader) loader.classList.remove('hidden');
        list.innerHTML = '';
    }

    // 2) Still fresh — NO database call at all.
    if (cached && (Date.now() - cached.at) < RECRUITS_CACHE_TTL) return;

    // 3) Revalidate. A warm refresh repaints silently (no spinner) and only
    //    when something actually changed — see the tail of this function.
    let data = null;
    let ownHashes = new Set();
    let loaded = false;
    try {
        const [snap, hashes] = await Promise.all([
            get(ref(db3, `recruits/${uid}`)),
            myIpFingerprints(uid)
        ]);
        data = (snap && snap.exists()) ? snap.val() : null;
        ownHashes = hashes;
        loaded = true;
    } catch (e) {
        console.warn('Recruits load failed:', e);
    }
    // Rule 3: the admin's same-IP mirror (/flaggedGroups — uids only, no IPs).
    // Read directly so a stale shared cache can't hide a match.
    const flaggedUids = await allFlaggedUids();
    console.debug('[recruits] rule 3 — flagged uids:', flaggedUids ? [...flaggedUids] : flaggedUids);
    if (loader) loader.classList.add('hidden');

    // A failed read must NOT wipe a good cache or write a wrong verdict —
    // keep whatever we already painted and let the next open retry.
    if (!loaded || ownHashes === null || flaggedUids === null) return;

    // Defensive: a uid becomes an inline onclick argument, so only accept
    // Firebase-shaped keys (letters, digits, dash, underscore).
    // Chronological — rule 2 only disqualifies SUCEEDING recruits.
    const rows = Object.values(data || {})
        .filter(r => r && typeof r.uid === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.uid))
        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));

    // Judge the chain. Verdicts only ever TIGHTEN: Invalid is permanent, while a
    // Valid row is re-checked on every open so fresh evidence (a shared flagged
    // group, a new IP of mine) can flip it — never the reverse. Rows with neither
    // a fingerprint nor a flagged group stay PENDING and are left undecided.
    const claimed = new Set(ownHashes);
    const patch = {};
    const judged = rows.map(r => {
        const fpr = typeof r.fpr === 'string' ? r.fpr : '';
        const isFlagged = flaggedUids.has(r.uid);

        // Evidence, strongest first — evaluated BEFORE this row's own IP is claimed.
        let evidence = '';
        if (isFlagged) evidence = FLAGGED_GROUP_REASON;
        else if (fpr && ownHashes.has(fpr)) evidence = 'Same IP as you';
        else if (fpr && claimed.has(fpr)) evidence = 'Same IP as an earlier recruit';

        let status, reason = '';
        if (r.valid === false) {
            // Invalid is PERMANENT — never re-opened, whatever the evidence says now.
            status = 'invalid';
            reason = (typeof r.reason === 'string' && r.reason) || evidence || 'Flagged by IP rules';
        } else if (evidence) {
            status = 'invalid';
            reason = evidence;
        } else if (fpr) {
            status = 'valid';
        } else {
            status = 'pending';
        }

        if (status === 'invalid') {
            if (r.valid !== false) patch[`${r.uid}/valid`] = false;
            if (r.reason !== reason) patch[`${r.uid}/reason`] = reason;
        } else if (status === 'valid' && r.valid !== true) {
            patch[`${r.uid}/valid`] = true;
        }

        if (fpr) claimed.add(fpr);   // rule 2: this IP is now taken
        return { ...r, status, reason };
    });

    if (Object.keys(patch).length) {
        try { await update(ref(db3, `recruits/${uid}`), patch); }
        catch (e) { console.warn('Recruit verdict write failed:', e); }
    }

    // Repaint ONLY when something actually changed; otherwise just refresh the
    // timestamp so the next open skips the round trip again.
    if (!cached || JSON.stringify(cached.rows) !== JSON.stringify(judged)) {
        window._recruitsRows = judged;
        if (countEl) countEl.textContent = `${judged.length} Total`;
        window.paintRecruits();
    }
    writeRecruitsCache(uid, judged);
};

window.setRecruitsTab = (tab) => {
    window._recruitsTab = (tab === 'invalid') ? 'invalid' : 'valid';
    window.paintRecruits();
};

// ── Recruit rewards ──────────────────────────────────────────────────────
// Every VALID recruit pays the recruiter one reward: LB points (credited to
// overall + daily/weekly/monthly) plus a ₱ prize that is DISPLAY-ONLY for now.
// Both amounts and the claim cooldown come from /config → settings.
function recruitRewardConfig() {
    const s = window.siteSettings || {};
    return {
        lb: Math.max(0, Number(s.recruitLbReward ?? 10) || 0),
        prize: Math.max(0, Number(s.recruitPrizeReward ?? 50) || 0),
        cooldownMs: Math.max(0, Number(s.recruitClaimCooldownHrs ?? 48) || 0) * 3600 * 1000
    };
}
// Exposed for the Recruits tab of the Rankings modal (js/renderers.js).
window.recruitRewardConfig = recruitRewardConfig;

// Fills the "Reward per valid recruit" banner in the Recruits modal.
// Pure DOM — no network, so it is cheap to call on every open.
function paintRecruitRewardInfo() {
    const cfg = recruitRewardConfig();
    const lb = document.getElementById('recruit-info-lb');
    const prize = document.getElementById('recruit-info-prize');
    const cd = document.getElementById('recruit-info-cooldown');
    if (lb) lb.textContent = cfg.lb.toLocaleString();
    if (prize) prize.textContent = cfg.prize.toLocaleString();
    const hrs = cfg.cooldownMs / 3600000;
    if (cd) {
        cd.textContent = (hrs >= 24 && hrs % 24 === 0)
            ? `${hrs / 24} day${hrs === 24 ? '' : 's'}`
            : `${hrs}h`;
    }
}

// "1d 22h" / "3h 12m" / "14m" — how long until a reward unlocks.
function fmtRecruitWait(ms) {
    const mins = Math.max(0, Math.ceil(ms / 60000));
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function recruitClaimBtnHtml(r, cfg) {
    if (r.claimedAt) {
        return `<button type="button" disabled class="px-2 py-1 rounded text-[9px] font-bold bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30 cursor-default">Claimed ✓</button>`;
    }
    const wait = ((Number(r.joinedAt) || 0) + cfg.cooldownMs) - Date.now();
    if (wait > 0) {
        return `<button type="button" disabled class="px-2 py-1 rounded text-[9px] font-bold bg-gray-100 dark:bg-slate-700 text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-slate-600 cursor-not-allowed">Claim in ${fmtRecruitWait(wait)}</button>`;
    }
    return `<button type="button" onclick="event.stopPropagation(); window.claimRecruitReward('${r.uid}')" class="px-2 py-1 rounded text-[9px] font-bold bg-blue-600 text-white hover:bg-blue-500 transition shadow-sm">Claim</button>`;
}

window._claimingRecruit = false;

// Claim ONE valid recruit's reward. Atomic: the transaction re-reads the live
// record, so a double-click, a second tab or a stale modal cache can never pay
// the same recruit twice.
window.claimRecruitReward = async (recruitUid) => {
    const uid = window.currentUser ? window.currentUser.uid : null;
    if (!uid || !recruitUid || window._claimingRecruit) return;

    const row = (window._recruitsRows || []).find(r => r.uid === recruitUid);
    if (!row || row.status !== 'valid' || row.claimedAt) return;

    const cfg = recruitRewardConfig();
    if (Date.now() < ((Number(row.joinedAt) || 0) + cfg.cooldownMs)) return;

    window._claimingRecruit = true;
    try {
        // Re-check the flagged-group mirror RIGHT NOW. It may have been refreshed
        // (an admin opened /config) since this recruit was last judged — and the
        // modal's verdict can be minutes old because of the localStorage cache.
        // Paying on a stale "valid" is the one mistake that cannot be undone.
        const flagged = await allFlaggedUids();
        if (flagged === null) {
            window.showToast && window.showToast('Could not verify this recruit right now — try again.');
            return;
        }
        if (flagged.has(recruitUid)) {
            await update(ref(db3, `recruits/${uid}/${recruitUid}`), { valid: false, reason: FLAGGED_GROUP_REASON })
                .catch(e => console.warn('Recruit re-flag write failed:', e));
            row.status = 'invalid';
            row.valid = false;
            row.reason = FLAGGED_GROUP_REASON;
            window.paintRecruits();
            writeRecruitsCache(uid, window._recruitsRows || []);
            window.showToast && window.showToast('Claim refused — this recruit is flagged as multi-account.');
            return;
        }

        const res = await runTransaction(ref(db3, `recruits/${uid}/${recruitUid}`), (cur) => {
            if (!cur) return undefined;                                                  // gone
            if (cur.valid !== true) return undefined;                                     // no longer valid
            if (cur.claimedAt) return undefined;                                          // already paid
            if (Date.now() < ((Number(cur.joinedAt) || 0) + cfg.cooldownMs)) return undefined; // still cooling down
            return { ...cur, claimedAt: Date.now() };
        });

        if (!res.committed) {
            window.showToast && window.showToast('This reward is not claimable yet.');
            return;
        }

        // Credit ALL four buckets: overall (users/{uid}/lbPoints) + the daily /
        // weekly / monthly period counters via the shared helper in js/games.js.
        if (cfg.lb > 0) {
            set(ref(db, `users/${uid}/lbPoints`), increment(cfg.lb));
            if (window.creditLbPeriods) window.creditLbPeriods(uid, cfg.lb);
        }

        row.claimedAt = Date.now();
        window.paintRecruits();
        writeRecruitsCache(uid, window._recruitsRows || []);
        window.showToast && window.showToast(`Recruit claimed! +${cfg.lb} LB credited.`);
    } catch (e) {
        console.warn('Recruit claim failed:', e);
        window.showToast && window.showToast('Claim failed — please try again.');
    } finally {
        window._claimingRecruit = false;
    }
};

// Two tabs. PENDING rows sit in the Valid tab with an amber badge — they are
// not counted as invalid, they simply have no IP to compare yet.
window.paintRecruits = () => {
    const active = (window._recruitsTab === 'invalid') ? 'invalid' : 'valid';
    const rows = window._recruitsRows || [];
    const validCount = rows.filter(r => r.status !== 'invalid').length;
    const invalidCount = rows.filter(r => r.status === 'invalid').length;

    ['valid', 'invalid'].forEach(t => {
        const btn = document.getElementById('recruits-tab-' + t);
        if (btn) {
            const on = (t === active);
            btn.className = `px-3 py-1 rounded-full text-[11px] font-bold transition ${on
                ? 'bg-blue-600 text-white border border-transparent'
                : 'bg-gray-100 text-gray-700 dark:bg-slate-900 dark:text-gray-300 border border-gray-200 dark:border-slate-700'}`;
        }
        const badge = document.getElementById('recruits-tabcount-' + t);
        if (badge) badge.textContent = (t === 'valid') ? validCount : invalidCount;
    });

    const list = document.getElementById('recruits-list');
    if (!list) return;
    const shown = rows
        .filter(r => (active === 'invalid') ? r.status === 'invalid' : r.status !== 'invalid')
        .sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));

    if (!shown.length) {
        list.innerHTML = `<p class="text-center text-gray-500 dark:text-gray-400 text-xs py-6">${
            rows.length
                ? (active === 'invalid' ? 'No invalid recruits 🎉' : 'Nothing here yet.')
                : 'No recruits yet.<br>Members who pick you as their recruiter will appear here.'
        }</p>`;
        return;
    }

    const esc = window.escapeHtml || ((s) => String(s ?? ''));
    const cfg = recruitRewardConfig();
    list.innerHTML = shown.map(r => {
        const live = window.globalUsersCache[r.uid] || {};
        const name = live.name || r.name || 'New member';
        const pic = live.pic || r.pic || window.generateAvatar(r.uid);
        const when = r.joinedAt
            ? new Date(r.joinedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
        const pending = r.status === 'pending';
        const invalid = r.status === 'invalid';
        // Rewards are paid on VALID recruits only.
        const rewardsHtml = (r.status === 'valid') ? `
            <div class="flex flex-col items-end gap-1 shrink-0 ml-2">
                <div class="flex items-center gap-1.5 text-[10px] font-bold whitespace-nowrap">
                    <span class="text-yellow-600 dark:text-yellow-400">🏆 ${cfg.lb} LB</span>
                    <span class="text-green-600 dark:text-green-400">₱${cfg.prize.toLocaleString()}</span>
                </div>
                ${recruitClaimBtnHtml(r, cfg)}
            </div>` : '';
        return `
        <div class="flex items-center justify-between p-2 rounded-lg mb-1 border ${invalid
            ? 'border-red-200 dark:border-red-500/30 bg-red-50/60 dark:bg-red-500/[0.06]'
            : 'border-gray-100 dark:border-slate-700/50 bg-gray-50 dark:bg-slate-900/50'} hover:opacity-80 cursor-pointer transition" onclick="window.openProfile('${r.uid}'); document.getElementById('recruits-modal').classList.add('hidden');">
            <div class="flex items-center space-x-2 min-w-0">
                <img src="${esc(pic)}" loading="lazy" class="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-slate-600 shrink-0">
                <div class="min-w-0">
                    <div class="flex items-center gap-1.5">
                        <span class="font-bold text-sm text-gray-900 dark:text-white truncate">${esc(name)}</span>
                        ${pending ? '<span class="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">PENDING</span>' : ''}
                        ${invalid ? '<span class="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30">INVALID</span>' : ''}
                    </div>
                    <div class="text-[10px] text-gray-400 dark:text-gray-500">${when ? 'Joined ' + esc(when) : ''}${invalid && r.reason ? ` · <span class="text-red-500 dark:text-red-400 font-semibold">${esc(r.reason)}</span>` : ''}</div>
                </div>
            </div>
            ${rewardsHtml}
        </div>`;
    }).join('');
};

document.addEventListener('click', (e) => {
    const m = _userMenuEl();
    if (!m || m.classList.contains('hidden')) return;
    if (e.target && e.target.closest && e.target.closest('#user-menu, #nav-avatar-btn')) return;
    window.closeUserMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.closeUserMenu(); });

document.getElementById('save-profile-btn').addEventListener('click', async () => {
    const newNameInput = document.getElementById('profile-name').value.trim();
    const cache = window.globalUsersCache[window.currentUser.uid] || {};
    const finalName = newNameInput || cache.name || window.currentUser.displayName || `User_${Math.floor(Math.random()*999)}`;
    
    const gender = document.getElementById('profile-gender').value;
    const relationship = document.getElementById('profile-relationship').value;
    let partner = document.getElementById('profile-partner').value.trim();
    const bio = document.getElementById('profile-bio').value.trim();
    if(!['In a relationship', 'Engaged', 'Married', 'Complicated'].includes(relationship)) partner = '';

    const fileInput = document.getElementById('profile-pic-file');
    const file = fileInput.files[0];

    // Cover photo (file upload → Cloudinary)
    const coverFileEl = document.getElementById('profile-cover-file');
    const coverFile = coverFileEl ? coverFileEl.files[0] : null;
    
    const btn = document.getElementById('save-profile-btn');
    btn.innerText = "Saving..."; btn.disabled = true;

    let finalPic = ''; // new upload wins; otherwise keep existing pic
    try {
        if(file) {
            const base64Img = await window.compressImage(file);
            finalPic = await window.uploadToCloudinary(base64Img, window.currentUser.uid);
        }
    } catch(e) { console.error("Compression/Upload failed", e); }
    
    // Removal requested (and no fresh upload): fall back to the generated avatar.
    if (!file && window._profilePicRemoved) finalPic = window.generateAvatar(window.currentUser.uid);
    if(!finalPic) finalPic = cache.pic || window.currentUser.photoURL || window.generateAvatar(window.currentUser.uid);

    let finalCover = ''; // new upload wins; otherwise keep existing cover
    try {
        if(coverFile) {
            const coverB64 = await window.compressImage(coverFile);
            finalCover = await window.uploadToCloudinary(coverB64, window.currentUser.uid);
        }
    } catch(e) { console.error("Cover upload failed", e); }
    // Removal requested (and no fresh upload): keep the cover empty.
    if (!coverFile && window._profileCoverRemoved) finalCover = '';
    if(!finalCover) finalCover = cache.cover || '';

    // Collect gallery images (up to 4 slots)
    const galleryImages = [];
    for (let i = 0; i < 4; i++) {
        const urlInput = document.querySelector(`.gallery-url-input[data-slot="${i}"]`);
        const fileInput2 = document.querySelector(`.gallery-file-input[data-slot="${i}"]`);
        const url = urlInput ? urlInput.value.trim() : '';
        if (url) galleryImages.push(url);
    }

    // Socials tab — normalize each link to a full https URL ('' = hidden)
    const socials = {};
    Object.keys(window.SOCIAL_PLATFORMS || {}).forEach((key) => {
        const el = document.getElementById('social-' + key);
        socials[key] = window.normalizeSocialUrl(key, el ? el.value : '');
    });

    // Gaming (MLBB) tab
    const mlbb = {
        ign: (document.getElementById('mlbb-ign')?.value || '').trim(),
        gameId: (document.getElementById('mlbb-id')?.value || '').trim(),
        server: (document.getElementById('mlbb-server')?.value || '').trim(),
        currentRank: document.getElementById('mlbb-current-rank')?.value || '',
        highestRank: document.getElementById('mlbb-highest-rank')?.value || '',
        primaryRole: document.getElementById('mlbb-primary-role')?.value || '',
        secondaryRole: document.getElementById('mlbb-secondary-role')?.value || '',
        heroes: [1, 2, 3].map(n => (document.getElementById(`mlbb-hero-${n}`)?.value || '').trim())
    };

    if(window.currentUser) {
        try {
            await update(ref(db, `users/${window.currentUser.uid}`), { name: finalName, pic: finalPic, cover: finalCover, gender, relationship, partner, bio, galleryImages, socials, mlbb });
            try { await updateProfile(window.currentUser, { displayName: finalName, photoURL: finalPic }); } catch (e) { }
            
            document.getElementById('profile-modal').classList.add('hidden');
            document.getElementById('nav-avatar').src = finalPic;
            window._profilePicRemoved = false;
            window._profileCoverRemoved = false;
            fileInput.value = '';
            const coverInputEl = document.getElementById('profile-cover-file');
            if (coverInputEl) coverInputEl.value = '';
        } catch(error) {
            window.showAlert("Error saving profile. Please try again.");
        }
    }
    btn.innerText = "Save Changes"; btn.disabled = false;
});

// ==========================================
// AUTHENTICATION & UI
// ==========================================
document.getElementById('theme-toggle').addEventListener('click', () => {
    const html = document.documentElement; html.classList.toggle('dark');
    localStorage.theme = html.classList.contains('dark') ? 'dark' : 'light';
});

// ==========================================
// RECRUITER PICKER (Sign-Up step of #auth-modal)
// ==========================================
// Type-to-search over every member, using the same shared users cache the
// @mention suggestions use. Selecting one stores its uid in
// window._authRecruiterUid; a successful account creation writes it to RTDB 3
// at recruits/{recruiterUid}/{newUid}. The field is OPTIONAL — with no pick
// nothing is written.
window._authRecruiterUid = null;

const _recruiterWrap = () => document.getElementById('auth-recruiter-wrap');
const _recruiterInput = () => document.getElementById('auth-recruiter');
const _recruiterList = () => document.getElementById('auth-recruiter-list');

function resetRecruiterPicker() {
    window._authRecruiterUid = null;
    const input = _recruiterInput();
    if (input) input.value = '';
    const list = _recruiterList();
    if (list) { list.innerHTML = ''; list.classList.add('hidden'); }
}

function renderRecruiterSuggestions() {
    const input = _recruiterInput();
    const list = _recruiterList();
    if (!input || !list) return;

    // Typing invalidates any previous pick so a stale uid is never submitted.
    window._authRecruiterUid = null;
    const term = input.value.trim().toLowerCase();
    if (!term) { list.innerHTML = ''; list.classList.add('hidden'); return; }

    const myUid = window.currentUser ? window.currentUser.uid : null;
    const matches = Object.entries(window.globalUsersCache || {})
        .filter(([uid, u]) => u && u.name && u.name !== 'undefined' && u.name !== 'null'
            && uid !== myUid && u.name.toLowerCase().includes(term))
        .slice(0, 8);

    const esc = window.escapeHtml || ((s) => String(s ?? ''));
    list.innerHTML = matches.length
        ? matches.map(([uid, u]) => `
            <div class="recruiter-opt p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 transition" data-uid="${uid}" data-name="${esc(u.name)}">
                <img src="${esc(u.pic || window.generateAvatar(uid))}" class="w-6 h-6 rounded-full object-cover shrink-0">
                <span class="truncate">${esc(u.name)}</span>
            </div>`).join('')
        : `<div class="p-2.5 text-xs text-gray-400 dark:text-gray-500">No member matches “${esc(input.value.trim())}”.</div>`;
    list.classList.remove('hidden');
}

_recruiterInput()?.addEventListener('input', renderRecruiterSuggestions);
_recruiterInput()?.addEventListener('blur', () => setTimeout(() => _recruiterList()?.classList.add('hidden'), 150));
// mousedown (not click) so the pick lands before the input loses focus;
// preventDefault keeps focus in the input, so the blur handler can't race us.
_recruiterList()?.addEventListener('mousedown', (ev) => {
    const opt = ev.target.closest('.recruiter-opt');
    if (!opt) return;
    ev.preventDefault();
    window._authRecruiterUid = opt.dataset.uid;
    const input = _recruiterInput();
    if (input) input.value = opt.dataset.name || '';
    _recruiterList().classList.add('hidden');
});

// ── Recruit validity (anti-abuse) ─────────────────────────────────────────
// Same public IP echo endpoints captureUserIP() uses (js/helpers.js).
async function getPublicIp() {
    if (window._publicIP) return window._publicIP;
    for (const url of ['https://api.ipify.org?format=json', 'https://api64.ipify.org?format=json']) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            const res = await fetch(url, { mode: 'cors', signal: ctrl.signal });
            clearTimeout(timer);
            const data = await res.json();
            if (data && data.ip) { window._publicIP = data.ip; return data.ip; }
        } catch (e) { /* try the next endpoint */ }
    }
    return null;
}

// One-way, salted digest of an IP: equality-comparable, not readable back, and
// never written anywhere in raw form. Falls back to FNV-1a when WebCrypto is
// unavailable (non-secure context) — the two formats can never collide because
// the fallback is prefixed.
async function ipFingerprint(ip) {
    const salted = 'hangout-recruit-v1:' + String(ip);
    try {
        if (window.crypto && window.crypto.subtle) {
            const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(salted));
            return Array.from(new Uint8Array(buf)).slice(0, 16)
                .map(b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) { /* fall through */ }
    let h = 0x811c9dc5;
    for (let i = 0; i < salted.length; i++) { h ^= salted.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'fnv_' + h.toString(16).padStart(8, '0');
}

// Writes the recruit record. Called ONLY from the two account-creation paths.
async function saveRecruitFor(newUid, name, pic) {
    const recruiterUid = window._authRecruiterUid;
    if (!recruiterUid || !newUid || recruiterUid === newUid) return;

    // Fingerprint the recruit's own IP (never the raw value). A failed lookup
    // leaves fpr empty -> the recruit stays PENDING and is re-checked later.
    let fpr = '';
    try {
        const ip = await getPublicIp();
        if (ip) fpr = await ipFingerprint(ip);
    } catch (e) { /* pending */ }

    try {
        await set(ref(db3, `recruits/${recruiterUid}/${newUid}`), {
            uid: newUid,
            recruiter: recruiterUid,
            name: String(name || 'New member').slice(0, 60),
            pic: String(pic || '').slice(0, 500),
            joinedAt: Date.now(),
            fpr
        });
        // Reverse pointer, written ONLY while pending: it lets this recruit's own
        // client backfill the fingerprint on a later login (see below), because
        // nobody else is allowed to read its /user_ips.
        if (!fpr) await set(ref(db3, `recruit_refs/${newUid}`), { recruiter: recruiterUid });
    } catch (e) {
        console.warn('Recruit write failed:', e);
    }
}

// Runs after captureUserIP() on login: fills in a missing fingerprint for a
// PENDING recruit, then drops the reverse pointer. The Recruits modal decides
// the verdict the next time the recruiter opens it.
async function backfillRecruitFingerprint(uid) {
    if (!uid) return;
    try {
        const refSnap = await get(ref(db3, `recruit_refs/${uid}`));
        if (!refSnap.exists()) return;
        const recruiterUid = (refSnap.val() || {}).recruiter;
        if (!recruiterUid) return;

        const path = `recruits/${recruiterUid}/${uid}`;
        const recSnap = await get(ref(db3, path));
        const rec = (recSnap.exists() && recSnap.val()) || {};
        if (rec.fpr) { await remove(ref(db3, `recruit_refs/${uid}`)); return; }

        const ip = window._publicIP || await getPublicIp();
        if (!ip) return; // still pending
        await update(ref(db3, path), { fpr: await ipFingerprint(ip) });
        await remove(ref(db3, `recruit_refs/${uid}`));
    } catch (e) {
        console.warn('Recruit fingerprint backfill failed:', e);
    }
}

document.getElementById('open-login-btn').addEventListener('click', () => {
    document.getElementById('auth-modal').classList.remove('hidden');
    resetRecruiterPicker();
});

document.getElementById('auth-toggle-btn').addEventListener('click', () => {
    window.isSignUpMode = !window.isSignUpMode;
    document.getElementById('auth-action-btn').innerText = window.isSignUpMode ? "Create Account" : "Sign In";
    document.getElementById('auth-toggle-text').innerText = window.isSignUpMode ? "Already have an account?" : "Need an account?";
    document.getElementById('auth-toggle-btn').innerText = window.isSignUpMode ? "Sign In" : "Sign Up";
    
    if(window.isSignUpMode) document.getElementById('forgot-pass-btn').classList.add('hidden');
    else document.getElementById('forgot-pass-btn').classList.remove('hidden');

    // Recruiter field only makes sense while creating an account.
    const wrap = _recruiterWrap();
    if (wrap) {
        wrap.classList.toggle('hidden', !window.isSignUpMode);
        if (!window.isSignUpMode) resetRecruiterPicker();
    }
});

const showError = (msg) => { const errEl = document.getElementById('auth-error'); errEl.innerText = msg; errEl.classList.remove('hidden'); }

document.getElementById('forgot-pass-btn').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    if(!email) return showError("Please enter your email address above first.");
    try {
        await sendPasswordResetEmail(auth, email);
        window.showAlert("Password reset email sent! Please check your inbox.");
    } catch (error) { showError(error.message.replace('Firebase:', '')); }
});

// Bound to the <form> submit (not a button click) so Enter works in either field
// AND browsers' password managers recognise the sign-in/sign-up credentials —
// a password <input> outside a <form> triggers "[DOM] Password field is not
// contained in a form" and is ignored by autofill.
document.getElementById('email-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('auth-email').value;
    const pass = document.getElementById('auth-password').value;
    const btn = document.getElementById('auth-action-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Please wait...`;
    btn.disabled = true;
    try {
        if (window.isSignUpMode) {
            const cred = await createUserWithEmailAndPassword(auth, email, pass);
            const newName = `User_${Math.floor(Math.random()*999)}`;
            const newPic = window.generateAvatar(cred.user.uid);
            await updateProfile(cred.user, { displayName: newName, photoURL: newPic });
            
            await update(ref(db, `users/${cred.user.uid}`), { name: newName, pic: newPic }).catch(e => console.warn('Profile write failed:', e));
            // Recruit system: record who referred this new account (RTDB 3).
            await saveRecruitFor(cred.user.uid, newName, newPic);
            document.getElementById('nav-avatar').src = newPic;
            window.showAlert("Account created successfully!");
        } else {
            await signInWithEmailAndPassword(auth, email, pass);
            window.showAlert("Signed in successfully!");
        }
        document.getElementById('auth-modal').classList.add('hidden');
        resetRecruiterPicker();
    } catch (error) { 
        showError(error.message.replace('Firebase:', '')); 
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

// Google Sign-In
document.getElementById('google-login-btn').addEventListener('click', async () => {
    const btn = document.getElementById('google-login-btn');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<svg class="animate-spin -ml-1 h-4 w-4 inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Connecting...`;
    try {
        const provider = new GoogleAuthProvider();
        const result = await signInWithPopup(auth, provider);
        // First-time Google users get a profile created from their Google account.
        // Existing users keep their current name/pic (no overwrite).
        const userSnap = await get(ref(db, `users/${result.user.uid}`));
        if (!userSnap.exists()) {
            const newName = result.user.displayName || `User_${Math.floor(Math.random()*999)}`;
            const newPic = result.user.photoURL || window.generateAvatar(result.user.uid);
            await updateProfile(result.user, { displayName: newName, photoURL: newPic });
            await update(ref(db, `users/${result.user.uid}`), { name: newName, pic: newPic });
            // Recruit system: only BRAND NEW Google accounts are recruits (RTDB 3).
            await saveRecruitFor(result.user.uid, newName, newPic);
            document.getElementById('nav-avatar').src = newPic;
        }
        document.getElementById('auth-modal').classList.add('hidden');
        resetRecruiterPicker();
        window.showAlert("Signed in with Google!");
    } catch (error) {
        if (error.code === 'auth/account-exists-with-different-credential') showError("This email already has an account with a password. Please sign in using your email and password.");
        else if (error.code === 'auth/popup-closed-by-user') showError("Google sign-in was closed before finishing.");
        else if (error.code === 'auth/unauthorized-domain') showError("This domain is not authorized for Google sign-in.");
        else showError(error.message.replace('Firebase:', ''));
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

document.getElementById('guest-login-btn').addEventListener('click', async () => {
    const guestEmail = `guest_${window.deviceId}@hangout.local`, guestPass = window.deviceId + "_secret";
    const btn = document.getElementById('guest-login-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-gray-700 dark:text-white inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Please wait...`;
    btn.disabled = true;
    try { 
        await signInWithEmailAndPassword(auth, guestEmail, guestPass); 
        document.getElementById('auth-modal').classList.add('hidden'); 
        window.showAlert("Signed in as Guest!");
    } 
    catch {
        try {
            const cred = await createUserWithEmailAndPassword(auth, guestEmail, guestPass);
            const newName = `Guest_${Math.floor(Math.random()*999)}`;
            const newPic = window.generateAvatar(cred.user.uid);
            await updateProfile(cred.user, { displayName: newName, photoURL: newPic });
            
            await update(ref(db, `users/${cred.user.uid}`), { name: newName, pic: newPic, isGuest: true }).catch(e => console.warn('Profile write failed:', e));
            document.getElementById('nav-avatar').src = newPic;
            document.getElementById('auth-modal').classList.add('hidden');
            window.showAlert("Guest account created!");
        } catch(e) { showError("Failed to create guest account."); }
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

// Logout: used by the nav avatar menu (window.userMenuLogout) — the old
// #logout-btn inside the edit-profile modal was removed in favor of the menu.
window.logoutUser = async () => {
    try { await stopOwnPresence(window.currentUser); } catch(e) {}
    try { await window.logActivity("logged out"); } catch(e) {}
    // Clear session flags so the NEXT login in this tab is logged again as a fresh
    // login (and its IP is re-captured). Refresh keeps them, so a reload stays quiet.
    sessionStorage.removeItem('session_started');
    if (window._notifPruneTimer) { clearTimeout(window._notifPruneTimer); window._notifPruneTimer = null; }
    // Close any open dialogs/views so a fresh login starts clean
    const pm = document.getElementById('profile-modal'); if (pm) pm.classList.add('hidden');
    window.closeUserMenu && window.closeUserMenu();
    if (window.activeProfileUid && window.closeProfile) window.closeProfile();
    await signOut(auth); 
    window.showAlert("Logged out successfully!");
};

onAuthStateChanged(auth, (user) => {
    window.currentUser = user;
    // Deep link from the Arena Lobbies tab: ../?compose=lobby opens the
    // Create Lobby (LFG) composer — or the auth prompt when signed out.
    if (new URLSearchParams(location.search).get('compose') === 'lobby') {
        setTimeout(() => {
            try {
                history.replaceState(null, '', location.pathname);
                window.openCreateLobby();
            } catch (_) {}
        }, 600);
    }
    if (user) {
        if (!sessionStorage.getItem('session_started')) {
            sessionStorage.setItem('session_started', 'true');
            // Give time for globalUsersCache to populate
            setTimeout(() => window.logActivity("logged in"), 1000);
        }
        // Profile self-heal: guarantee a usable name/pic always exists for this account.
        // Fixes the historical "undefined"-name bug where this login write created a bare
        // {lastSeen} record before/without the signup profile write landing (race condition).
        // Never overwrites existing values — only fills what's missing.
        get(ref(db, `users/${user.uid}`)).then((snap) => {
            const p = snap.val() || {};
            // Mirror the authoritative DB record (incl. isMod/isAdmin role flags)
            // into the local user cache so role-gated UI updates instantly.
            window.globalUsersCache[user.uid] = p;
            if (window.writeUsersCache) window.writeUsersCache(window.globalUsersCache);
            window._updateNavUserUI && window._updateNavUserUI();
            const patch = { lastSeen: serverTimestamp() };
            const prefix = user.isAnonymous ? 'Guest_' : 'User_';
            const hasName = p.name && p.name !== 'undefined' && p.name !== 'null';
            const hasPic = p.pic && p.pic !== 'undefined' && p.pic !== 'null';
            if (!hasName) patch.name = (user.displayName && user.displayName !== 'undefined') ? user.displayName : `${prefix}${Math.floor(Math.random() * 999)}`;
            if (!hasPic) patch.pic = user.photoURL || window.generateAvatar(user.uid);
            return update(ref(db, `users/${user.uid}`), patch);
        }).catch(e => console.warn('Profile self-heal failed:', e));
        
        startOwnPresence(user);

        // Deep link from the Arena profile guard: ../?edit=gaming opens
        // Edit Profile straight on the Gaming tab. Runs after the cache is
        // warm so the form is prefilled with the saved MLBB fields.
        if (new URLSearchParams(location.search).get('edit') === 'gaming') {
            setTimeout(() => {
                try {
                    history.replaceState(null, '', location.pathname);
                    window.openEditProfile();
                    window.switchEditTab('gaming');
                } catch (_) {}
            }, 600);
        }
        
        // Live own-record mirror — always (re)start it now that the session is up.
        window.startOwnUserListener && window.startOwnUserListener(user.uid);
        
        // Anti-abuse: keep this account's public IP fresh on every login/load.
        // captureUserIP() only writes when the IP actually changed, and it retries
        // on later logins, so even if the /user_ips rules deploy late it self-heals.
        // Once it settles, use it to backfill a PENDING recruit's fingerprint.
        if (window.captureUserIP) {
            window.captureUserIP(user.uid).finally(() => backfillRecruitFingerprint(user.uid));
        } else {
            backfillRecruitFingerprint(user.uid);
        }

        // Same-IP LB shield: load the admin-mirrored flagged groups (uids only) so
        // game awards can zero LB for host+winner same-IP pairs.
        window.refreshFlaggedGroups && window.refreshFlaggedGroups();
        
        document.getElementById('open-login-btn').classList.add('hidden');
        document.getElementById('user-info').classList.remove('hidden');
        
        window.updateAdminButtons && window.updateAdminButtons();
        
        // Composer stays hidden — the + button opens it (pick Post/Photo/Reels/Voice)
        window.closeCreateMenu && window.closeCreateMenu();
        
        if (window.globalUsersCache[user.uid]?.pic || user.photoURL) {
            document.getElementById('nav-avatar').src = window.globalUsersCache[user.uid]?.pic || user.photoURL;
        }

        window.updateNotifBadge();

        // One-time move of this account's notification history off RTDB 1
        // (fire-and-forget; the listener below picks up the copied data).
        if (window._migrateNotifications) window._migrateNotifications(user.uid);

        // Start the dedicated notifications listener for this user
        if (window._startNotifListener) window._startNotifListener(user.uid);

        // Auto-cleanup: keep only the latest 50 notifications in the database.
        // Runs at most once every 24h per user to avoid downloading all notifications on every visit.
        window._notifPruneTimer = setTimeout(() => {
            if (!auth.currentUser || auth.currentUser.uid !== user.uid) return; // user signed out meanwhile
            const pruneKey = `hangout_notif_prune_${user.uid}`;
            const lastPrune = Number(localStorage.getItem(pruneKey) || 0);
            if (Date.now() - lastPrune < 24 * 60 * 60 * 1000) return;
            get(ref(db2, `notifications/${user.uid}`)).then(snap => {
                localStorage.setItem(pruneKey, Date.now());
                const allNotifs = snap.val();
                if (allNotifs) {
                    const keys = Object.keys(allNotifs);
                    if (keys.length > 50) {
                        // Sort by timestamp (oldest first)
                        keys.sort((a, b) => (allNotifs[a].timestamp || 0) - (allNotifs[b].timestamp || 0));
                        const keysToDelete = keys.slice(0, keys.length - 50);
                        const updates = {};
                        keysToDelete.forEach(k => updates[k] = null);
                        update(ref(db2, `notifications/${user.uid}`), updates).catch(e => console.warn("Failed to prune notifications", e));
                    }
                }
            }).catch(e => console.warn("Failed to fetch notifications for pruning", e));
        }, 15000);

        if (window.chatInboxUnsubscribe) window.chatInboxUnsubscribe();
        window.chatInboxUnsubscribe = onValue(ref(db, `chatInboxes/${user.uid}`), (snap) => {
            const inbox = snap.val() || {};
            let unreadCount = 0;
            Object.values(inbox).forEach(item => {
                if (item.unreadCount > 0) unreadCount++;
            });
            const badge = document.getElementById('chat-unread-badge');
            if (badge) {
                if (unreadCount > 0) {
                    badge.innerText = unreadCount > 9 ? '9+' : unreadCount;
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        });
    } else {
        document.getElementById('open-login-btn').classList.remove('hidden');
        document.getElementById('user-info').classList.add('hidden');
        document.getElementById('create-post-box').classList.add('hidden');
        window.updateAdminButtons && window.updateAdminButtons();
        if (window.chatInboxUnsubscribe) { window.chatInboxUnsubscribe(); window.chatInboxUnsubscribe = null; }
        if (window._notifUnsubscribe) { window._notifUnsubscribe(); window._notifUnsubscribe = null; }
        window.myNotifications = {};
    }
    if(!window.activeProfileUid) window.renderFeed(false);
});

// ==========================================
// PWA INSTALLATION LOGIC
// ==========================================
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

// PWA install: used by the nav avatar menu (window.userMenuInstall) — the old
// #install-pwa-btn inside the edit-profile modal was removed in favor of the menu.
window.installHangout = async () => {
    try { window.requestNotificationPermission(); } catch(e) {}
    
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') console.log('User accepted the install prompt');
        deferredPrompt = null;
    } else {
        const msg = "To install Hangout, tap your browser's menu (the 3 dots) and select 'Install app' or 'Add to Home screen'.";
        if (window.showAlert) window.showAlert(msg);
        else alert(msg);
    }
};
