import { db, fsdb } from "./firebase-config.js";
import { ref, update, remove, set, push, increment, get, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, doc, addDoc, getDoc, updateDoc, deleteDoc, deleteField, serverTimestamp as fsServerTimestamp, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// State Variables attached to window to preserve inline HTML function functionality
window.currentUser = null;
window.currentFilter = "All";
window.currentMemberFilter = "All";
window.allPosts = [];
window.globalPinnedPosts = window.globalPinnedPosts || [];
window.globalUsersCache = {};
window.onlineUsers = {};
window.isSignUpMode = false;
window.activeProfileUid = null;
window.commentSortState = {};
window.initialLinkDone = false;
window.openComments = new Set();
window.openReplies = new Set();
window.openRepliesList = new Set();
window.isolatedPostId = null;

// Pagination Core States
window.feedRenderLimit = 15;
window.profileRenderLimit = 15;
window.membersRenderLimit = 20;
window.feedObserver = null;
window.profileObserver = null;
window.membersObserver = null;

window.deviceId = localStorage.getItem('hangout_device_id') || ('dev_' + Math.random().toString(36).substring(2, 15));
localStorage.setItem('hangout_device_id', window.deviceId);
window.activeEditTarget = null;

// ==========================================
// V6.1 NEW STATES
// ==========================================
window.postVisibility = 'public'; // Can be 'public' or 'private'
window.currentMentionMatch = null;

// Typing protection (v6.3)
window.isUserTyping = false;
window.typingTimer = null;

// Dynamic Settings (loaded from Firebase /settings)
window.siteSettings = {
    starsPerPost: 10,
    starsPerComment: 1,
    starsPerReply: 1,
    starsPerLike: 1,
    starsPerPoked: 5,
    lbPointsPerWin: 5,
    maxLbPointsPrize: 100,
    imageUploadLimit: 10,
    videoUploadLimit: 3,
    videoSizeLimitMB: 20,
    chatImageLimit: 10,
    chatVideoLimit: 3,
    chatVoiceLimit: 10,
    chatVideoSizeLimitMB: 20
};
window.showAlert = (msg) => {
    document.getElementById('custom-alert-msg').innerText = msg;
    document.getElementById('custom-alert-modal').classList.remove('hidden');
};

window.showConfirm = (msg, onConfirm) => {
    document.getElementById('custom-confirm-msg').innerText = msg;
    const confirmBtn = document.getElementById('custom-confirm-btn');
    confirmBtn.onclick = () => { onConfirm(); document.getElementById('custom-confirm-modal').classList.add('hidden'); };
    document.getElementById('custom-confirm-modal').classList.remove('hidden');
};

window.logActivity = (actionText) => {
    if (!window.currentUser) return;
    try {
        const userName = window.globalUsersCache?.[window.currentUser.uid]?.name 
                      || window.currentUser.displayName 
                      || (window.currentUser.email ? window.currentUser.email.split('@')[0] : 'Unknown User');
        push(ref(db, 'activity_log'), {
            user: userName,
            userId: window.currentUser.uid,
            action: actionText,
            timestamp: Date.now()
        });
    } catch(e) {
        console.warn('logActivity failed:', e);
    }
};

window.debounce = function(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
};

window.saveInputStates = () => {
    const states = {};
    document.querySelectorAll('input[type="text"], textarea').forEach(el => {
        if(el.id && el.value !== undefined && el.value !== "") {
            states[el.id] = {
                value: el.value,
                start: el.selectionStart,
                end: el.selectionEnd
            };
        }
    });
    return states;
};

window.restoreInputStates = (states) => {
    for(let id in states) {
        const el = document.getElementById(id);
        if(el) {
            el.value = states[id].value;
            try { el.setSelectionRange(states[id].start, states[id].end); } catch(e) {}
        }
    }
};

window.generateAvatar = (seed) => `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=transparent`;

window.getRole = function(uid) {
    const user = window.globalUsersCache[uid] || {};
    if (user.isAdmin === true) return { title: 'Admin', level: 3, badgeHtml: `<span class="bg-red-500/20 text-red-500 dark:text-red-400 border border-red-500/30 text-[9px] px-1.5 py-0 rounded uppercase font-bold ml-1">Admin</span>` };
    if (user.isMod === true) return { title: 'Mod', level: 2, badgeHtml: `<span class="bg-purple-500/20 text-purple-600 dark:text-purple-400 border border-purple-500/30 text-[9px] px-1.5 py-0 rounded uppercase font-bold ml-1">Mod</span>` };
    return { title: 'Member', level: 1, badgeHtml: `` }; 
};

window.canDelete = function(targetUid) {
    if(!window.currentUser) return false;
    if(window.currentUser.uid === targetUid) return true; 
    return window.getRole(window.currentUser.uid).level > window.getRole(targetUid).level;
};

window.checkBan = function() {
    if (window.globalUsersCache[window.currentUser?.uid]?.isBanned) {
        window.showAlert("Your account has been banned from interacting by a Moderator.");
        return true;
    }
    return false;
};

window.timeAgo = (timestamp) => {
    if (!timestamp) return 'now';
    const ts = timestamp?.toMillis ? timestamp.toMillis() : timestamp;
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return "now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h";
    const days = Math.floor(hours / 24);
    if (days < 30) return days + "d";
    const months = Math.floor(days / 30);
    if (months < 12) return months + "mo";
    return Math.floor(months / 12) + "y";
};

window.copyPostLink = function(postId) {
    const url = window.location.origin + window.location.pathname + '?post=' + postId;
    navigator.clipboard.writeText(url).then(() => window.showAlert("Post link copied to clipboard!"));
};

window.repostPost = function(postId) {
    if (!window.currentUser) return window.showAlert("Please sign in to repost.");
    if (window.globalUsersCache[window.currentUser.uid]?.isBanned) return window.showAlert("Banned users cannot repost.");

    window.showConfirm("Are you sure you want to repost this to your profile and bump it in the feed?", async () => {
        try {
            const snap = await getDoc(doc(fsdb, 'community_posts', postId));
            if (!snap.exists()) return window.showAlert("Post not found.");
            
            const originalPost = snap.data();


            // Prevent reposting a repost
            const trueOriginalId = originalPost.isRepost ? originalPost.originalPostId : postId;
            const trueOriginalAuthorId = originalPost.isRepost ? originalPost.originalAuthorId : originalPost.authorId;

            const isRepostedGame = originalPost.isGame || originalPost.category === 'Games';

            await addDoc(collection(fsdb, 'community_posts'), {
                authorId: window.currentUser.uid,
                text: originalPost.text || "",
                image: originalPost.image || "",
                category: originalPost.category || "General",
                timestamp: Date.now(),
                pinned: false,
                edited: false,
                locked: false,
                reactions: {},
                visibility: originalPost.visibility || 'public',
                isRepost: true,
                isRepostedGame: isRepostedGame,
                originalPostId: trueOriginalId,
                originalAuthorId: trueOriginalAuthorId
            });
            window.showAlert("Post reposted successfully!");
        } catch (error) {
            window.showAlert("Failed to repost: " + error.message);
        }
    });
};

window.copyProfileLink = function(uid) {
    const url = window.location.origin + window.location.pathname + '?profile=' + uid;
    navigator.clipboard.writeText(url).then(() => window.showAlert("Profile link copied to clipboard!"));
};

window.pokeUser = async function(targetUid) {
    if (!window.currentUser) return window.showAlert("Please sign in to poke.");
    if (window.currentUser.uid === targetUid) return window.showAlert("You can't poke yourself!");
    if (window.globalUsersCache[window.currentUser.uid]?.isBanned) return window.showAlert("Banned users cannot poke.");

    const todayStr = new Date().toLocaleDateString();
    
    try {
        const pokeRef = ref(db, `users/${targetUid}/pokesFrom/${window.currentUser.uid}`);
        const snap = await get(pokeRef);
        const data = snap.val() || { count: 0, lastPokedDate: '' };
        
        let newCount = data.count;
        if (data.lastPokedDate !== todayStr) {
            newCount++;
            await set(pokeRef, { count: newCount, lastPokedDate: todayStr });
            const pokePoints = window.siteSettings.starsPerPoked ?? 5;
            await update(ref(db, `users/${targetUid}`), { totalPokes: increment(1), points: increment(pokePoints) });
        }

        // Always send a notification
        push(ref(db, `notifications/${targetUid}`), {
            type: 'poke', sourceUid: window.currentUser.uid, timestamp: Date.now(), read: false
        });

        if(window.activeProfileUid === targetUid && window.renderProfileData) {
            window.renderProfileData(false); // refresh the profile UI
        }
    } catch(e) {
        console.error("Error poking:", e);
        window.showAlert("Failed to send poke.");
    }
};

window.viewImage = (src) => {
    document.getElementById('viewer-img').src = src;
    document.getElementById('image-viewer-modal').classList.remove('hidden');
    
    // Generate unique filename based on current date/time
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const uniqueName = `hangout_${dateStr}_${timeStr}`;
    
    // Attempt to fetch image as blob to allow download for cross-origin images
    const downloadBtn = document.getElementById('viewer-download-btn');
    downloadBtn.href = '#';
    downloadBtn.download = uniqueName;
    fetch(src)
        .then(res => res.blob())
        .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            downloadBtn.href = blobUrl;
        })
        .catch(() => {
            // Fallback: just link directly (may open new tab for cross-origin)
            downloadBtn.href = src;
        });
};

