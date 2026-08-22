// main.js
import { app, auth, db, fsdb, fsdb2, getPostDocRef, getFirestoreForPost, getRoundRobinFsdb, getFirestoreBySource } from "./firebase-config.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, push, onValue, get, set, update, remove, increment, onDisconnect, serverTimestamp, query as dbQuery, limitToLast, onChildAdded, onChildChanged, onChildRemoved } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, doc, addDoc, getDoc, getDocs, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, where, serverTimestamp as fsServerTimestamp, startAfter, deleteField } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
window._getDocsFS = getDocs; // expose for loadMorePosts cursor pagination

import "./helpers.js";
import "./renderers.js";

let presenceInterval = null;
let serverTimeOffset = 0;

// Track our own session start time locally — avoids a get() RTDB download every heartbeat
const presenceSessionStart = Date.now();

onValue(ref(db, '.info/serverTimeOffset'), snap => {
    serverTimeOffset = snap.val() || 0;
});

const presenceSessionId = `posts_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
const presenceSessionRef = (uid) => ref(db, `presence/${uid}/${presenceSessionId}`);

function startOwnPresence(user = auth.currentUser) {
    if (!user) return;
    const sessionRef = presenceSessionRef(user.uid);
    onDisconnect(sessionRef).remove();
    
    set(sessionRef, serverTimestamp());
    
    if (presenceInterval) clearInterval(presenceInterval);
    
    presenceInterval = setInterval(async () => {
        try {
            // Just write our own heartbeat — no get() download needed
            await set(sessionRef, serverTimestamp());
        } catch(e) {}
    }, 60000);
}

function stopOwnPresence(user = auth.currentUser) {
    if (presenceInterval) {
        clearInterval(presenceInterval);
        presenceInterval = null;
    }
    if (user) {
        const sessionRef = presenceSessionRef(user.uid);
        onDisconnect(sessionRef).cancel();
        return remove(sessionRef);
    }
    return Promise.resolve();
}

// ==========================================
// SEARCH & FILTERS
// ==========================================
document.getElementById('post-search').addEventListener('input', window.debounce(() => window.renderFeed(true), 300));
document.getElementById('member-search').addEventListener('input', window.debounce(() => window.renderMembers(true), 300));

document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        window.clearIsolatedPost();
        document.querySelectorAll('.filter-btn').forEach(b => { b.classList.remove('bg-blue-600', 'text-white'); b.classList.add('bg-gray-200', 'text-gray-700', 'dark:bg-slate-800', 'dark:text-gray-300'); });
        e.target.classList.add('bg-blue-600', 'text-white'); e.target.classList.remove('bg-gray-200', 'text-gray-700', 'dark:bg-slate-800', 'dark:text-gray-300');
        window.currentFilter = e.target.getAttribute('data-cat');
        window.postLimit = 15;
        window.hasMorePosts = true;
        window.listenPosts();
    });
});

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
                push(ref(db, `notifications/${uid}`), {
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
                push(ref(db, `notifications/${uid}`), {
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
                push(ref(db, `notifications/${targetUser.uid}`), {
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
    if (snap.exists()) {
        window.siteSettings = { ...window.siteSettings, ...snap.val() };
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

onChildAdded(ref(db, 'presence'), (snap) => {
    window.onlineUsers[snap.key] = snap.val();
    const count = Object.keys(window.onlineUsers).length;
    const countEl = document.getElementById('online-count');
    if (countEl) countEl.innerText = count;
    if (!document.getElementById('members-modal')?.classList.contains('hidden')) window.renderMembers(false);
    if (window.activeProfileUid) window.renderProfileData(false);
});

onChildChanged(ref(db, 'presence'), (snap) => {
    // Only update memory cache, do not trigger DOM reflow on every 60s heartbeat
    window.onlineUsers[snap.key] = snap.val();
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

// Granular Users Loading: 1 initial get() + granular child event updates
// This prevents downloading the full ~100KB users database on every like/point update.
get(ref(db, 'users')).then((snap) => {
    window.globalUsersCache = snap.val() || {};
    const wasReady = window.usersReady;
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

    // Granular updates: Only downloads the single modified user record (~200 bytes) on updates
    const usersRef = ref(db, 'users');
    onChildChanged(usersRef, (childSnap) => {
        const uid = childSnap.key;
        window.globalUsersCache[uid] = childSnap.val();
        if (window.activeProfileUid === uid) window.renderProfileData(false);
        if (!document.getElementById('members-modal').classList.contains('hidden')) window.renderMembers(false);
        if (window.currentUser && window.currentUser.uid === uid) window._updateNavUserUI();
    });

    onChildAdded(usersRef, (childSnap) => {
        const uid = childSnap.key;
        if (!window.globalUsersCache[uid]) {
            window.globalUsersCache[uid] = childSnap.val();
            if (!document.getElementById('members-modal').classList.contains('hidden')) window.renderMembers(false);
        }
    });

    onChildRemoved(usersRef, (childSnap) => {
        delete window.globalUsersCache[childSnap.key];
        if (!document.getElementById('members-modal').classList.contains('hidden')) window.renderMembers(false);
    });
});

// Dedicated notifications listener — only for the logged-in user, limited to last 50.
// Kept separate from /users so that notification changes don't re-download all user profiles.
window._notifUnsubscribe = null;
window._startNotifListener = (uid) => {
    if (window._notifUnsubscribe) window._notifUnsubscribe();
    const notifQuery = dbQuery(ref(db, `notifications/${uid}`), limitToLast(50));
    window._notifUnsubscribe = onValue(notifQuery, (snap) => {
        window.myNotifications = snap.val() || {};
        window.updateNotifBadge();

        // Local push notification check
        let maxTime = window.lastNotifTime || Date.now();
        Object.values(window.myNotifications).forEach(n => {
            if (!n.read && n.timestamp > (window.lastNotifTime || Date.now())) {
                if ("Notification" in window && Notification.permission === "granted") {
                    const sourceUser = window.globalUsersCache[n.sourceUid];
                    const msg = n.type === 'mention' ? `${sourceUser?.name || 'Someone'} mentioned you!` :
                                n.type === 'comment' ? `${sourceUser?.name || 'Someone'} commented on your post!` :
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

window.allPosts = [];
window.globalPinnedPosts = [];
window.profilePinnedPosts = [];
window.isLoadingHistory = false;
window.hasMorePosts = true;
window.postLimit = 15;
window.postsUnsubscribe = null;
window.usersReady = false;   // Gate: don't render posts until users cache is loaded
window._pendingPostRender = false; // Was a render requested before users were ready?
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
                // If not found in primary and not yet checked secondary, fallback check
                if (snap.ref.firestore === fsdb) {
                    const postRef2 = doc(fsdb2, 'community_posts', id);
                    onSnapshot(postRef2, (snap2) => {
                        if (!snap2.exists()) return;
                        const post2 = { id: snap2.id, ...snap2.data(), _dbSource: 2 };
                        window._postDbMap.set(id, 2);
                        window._updatePinnedPostInState(post2, pinType);
                    });
                }
                return;
            }
            const dbSource = snap.ref.firestore === fsdb2 ? 2 : 1;
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
    if (typeof window.postsUnsubscribe === 'function') { window.postsUnsubscribe(); window.postsUnsubscribe = null; }

    window._lastPostDoc1 = null;
    window._lastPostDoc2 = null;
    window._liveLastDoc1 = null;
    window._liveLastDoc2 = null;
    window._historyPosts1 = [];
    window._historyPosts2 = [];
    window._historyPosts = [];

    let livePosts1 = [];
    let livePosts2 = [];
    let initialSnap1 = false;
    let initialSnap2 = false;
    let initialGraceElapsed = false;
    setTimeout(() => {
        initialGraceElapsed = true;
        mergeAndRender();
    }, 400);

    const safeMergeAndRender = () => {
        if ((initialSnap1 && initialSnap2) || initialGraceElapsed) {
            mergeAndRender();
        }
    };

    const mergeAndRender = () => {
        const rawDocs = {};
        [...livePosts1, ...livePosts2].forEach(p => { if (p && p.id) rawDocs[p.id] = p; });
        if (window.checkGameTimers) window.checkGameTimers(rawDocs);

        const allLive = [...livePosts1, ...livePosts2];
        allLive.sort((a, b) => {
            const tA = (a.timestamp && a.timestamp.toMillis) ? a.timestamp.toMillis() : (typeof a.timestamp === 'number' ? a.timestamp : 0);
            const tB = (b.timestamp && b.timestamp.toMillis) ? b.timestamp.toMillis() : (typeof b.timestamp === 'number' ? b.timestamp : 0);
            return tB - tA;
        });

        const allHistory = [...(window._historyPosts1 || []), ...(window._historyPosts2 || [])];
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
        window.handleDeepLinks();
        window.isLoadingHistory = false;
    };

    const q1 = query(window._buildBaseQueryForDb(fsdb), limit(15));
    const q2 = query(window._buildBaseQueryForDb(fsdb2), limit(15));

    window.postsUnsubscribe1 = onSnapshot(q1, { includeMetadataChanges: false }, (snapshot) => {
        livePosts1 = [];
        snapshot.forEach(child => {
            const p = { id: child.id, ...child.data(), _dbSource: 1 };
            window._postDbMap.set(child.id, 1);
            livePosts1.push(p);
        });
        if (snapshot.docs.length > 0) {
            window._liveLastDoc1 = snapshot.docs[snapshot.docs.length - 1];
        }
        window.hasMorePosts1 = (snapshot.size >= 15);
        window.hasMorePosts = window.hasMorePosts1 || window.hasMorePosts2;
        initialSnap1 = true;
        safeMergeAndRender();
    }, (err) => {
        console.warn("FS1 snapshot warning:", err);
        initialSnap1 = true;
        safeMergeAndRender();
    });

    window.postsUnsubscribe2 = onSnapshot(q2, { includeMetadataChanges: false }, (snapshot) => {
        livePosts2 = [];
        snapshot.forEach(child => {
            const p = { id: child.id, ...child.data(), _dbSource: 2 };
            window._postDbMap.set(child.id, 2);
            livePosts2.push(p);
        });
        if (snapshot.docs.length > 0) {
            window._liveLastDoc2 = snapshot.docs[snapshot.docs.length - 1];
        }
        window.hasMorePosts2 = (snapshot.size >= 15);
        window.hasMorePosts = window.hasMorePosts1 || window.hasMorePosts2;
        initialSnap2 = true;
        safeMergeAndRender();
    }, (err) => {
        console.warn("FS2 snapshot warning:", err);
        initialSnap2 = true;
        safeMergeAndRender();
    });

    window.postsUnsubscribe = () => {
        if (window.postsUnsubscribe1) window.postsUnsubscribe1();
        if (window.postsUnsubscribe2) window.postsUnsubscribe2();
    };
};

// loadMorePosts: fetches the next page of older posts from both Firestore instances using cursor pagination
window.loadMorePosts = async () => {
    if (window.isLoadingHistory || !window.hasMorePosts) return;
    window.isLoadingHistory = true;

    try {
        const cursor1 = window._lastPostDoc1 || window._liveLastDoc1;
        if (window.hasMorePosts1 !== false && cursor1) {
            try {
                const pageQuery1 = query(window._buildBaseQueryForDb(fsdb), startAfter(cursor1), limit(15));
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
                window.hasMorePosts1 = (pageSnap1.size >= 15);
            } catch (e) {
                console.warn("Error fetching page from fsdb 1:", e);
                window.hasMorePosts1 = false;
            }
        }

        const cursor2 = window._lastPostDoc2 || window._liveLastDoc2;
        if (window.hasMorePosts2 !== false && cursor2) {
            try {
                const pageQuery2 = query(window._buildBaseQueryForDb(fsdb2), startAfter(cursor2), limit(15));
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
                window.hasMorePosts2 = (pageSnap2.size >= 15);
            } catch (e) {
                console.warn("Error fetching page from fsdb 2:", e);
                window.hasMorePosts2 = false;
            }
        }

        window.hasMorePosts = (window.hasMorePosts1 || window.hasMorePosts2);

        const allHistory = [...(window._historyPosts1 || []), ...(window._historyPosts2 || [])];
        allHistory.sort((a, b) => {
            const tA = (a.timestamp && a.timestamp.toMillis) ? a.timestamp.toMillis() : (typeof a.timestamp === 'number' ? a.timestamp : 0);
            const tB = (b.timestamp && b.timestamp.toMillis) ? b.timestamp.toMillis() : (typeof b.timestamp === 'number' ? b.timestamp : 0);
            return tB - tA;
        });
        window._historyPosts = allHistory;

        const historyIds = new Set(allHistory.map(p => p.id));
        const livePosts = (window.allPosts || []).filter(p => !historyIds.has(p.id));
        window.allPosts = [...livePosts, ...allHistory];

        window.feedRenderLimit = window.allPosts.length;
        window.profileRenderLimit = window.allPosts.length;

        if (window.activeProfileUid) window.renderProfileData(false);
        else window.renderFeed(false);
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
    // Collage mode: photos only, max 4. Videos must be posted individually.
    if (files.some(f => f.type.startsWith('video/'))) {
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

document.getElementById('submit-post-btn').addEventListener('click', async () => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return; 
    // Site Control: block when posts are paused (admins bypass)
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
    
    const text = document.getElementById('post-text').value.trim();
    const fileInput = document.getElementById('post-image-file');
    const files = Array.from(fileInput.files || []).slice(0, 4);
    let imgUrl = document.getElementById('post-image-url').value.trim();
    
    if (!text && !imgUrl && !files.length) return;
    
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
        let finalImage = imgUrl; 
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

        const { fsdb: targetFs, dbSource } = getRoundRobinFsdb();
        const postData = {
            authorId: window.currentUser.uid, text: text, image: finalImage,
            category: document.getElementById('post-category').value,
            timestamp: Date.now(), pinned: false, edited: false, locked: false, reactions: {},
            visibility: window.postVisibility || 'public',
            _dbSource: dbSource
        };
        if (collageImages.length > 1) postData.images = collageImages;
        const newPostRef = await addDoc(collection(targetFs, 'community_posts'), postData);
        window._postDbMap.set(newPostRef.id, dbSource);
        
        const pointsToAdd = window.siteSettings.starsPerPost ?? 10;
        update(ref(db, `users/${window.currentUser.uid}`), { points: increment(pointsToAdd) });
        window.notifyMentions(text, newPostRef.id);
        window.logActivity("posted a new update");
        
        document.getElementById('post-text').value = '';
        document.getElementById('post-image-url').value = '';
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
        
    } catch (err) { window.showAlert("Failed to post: " + err.message); }
    
    btn.innerText = "Post"; btn.disabled = false;
});

window.submitComment = async (postId, postAuthorId, prefix) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
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
    
    if(window.currentUser.uid !== postAuthorId && postAuthorId !== "undefined") {
        update(ref(db, `users/${postAuthorId}`), { points: increment(pointsToAdd) });
        push(ref(db, `notifications/${postAuthorId}`), { 
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
        push(ref(db, `notifications/${commentAuthorId}`), { 
            type: 'reply', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
        });
    }

    window.notifyMentions(text, postId);
    window.openRepliesList.add(commentId);
    input.focus();
};

window.react = (postId, postAuthorId, type) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    if (window.checkSitePaused && window.checkSitePaused('post')) return;
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
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") {
        const likePoints = window.siteSettings.starsPerLike ?? 1;
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") {
            update(ref(db, `users/${postAuthorId}`), { points: increment(likePoints) });
        }
            push(ref(db, `notifications/${postAuthorId}`), { 
                type: 'react_post', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
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
            push(ref(db, `notifications/${commentAuthorId}`), { 
                type: 'react_comment', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
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
            push(ref(db, `notifications/${replyAuthorId}`), { 
                type: 'react_reply', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
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
                updateDoc(postDocRef, { text: newText, edited: true });
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

document.getElementById('view-profile-btn').addEventListener('click', () => {
    if(window.currentUser) {
        document.getElementById('profile-modal').classList.add('hidden');
        window.openProfile(window.currentUser.uid);
    }
});

document.getElementById('save-profile-btn').addEventListener('click', async () => {
    const newNameInput = document.getElementById('profile-name').value.trim();
    const cache = window.globalUsersCache[window.currentUser.uid] || {};
    const finalName = newNameInput || cache.name || window.currentUser.displayName || `User_${Math.floor(Math.random()*999)}`;
    
    const gender = document.getElementById('profile-gender').value;
    const relationship = document.getElementById('profile-relationship').value;
    let partner = document.getElementById('profile-partner').value.trim();
    const bio = document.getElementById('profile-bio').value.trim();
    if(!['In a relationship', 'Engaged', 'Married', 'Complicated'].includes(relationship)) partner = '';

    let newPicUrl = document.getElementById('profile-pic-url').value.trim();
    const fileInput = document.getElementById('profile-pic-file');
    const file = fileInput.files[0];
    
    const btn = document.getElementById('save-profile-btn');
    btn.innerText = "Saving..."; btn.disabled = true;

    let finalPic = newPicUrl;
    try {
        if(file) {
            const base64Img = await window.compressImage(file);
            finalPic = await window.uploadToCloudinary(base64Img, window.currentUser.uid);
        }
    } catch(e) { console.error("Compression/Upload failed", e); }
    
    if(!finalPic) finalPic = cache.pic || window.currentUser.photoURL || window.generateAvatar(window.currentUser.uid);

    // Collect gallery images (up to 4 slots)
    const galleryImages = [];
    for (let i = 0; i < 4; i++) {
        const urlInput = document.querySelector(`.gallery-url-input[data-slot="${i}"]`);
        const fileInput2 = document.querySelector(`.gallery-file-input[data-slot="${i}"]`);
        const url = urlInput ? urlInput.value.trim() : '';
        if (url) galleryImages.push(url);
    }

    if(window.currentUser) {
        try {
            await update(ref(db, `users/${window.currentUser.uid}`), { name: finalName, pic: finalPic, gender, relationship, partner, bio, galleryImages });
            try { await updateProfile(window.currentUser, { displayName: finalName, photoURL: finalPic }); } catch (e) { }
            
            document.getElementById('profile-modal').classList.add('hidden');
            document.getElementById('nav-avatar').src = finalPic;
            fileInput.value = '';
            document.getElementById('profile-pic-url').value = '';
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

document.getElementById('open-login-btn').addEventListener('click', () => document.getElementById('auth-modal').classList.remove('hidden'));

document.getElementById('auth-toggle-btn').addEventListener('click', () => {
    window.isSignUpMode = !window.isSignUpMode;
    document.getElementById('auth-action-btn').innerText = window.isSignUpMode ? "Create Account" : "Sign In";
    document.getElementById('auth-toggle-text').innerText = window.isSignUpMode ? "Already have an account?" : "Need an account?";
    document.getElementById('auth-toggle-btn').innerText = window.isSignUpMode ? "Sign In" : "Sign Up";
    
    if(window.isSignUpMode) document.getElementById('forgot-pass-btn').classList.add('hidden');
    else document.getElementById('forgot-pass-btn').classList.remove('hidden');
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

document.getElementById('auth-action-btn').addEventListener('click', async () => {
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
            
            update(ref(db, `users/${cred.user.uid}`), { name: newName, pic: newPic });
            document.getElementById('nav-avatar').src = newPic;
            window.showAlert("Account created successfully!");
        } else {
            await signInWithEmailAndPassword(auth, email, pass);
            window.showAlert("Signed in successfully!");
        }
        document.getElementById('auth-modal').classList.add('hidden');
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
            document.getElementById('nav-avatar').src = newPic;
        }
        document.getElementById('auth-modal').classList.add('hidden');
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
            
            update(ref(db, `users/${cred.user.uid}`), { name: newName, pic: newPic, isGuest: true });
            document.getElementById('nav-avatar').src = newPic;
            document.getElementById('auth-modal').classList.add('hidden');
            window.showAlert("Guest account created!");
        } catch(e) { showError("Failed to create guest account."); }
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

document.getElementById('logout-btn').addEventListener('click', async () => { 
    try { await stopOwnPresence(window.currentUser); } catch(e) {}
    window.logActivity("logged out");
    await signOut(auth); 
    window.showAlert("Logged out successfully!");
});

onAuthStateChanged(auth, (user) => {
    window.currentUser = user;
    if (user) {
        if (!sessionStorage.getItem('session_started')) {
            sessionStorage.setItem('session_started', 'true');
            // Give time for globalUsersCache to populate
            setTimeout(() => window.logActivity("logged in"), 1000);
        }
        update(ref(db, `users/${user.uid}`), { lastSeen: serverTimestamp() });
        
        startOwnPresence(user);
        
        document.getElementById('open-login-btn').classList.add('hidden');
        document.getElementById('user-info').classList.remove('hidden');
        
        window.updateAdminButtons && window.updateAdminButtons();
        
        if(!window.globalUsersCache[user.uid]?.isBanned) document.getElementById('create-post-box').classList.remove('hidden');
        
        if (window.globalUsersCache[user.uid]?.pic || user.photoURL) {
            document.getElementById('nav-avatar').src = window.globalUsersCache[user.uid]?.pic || user.photoURL;
        }

        window.updateNotifBadge();

        // Start the dedicated notifications listener for this user
        if (window._startNotifListener) window._startNotifListener(user.uid);

        // Auto-migrate user's legacy earnings and hostedGames out of /users
        if (window.migrateUserEarningsAndHostedGames) {
            setTimeout(() => window.migrateUserEarningsAndHostedGames(user.uid), 2000);
        }

        // Auto-cleanup: keep only the latest 50 notifications in the database
        setTimeout(() => {
            get(ref(db, `notifications/${user.uid}`)).then(snap => {
                const allNotifs = snap.val();
                if (allNotifs) {
                    const keys = Object.keys(allNotifs);
                    if (keys.length > 50) {
                        // Sort by timestamp (oldest first)
                        keys.sort((a, b) => (allNotifs[a].timestamp || 0) - (allNotifs[b].timestamp || 0));
                        const keysToDelete = keys.slice(0, keys.length - 50);
                        const updates = {};
                        keysToDelete.forEach(k => updates[k] = null);
                        update(ref(db, `notifications/${user.uid}`), updates).catch(e => console.warn("Failed to prune notifications", e));
                    }
                }
            }).catch(e => console.warn("Failed to fetch notifications for pruning", e));
        }, 5000); // Wait 5 seconds after load to not block initial rendering

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

document.getElementById('install-pwa-btn')?.addEventListener('click', async () => {
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
});