window.closeImageViewer = () => {
    const downloadBtn = document.getElementById('viewer-download-btn');
    // Revoke any blob URL to free memory
    if (downloadBtn.href && downloadBtn.href.startsWith('blob:')) {
        URL.revokeObjectURL(downloadBtn.href);
    }
    document.getElementById('image-viewer-modal').classList.add('hidden');
    document.getElementById('viewer-img').src = '';
    downloadBtn.href = '#';
};

window.compressImage = (file, heavy = false) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const MAX_SIZE = heavy ? 400 : 800; 
                let { width, height } = img;
                if (width > height && width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; } 
                else if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; }
                canvas.width = width; canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', heavy ? 0.4 : 0.7)); 
            };
            img.onerror = (err) => reject(err);
        };
        reader.onerror = (err) => reject(err);
    });
};

window.uploadToCloudinary = async (fileOrBase64, folder = null) => {
    const cloudName = "rlnbst7h";
    const uploadPreset = "hangout-images";
    const url = `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`;
    
    const formData = new FormData();
    formData.append('file', fileOrBase64);
    formData.append('upload_preset', uploadPreset);
    if (folder) {
        formData.append('folder', `users/${folder}`);
    }
    
    const response = await fetch(url, {
        method: 'POST',
        body: formData
    });
    
    if (!response.ok) {
        throw new Error('Failed to upload media to Cloudinary');
    }
    
    const data = await response.json();
    return data.secure_url;
};

window.handleDeepLinks = () => {
    if (window.initialLinkDone) return;
    const params = new URLSearchParams(window.location.search);
    const targetProfile = params.get('profile');
    const targetPost = params.get('post');

    if (targetProfile && Object.keys(window.globalUsersCache).length > 0) {
        if (window.globalUsersCache[targetProfile]) {
            window.openProfile(targetProfile);
            window.initialLinkDone = true;
        }
    } else if (targetPost && window.allPosts.length > 0) {
        window.goToPost(targetPost);
        window.initialLinkDone = true;
    }
};

window.formatText = (text) => {
    if(!text) return '';
    let formatted = text.replace(/</g, "&lt;").replace(/>/g, "&gt;"); 
    
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    formatted = formatted.replace(urlRegex, function(url) {
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-blue-500 hover:underline break-all">${url}</a>`;
    });

    // Highlight @everyone
    formatted = formatted.replace(/@everyone(?![\w])/gi, `<span class="text-red-500 font-bold">@everyone</span>`);

    // Highlight @mods
    formatted = formatted.replace(/@mods(?![\w])/gi, `<span class="text-green-500 font-bold">@mods</span>`);

    const sortedUsers = Object.keys(window.globalUsersCache)
        .map(uid => ({uid, name: window.globalUsersCache[uid].name}))
        .filter(u => u.name)
        .sort((a,b) => b.name.length - a.name.length);
        
    sortedUsers.forEach(u => {
        const safeName = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`@${safeName}(?![\\w])`, 'gi');
        formatted = formatted.replace(regex, `<span class="text-blue-500 font-bold cursor-pointer hover:underline" onclick="event.stopPropagation(); window.openProfile('${u.uid}')">$&</span>`);
    });
    return formatted;
};

window.generateEmbed = (text) => {
    if(!text) return '';
    let embedHtml = '';
    
    const ytMatch = text.match(/(?:https?:\/\/)?(?:m\.|www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i);
    if(ytMatch) {
        embedHtml += `<div class="mt-2 relative overflow-hidden pb-[56.25%] rounded-lg border border-gray-100 dark:border-slate-700 shadow-sm bg-black"><iframe class="absolute top-0 left-0 w-full h-full" src="https://www.youtube.com/embed/${ytMatch[1]}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
        return embedHtml; 
    }
    
    const tiktokMatch = text.match(/https?:\/\/(?:www\.)?tiktok\.com\/@[^\/]+\/video\/(\d+)/i);
    if(tiktokMatch) {
        embedHtml += `<div class="mt-2 relative w-full max-w-[325px] rounded-xl overflow-hidden border border-gray-100 dark:border-slate-700 shadow-sm bg-black" style="aspect-ratio: 9/16;"><iframe class="absolute top-0 left-0 w-full h-full" src="https://www.tiktok.com/embed/v2/${tiktokMatch[1]}" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`;
        return embedHtml;
    }

    const fbPostMatch = text.match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/(?:[a-zA-Z0-9_.-]+\/posts\/\d+|share\/p\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_.-]+\/photos\/.*)/i);
    if (fbPostMatch) {
        const fbUrl = encodeURIComponent(fbPostMatch[0]);
        embedHtml += `<div class="mt-2 w-full overflow-hidden rounded-lg border border-gray-100 dark:border-slate-700 shadow-sm bg-white"><iframe src="https://www.facebook.com/plugins/post.php?href=${fbUrl}&show_text=true&width=500" width="100%" height="400" style="border:none;overflow:hidden" scrolling="auto" frameborder="0" allowfullscreen="true" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" loading="lazy"></iframe></div>`;
        return embedHtml;
    }

    const fbVideoMatch = text.match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/(?:video\.php\?v=\d+|[a-zA-Z0-9_.-]+\/videos\/\d+|reel\/\d+|share\/r\/[a-zA-Z0-9_-]+)/i);
    if(fbVideoMatch) {
        const fbUrl = encodeURIComponent(fbVideoMatch[0]);
        embedHtml += `<div class="mt-2 relative overflow-hidden pb-[56.25%] rounded-lg border border-gray-100 dark:border-slate-700 shadow-sm bg-black"><iframe class="absolute top-0 left-0 w-full h-full" src="https://www.facebook.com/plugins/video.php?href=${fbUrl}&show_text=false&width=auto" scrolling="no" frameborder="0" allowfullscreen="true" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" loading="lazy"></iframe></div>`;
        return embedHtml;
    }

    const spotifyMatch = text.match(/https?:\/\/open\.spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/i);
    if(spotifyMatch) {
        embedHtml += `<div class="mt-2 h-[152px] rounded-lg overflow-hidden border border-gray-100 dark:border-slate-700 shadow-sm"><iframe src="https://open.spotify.com/embed/${spotifyMatch[1]}/${spotifyMatch[2]}" width="100%" height="152" frameborder="0" allowtransparency="true" allow="encrypted-media" loading="lazy"></iframe></div>`;
    }

    return embedHtml;
};

window.notifyMentions = (text, postId) => {
    if(!text || !window.currentUser) return;
    const uids = new Set();
    const sortedUsers = Object.keys(window.globalUsersCache).map(uid => ({uid, name: window.globalUsersCache[uid].name})).filter(u => u.name);
    
    sortedUsers.forEach(u => {
        if (text.toLowerCase().includes(`@${u.name.toLowerCase()}`)) {
            if (u.uid !== window.currentUser.uid) uids.add(u.uid);
        }
    });
    
    uids.forEach(uid => {
        push(ref(db, `notifications/${uid}`), { 
            type: 'mention', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
        });
    });
};

window.isPostPinned = (post, filterContext) => {
    // Always use the live pinned arrays as source of truth.
    // Never read post.pinned/post.feedPinned/post.profilePinned from the DB document —
    // those fields are stale legacy data and will cause old posts to wrongly sort to the top.
    if (filterContext === 'profile') {
        return (window.profilePinnedPosts || []).some(p => p.id === post.id);
    }
    return (window.globalPinnedPosts || []).some(p => p.id === post.id);
};

// API Interactions & Toggles
window.deleteItem = (dbPath, targetUid) => {
    if(!window.canDelete(targetUid)) return window.showAlert("Permission denied");
    window.showConfirm("Are you sure you want to permanently delete this?", async () => {
        try {
            if (dbPath.startsWith('community_posts/')) {
                const parts = dbPath.split('/');
                const postId = parts[1];
                if (parts.length === 2) {
                    // It's a post deletion
                    await deleteDoc(doc(fsdb, 'community_posts', postId));
                    // Clean up pinned settings just in case
                    try {
                        const settingsRef = doc(fsdb, 'settings', 'pinned');
                        await updateDoc(settingsRef, {
                            feedPinnedIds: arrayRemove(postId),
                            profilePinnedIds: arrayRemove(postId)
                        });
                    } catch(e) { /* ignore if doc doesn't exist */ }
                } else if (parts.length === 4 && parts[2] === 'comments') {
                    // It's a comment deletion
                    const cId = parts[3];
                    await updateDoc(doc(fsdb, 'community_posts', postId), {
                        [`comments.${cId}`]: deleteField()
                    });
                } else if (parts.length === 6 && parts[2] === 'comments' && parts[4] === 'replies') {
                    // It's a reply deletion
                    const cId = parts[3];
                    const rId = parts[5];
                    await updateDoc(doc(fsdb, 'community_posts', postId), {
                        [`comments.${cId}.replies.${rId}`]: deleteField()
                    });
                }
            } else {
                // Fallback for any RTDB paths (if any remain)
                await remove(ref(db, dbPath));
            }
        } catch(e) {
            console.error("Delete error:", e);
            window.showAlert("Failed to delete.");
        }
    });
}

// Registry of per-post live listeners attached via the Refresh button.
// Key: postId, Value: unsubscribe function
window._postLiveListeners = window._postLiveListeners || {};

window.refreshSinglePost = async (postId) => {
    // If already listening, clicking Refresh again stops the listener (toggle off)
    if (window._postLiveListeners[postId]) {
        window._postLiveListeners[postId]();
        delete window._postLiveListeners[postId];
        // Update button to show it's no longer live
        const btn = document.querySelector(`#post-main-${postId} .refresh-btn`)
            || document.querySelector(`#post-profile-${postId} .refresh-btn`);
        if (btn) {
            btn.classList.remove('text-green-500');
            btn.classList.add('text-gray-400');
            btn.title = 'Refresh Post';
        }
        return;
    }

    // Cap total per-post listeners to avoid Firestore exhaustion
    const MAX_POST_LISTENERS = 10;
    const listenerIds = Object.keys(window._postLiveListeners);
    if (listenerIds.length >= MAX_POST_LISTENERS) {
        // Evict the oldest listener (first in the map)
        const evictId = listenerIds[0];
        window._postLiveListeners[evictId]();
        delete window._postLiveListeners[evictId];
        const oldBtn = document.querySelector(`#post-main-${evictId} .refresh-btn`)
            || document.querySelector(`#post-profile-${evictId} .refresh-btn`);
        if (oldBtn) {
            oldBtn.classList.remove('text-green-500');
            oldBtn.classList.add('text-gray-400');
            oldBtn.title = 'Refresh Post';
        }
    }

    // Animate the button and mark it green to signal "live"
    const btn = document.querySelector(`#post-main-${postId} .refresh-btn`)
        || document.querySelector(`#post-profile-${postId} .refresh-btn`);
    const icon = btn?.querySelector('.fa-arrows-rotate');
    if (icon) icon.classList.add('fa-spin');

    try {
        const { onSnapshot, doc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");

        const unsubscribe = onSnapshot(doc(fsdb, 'community_posts', postId), (snap) => {
            if (icon) icon.classList.remove('fa-spin');

            if (!snap.exists()) return;

            const updatedPost = { id: postId, ...snap.data() };

            // Update in all local caches
            const indexAll = window.allPosts.findIndex(p => p.id === postId);
            if (indexAll !== -1) window.allPosts[indexAll] = updatedPost;

            const indexGlobal = (window.globalPinnedPosts || []).findIndex(p => p.id === postId);
            if (indexGlobal !== -1) window.globalPinnedPosts[indexGlobal] = updatedPost;

            const indexProfile = (window.profilePinnedPosts || []).findIndex(p => p.id === postId);
            if (indexProfile !== -1) window.profilePinnedPosts[indexProfile] = updatedPost;

            // Run game timer check on this newly-live post so it can auto-end if expired
            if (window.checkGameTimers) {
                window.checkGameTimers({ [postId]: updatedPost });
            }

            if (window.activeProfileUid) window.renderProfileData(false);
            else window.renderFeed(false);

            // Keep button green to indicate it's live
            if (btn) {
                btn.classList.remove('text-gray-400');
                btn.classList.add('text-green-500');
                btn.title = 'Live (click to stop)';
            }
        }, (e) => {
            console.error("Live post listener error:", e);
            if (icon) icon.classList.remove('fa-spin');
            delete window._postLiveListeners[postId];
        });

        window._postLiveListeners[postId] = unsubscribe;

    } catch (e) {
        console.error("Refresh error:", e);
        if (icon) icon.classList.remove('fa-spin');
    }
};

window.openPinModal = (postId, isProfilePinned, isFeedPinned, authorId) => {
    if (!window.currentUser) return;
    
    const roleLevel = window.getRole(window.currentUser.uid).level;
    const isAuthor = window.currentUser.uid === authorId;
    const isMod = roleLevel === 2;
    const authorRoleLevel = window.getRole(authorId).level;

    // Mods cannot pin/unpin Admin posts
    if (isMod && !isAuthor && authorRoleLevel >= 3) {
        return window.showAlert("Mods cannot pin or unpin Admin posts.");
    }
    
    if (!isAuthor && roleLevel < 2) return; 
    
    const btnProfile = document.getElementById('btn-pin-profile');
    const textProfile = document.getElementById('text-pin-profile');
    const btnFeed = document.getElementById('btn-pin-feed');
    const textFeed = document.getElementById('text-pin-feed');
    
    if (isAuthor) {
        btnProfile.classList.remove('hidden');
        textProfile.innerText = isProfilePinned ? "Unpin from Profile" : "Pin to Profile";
        btnProfile.onclick = () => {
            document.getElementById('pin-options-modal').classList.add('hidden');
            window.executePin(postId, 'profilePinned', !isProfilePinned);
        };
    } else {
        btnProfile.classList.add('hidden');
    }
    
    if (roleLevel >= 2) {
        btnFeed.classList.remove('hidden');
        textFeed.innerText = isFeedPinned ? "Unpin from Global Feed" : "Pin to Global Feed";
        btnFeed.onclick = () => {
            document.getElementById('pin-options-modal').classList.add('hidden');
            window.executePin(postId, 'feedPinned', !isFeedPinned);
        };
    } else {
        btnFeed.classList.add('hidden');
    }
    
    document.getElementById('pin-options-modal').classList.remove('hidden');
};

window.executePin = (postId, pinType, targetStatus) => {
    // 1. We still optionally flag it on the post itself for older queries, but we don't listen to it globally.
    updateDoc(doc(fsdb, 'community_posts', postId), { [pinType]: targetStatus }).catch(() => {});

    // 2. The single source of truth for the active feed listeners is the `settings/pinned` document.
    const settingsRef = doc(fsdb, 'settings', 'pinned');
    const field = pinType === 'feedPinned' ? 'feedPinnedIds' : 'profilePinnedIds';
    const change = targetStatus ? arrayUnion(postId) : arrayRemove(postId);
    updateDoc(settingsRef, { [field]: change }).catch(() => {
        // Document may not exist yet — create it
        import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js")
            .then(({ setDoc }) => setDoc(settingsRef, { [field]: targetStatus ? [postId] : [] }, { merge: true }));
    });

    // 3. Optimistically update local state so UI reflects immediately (no need to wait for listener)
    if (targetStatus) {
        const post = window.allPosts.find(p => p.id === postId);
        if (post) {
            post[pinType] = true;
            if (pinType === 'feedPinned' && !window.globalPinnedPosts.find(p => p.id === postId)) {
                window.globalPinnedPosts.push(post);
            } else if (pinType === 'profilePinned' && !window.profilePinnedPosts.find(p => p.id === postId)) {
                window.profilePinnedPosts.push(post);
            }
        }
    } else {
        const post = window.allPosts.find(p => p.id === postId);
        if (post) post[pinType] = false;
        if (pinType === 'feedPinned') {
            window.globalPinnedPosts = window.globalPinnedPosts.filter(p => p.id !== postId);
        } else {
            window.profilePinnedPosts = (window.profilePinnedPosts || []).filter(p => p.id !== postId);
        }
    }
    if (typeof window.renderFeed === 'function') window.renderFeed(false);
};

window.toggleLock = (postId, currentStatus) => {
    const post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId);
    if (!post || !window.currentUser) return;
    const roleLevel = window.getRole(window.currentUser.uid).level;
    const isAuthor = window.currentUser.uid === post.authorId;
    const isMod = roleLevel === 2;
    // Mods cannot lock/unlock Game posts — only the author or Admin can
    if (isMod && !isAuthor && post.category === 'Games') {
        return window.showAlert("Mods cannot lock or unlock Game posts.");
    }
    if (roleLevel >= 2 || isAuthor) {
        updateDoc(doc(fsdb, 'community_posts', postId), { locked: !currentStatus });
    }
};

window.toggleMod = (targetUid) => {
    if(!window.currentUser || window.getRole(window.currentUser.uid).level !== 3) return window.showAlert("Only Admins can do this.");
    const isCurrentlyMod = window.globalUsersCache[targetUid]?.isMod === true;
    update(ref(db, `users/${targetUid}`), { isMod: !isCurrentlyMod });
};

window.toggleBan = (targetUid) => {
    if(!window.canDelete(targetUid)) return window.showAlert("Permission denied. You cannot ban this user.");
    const isBanned = window.globalUsersCache[targetUid]?.isBanned === true;
    window.showConfirm(isBanned ? "Unban this user? They will be able to post and interact again." : "Ban this user? They will be locked out from posting, commenting, and reacting.", () => {
        update(ref(db, `users/${targetUid}`), { isBanned: !isBanned });
    });
};

window.toggleFollow = (targetUid) => {
    if(!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    const isFollowing = window.globalUsersCache[window.currentUser.uid]?.following?.[targetUid];
    const starsPerFollow = window.siteSettings.starsPerFollow ?? 5;
    
    if(isFollowing) {
        remove(ref(db, `users/${window.currentUser.uid}/following/${targetUid}`));
        remove(ref(db, `users/${targetUid}/followers/${window.currentUser.uid}`));
        update(ref(db, `users/${targetUid}`), { points: increment(-starsPerFollow) });
    } else {
        set(ref(db, `users/${window.currentUser.uid}/following/${targetUid}`), true);
        set(ref(db, `users/${targetUid}/followers/${window.currentUser.uid}`), true);
        update(ref(db, `users/${targetUid}`), { points: increment(starsPerFollow) });
        
        if(targetUid !== window.currentUser.uid) {
            push(ref(db, `notifications/${targetUid}`), { 
                type: 'follow', sourceUid: window.currentUser.uid, timestamp: Date.now(), read: false 
            });
        }
    }
};

window.markNotifRead = (notifId) => {
    if (!window.currentUser) return;
    update(ref(db, `notifications/${window.currentUser.uid}/${notifId}`), { read: true });
};

window.clearNotifications = () => {
    const myNotifs = window.myNotifications || {};
    let updates = {};
    for(let key in myNotifs) {
        if(!myNotifs[key].read) updates[`${key}/read`] = true;
    }
    if(Object.keys(updates).length > 0) {
        update(ref(db, `notifications/${window.currentUser.uid}`), updates);
    }
    document.getElementById('notif-modal').classList.add('hidden');
};