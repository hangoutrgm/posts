import { db, fsdb, fsdb2, getPostDocRef, getFirestoreForPost, getRoundRobinFsdb, getFirestoreBySource } from "./firebase-config.js";
import { ref, update, set, push, remove, increment, get, onValue } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
window.escapeHtml = escapeHtml;

window.formatLogPrizeBadges = (prize, lbPoints) => {
    const badges = [];
    if (prize) {
        const str = String(prize).trim();
        if (str.includes(' + Bonus: ') || str.startsWith('Bonus: ')) {
            const parts = str.split(' + Bonus: ');
            if (parts[0] && !parts[0].startsWith('Bonus: ')) {
                badges.push(`<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"><i class="fa-solid fa-gift text-emerald-500"></i> ${escapeHtml(parts[0])}</span>`);
            }
            const bonusPart = parts.length > 1 ? parts[1] : parts[0].replace(/^Bonus:\s*/, '');
            if (bonusPart) {
                badges.push(`<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-purple-500/10 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/30"><i class="fa-solid fa-wand-magic-sparkles text-purple-500"></i> Bonus: ${escapeHtml(bonusPart)}</span>`);
            }
        } else {
            badges.push(`<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"><i class="fa-solid fa-gift text-emerald-500"></i> ${escapeHtml(str)}</span>`);
        }
    }
    if (lbPoints && Number(lbPoints) > 0) {
        badges.push(`<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30"><i class="fa-solid fa-trophy text-amber-500"></i> +${Number(lbPoints)} LB</span>`);
    }
    return badges.join('');
};

// Notifications
window.updateNotifBadge = () => {
    if(!window.currentUser) return;
    const myNotifs = window.myNotifications || {};
    let unreadCount = Object.values(myNotifs).filter(n => !n.read).length;
    const badge = document.getElementById('notif-badge');
    
    if (unreadCount > 0) {
        badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
};

window.renderNotifications = () => {
    if (window.requestNotificationPermission) window.requestNotificationPermission();
    
    const myNotifs = window.myNotifications || {};
    const content = document.getElementById('notif-content');
    
    const notifsArray = Object.keys(myNotifs).map(key => ({ id: key, ...myNotifs[key] }));
    notifsArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const displayNotifs = notifsArray.slice(0, 30); 

    if(displayNotifs.length === 0) {
        content.innerHTML = "<p class='text-gray-500 font-normal text-center py-5'>You have no notifications yet.</p>";
    } else {
        content.innerHTML = displayNotifs.map(n => {
            const u = window.globalUsersCache[n.sourceUid] || { name: 'Someone', pic: window.generateAvatar(n.sourceUid) };
            let text = ''; let icon = '';
            
            let linkAction = n.postId ? `onclick="window.goToPost('${n.postId}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');"` : '';
            
            if(n.type === 'react_post') { text = 'reacted to your post.'; icon = '❤️'; }
            else if(n.type === 'react_comment') { text = 'reacted to your comment.'; icon = '❤️'; }
            else if(n.type === 'react_reply') { text = 'reacted to your reply.'; icon = '❤️'; }
            else if(n.type === 'comment') { text = 'commented on your post.'; icon = '💬'; }
            else if(n.type === 'reply') { text = 'replied to your comment.'; icon = '↪️'; }
            else if(n.type === 'mention') { text = 'mentioned you.'; icon = '📣'; }
            else if(n.type === 'game_challenge') { text = 'challenged you to a game! 🎮'; icon = '🎮'; }
            else if(n.type === 'follow') { 
                text = 'started following you.'; icon = '👥'; 
                linkAction = `onclick="window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');"`;
            }
            else if(n.type === 'poke') {
                text = 'poked you!'; icon = '👉';
                linkAction = `onclick="window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');"`;
            }

            // Format timestamp
            let timeDisplay = '';
            if (n.timestamp) {
                const d = new Date(n.timestamp);
                const fullDate = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                timeDisplay = `<span class="text-gray-400 dark:text-gray-500 text-[9px] mt-0.5 block" title="${fullDate}">${window.timeAgo(n.timestamp)} ago • ${fullDate}</span>`;
            }

            return `
            <div class="flex items-center p-2.5 rounded-lg mb-1 border border-gray-100 dark:border-slate-700/50 ${n.read ? 'bg-gray-50 dark:bg-slate-900/50 opacity-80' : 'bg-blue-50 dark:bg-blue-900/20'} hover:opacity-100 cursor-pointer transition shadow-sm" ${linkAction}>
                <img src="${u.pic || window.generateAvatar(n.sourceUid)}" loading="lazy" class="w-8 h-8 rounded-full object-cover mr-3 shrink-0 border border-gray-200 dark:border-slate-600" onclick="event.stopPropagation(); window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');">
                <div class="flex-1 text-[11px] leading-tight min-w-0">
                    <div>
                        <span class="font-bold text-gray-900 dark:text-white hover:underline" onclick="event.stopPropagation(); window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');">${u.name}</span>
                        <span class="text-gray-600 dark:text-gray-300 font-normal"> ${text}</span>
                    </div>
                    ${timeDisplay}
                </div>
                <div class="text-lg ml-2 shrink-0">${icon}</div>
            </div>
            `;
        }).join('');
    }
};

// Profile UI


window.openProfile = (uid) => {
    document.getElementById('members-modal').classList.add('hidden');
    document.getElementById('main-view').classList.add('hidden');
    document.getElementById('profile-view').classList.remove('hidden');
    window.activeProfileUid = uid;
    window.postLimit = 15;
    window.hasMorePosts = true;
    if (window.listenPosts) window.listenPosts();
    window.renderProfileData(true);
    window.scrollTo(0,0);
};

window.closeProfile = () => {
    document.getElementById('profile-view').classList.add('hidden');
    document.getElementById('main-view').classList.remove('hidden');
    window.activeProfileUid = null;
    window.postLimit = 15;
    window.hasMorePosts = true;
    if (window.listenPosts) window.listenPosts();
    window.history.replaceState({}, document.title, window.location.pathname);
};

window.goToPost = (postId) => {
    window.closeProfile(); 
    window.currentFilter = "All"; 
    window.isolatedPostId = postId;
    window.isolatedPostData = window.allPosts.find(p => p.id === postId) 
        || (window.globalPinnedPosts || []).find(p => p.id === postId) 
        || (window.profilePinnedPosts || []).find(p => p.id === postId) 
        || null;

    if (window.isolatedPostUnsubscribe) {
        window.isolatedPostUnsubscribe();
        window.isolatedPostUnsubscribe = null;
    }

    const targetRef = getPostDocRef(postId);
    window.isolatedPostUnsubscribe = onSnapshot(targetRef, (snapshot) => {
        if (snapshot.exists()) {
            const dbSource = snapshot.ref.firestore === fsdb2 ? 2 : 1;
            const post = { id: snapshot.id, ...snapshot.data(), _dbSource: dbSource };
            window._postDbMap.set(postId, dbSource);
            window.isolatedPostData = post;
            const existingIndex = window.allPosts.findIndex(p => p.id === post.id);
            if (existingIndex >= 0) {
                window.allPosts[existingIndex] = post;
            } else {
                window.allPosts.push(post);
            }

            if (!window.isUserTyping && !window._bingoGlobalSpinning) {
                if (!window.usersReady) {
                    window._pendingPostRender = true;
                } else {
                    window.renderFeed(false);
                }
            }
        } else if (snapshot.ref.firestore === fsdb) {
            if (window.isolatedPostUnsubscribe) window.isolatedPostUnsubscribe();
            window.isolatedPostUnsubscribe = onSnapshot(doc(fsdb2, 'community_posts', postId), (snap2) => {
                if (snap2.exists()) {
                    const post = { id: snap2.id, ...snap2.data(), _dbSource: 2 };
                    window._postDbMap.set(postId, 2);
                    window.isolatedPostData = post;
                    const existingIndex = window.allPosts.findIndex(p => p.id === post.id);
                    if (existingIndex >= 0) window.allPosts[existingIndex] = post;
                    else window.allPosts.push(post);
                    if (!window.isUserTyping && !window._bingoGlobalSpinning) {
                        if (!window.usersReady) window._pendingPostRender = true;
                        else window.renderFeed(false);
                    }
                } else {
                    const feed = document.getElementById('feed');
                    if (feed) {
                        feed.innerHTML = `<p class="text-center text-gray-500 py-10">Post not found or deleted.</p>
                        <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
                    }
                }
            });
        } else {
            const feed = document.getElementById('feed');
            if (feed) {
                feed.innerHTML = `<p class="text-center text-gray-500 py-10">Post not found or deleted.</p>
                <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
            }
        }
    }, (err) => {
        console.error("Error fetching isolated post:", err);
    });

    window.renderFeed(true);
    window.scrollTo(0,0);
};

window.clearIsolatedPost = () => {
    window.isolatedPostId = null;
    window.isolatedPostData = null;
    window.feedRenderLimit = 15;
    if (window.isolatedPostUnsubscribe) {
        window.isolatedPostUnsubscribe();
        window.isolatedPostUnsubscribe = null;
    }
    window.renderFeed(true);
};

window.openEditProfile = () => {
    if(!window.currentUser) return;
    const cache = window.globalUsersCache[window.currentUser.uid] || {};
    document.getElementById('profile-name').value = cache.name || window.currentUser.displayName || '';
    document.getElementById('profile-preview').src = cache.pic || window.currentUser.photoURL || window.generateAvatar(window.currentUser.uid);
    document.getElementById('profile-pic-url').value = '';
    document.getElementById('profile-pic-file').value = '';
    
    document.getElementById('profile-gender').value = cache.gender || '';
    document.getElementById('profile-relationship').value = cache.relationship || '';
    document.getElementById('profile-partner').value = cache.partner || '';
    document.getElementById('profile-bio').value = cache.bio || '';
    document.getElementById('profile-relationship').dispatchEvent(new Event('change'));

    // Build gallery slots
    const gallery = cache.galleryImages || [];
    const slotsContainer = document.getElementById('gallery-slots');
    slotsContainer.className = 'flex gap-2';
    slotsContainer.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const existingUrl = gallery[i] || '';
        const slot = document.createElement('div');
        slot.className = 'relative flex-1 min-w-0 rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden bg-gray-100 dark:bg-slate-900';
        slot.style.height = '90px';
        slot.innerHTML = `
            <div class="w-full h-full flex items-center justify-center">
                ${existingUrl ? `<img src="${existingUrl}" class="w-full h-full object-cover gallery-slot-preview" data-slot="${i}">` : `<i class="fa-solid fa-image text-gray-300 dark:text-slate-600 text-2xl gallery-slot-empty" data-slot="${i}"></i>`}
            </div>
            <label class="absolute inset-0 cursor-pointer flex flex-col items-center justify-end pb-1 bg-black/0 hover:bg-black/30 transition group">
                <span class="text-[9px] text-white font-bold opacity-0 group-hover:opacity-100 transition drop-shadow">Upload / URL</span>
                <input type="file" accept="image/*" class="hidden gallery-file-input" data-slot="${i}">
            </label>
            <input type="text" placeholder="or paste URL..." value="${existingUrl}" class="gallery-url-input absolute bottom-0 left-0 right-0 text-[9px] p-1 bg-black/60 text-white placeholder-gray-400 focus:outline-none hidden" data-slot="${i}">
        `;
        // Click the empty area = open file picker OR show URL input on double-click
        slot.querySelector('.gallery-file-input').addEventListener('change', async function() {
            const file = this.files[0]; if(!file) return;
            try {
                const base64Img = await window.compressImage(file);
                const compressed = await window.uploadToCloudinary(base64Img, window.currentUser?.uid);
                slot.querySelector('.gallery-url-input').value = compressed;
                // Update preview
                let prev = slot.querySelector('.gallery-slot-preview');
                if (!prev) {
                    prev = document.createElement('img');
                    prev.className = 'w-full h-full object-cover gallery-slot-preview';
                    prev.dataset.slot = i;
                    slot.querySelector('.gallery-slot-empty')?.remove();
                    slot.querySelector('.w-full.h-full').appendChild(prev);
                }
                prev.src = compressed;
            } catch(e) {}
        });
        slotsContainer.appendChild(slot);
        // Show URL input on label click if no file chosen
        slot.querySelector('label').addEventListener('dblclick', (e) => {
            e.preventDefault();
            const urlInput = slot.querySelector('.gallery-url-input');
            urlInput.classList.toggle('hidden');
            if (!urlInput.classList.contains('hidden')) urlInput.focus();
        });
    }

    window.updateAdminButtons && window.updateAdminButtons();
    document.getElementById('profile-modal').classList.remove('hidden');
};

// Rendering Engine Functions (DOM Patching)
window.renderPostList = (container, postsToRender, prefix, filterContext) => {
    const validIds = new Set(postsToRender.map(p => `post-${prefix}-${p.id}`));
    const banner = container.querySelector('#isolated-banner');
    
    // Clean up loaders
    container.querySelectorAll('#spotlight-loader, .sentinel-loader').forEach(el => el.remove());
    
    Array.from(container.children).forEach(child => {
        if (child.id && child.id.startsWith(`post-${prefix}-`) && !validIds.has(child.id)) {
            container.removeChild(child);
        } else if (child.id !== 'isolated-banner' && !child.id.startsWith(`post-${prefix}-`)) {
            container.removeChild(child);
        }
    });

    let prevNode = banner || null;
    
    postsToRender.forEach(post => {
        const elId = `post-${prefix}-${post.id}`;
        let existingEl = document.getElementById(elId);
        const newEl = window.generatePostHTML(post, prefix, filterContext);
        
        if (existingEl) {
            const parts = ['post-header', 'post-body', 'reactions'];
            parts.push('comments');

            parts.forEach(part => {
                const oldP = existingEl.querySelector(`#${part}-${prefix}-${post.id}`);
                const newP = newEl.querySelector(`#${part}-${prefix}-${post.id}`);
                if (oldP && newP && oldP.innerHTML !== newP.innerHTML) {
                    
                    // Save draft states if we are updating the comments section
                    const inputDrafts = {};
                    let focusedId = null;
                    if (part === 'comments') {
                        const textInputs = oldP.querySelectorAll('input[type="text"]');
                        textInputs.forEach(inp => {
                            if (inp.value) inputDrafts[inp.id] = inp.value;
                            if (document.activeElement === inp) focusedId = inp.id;
                        });
                    }
                    
                    oldP.innerHTML = newP.innerHTML;
                    oldP.className = newP.className;
                    
                    // Restore draft states and focus
                    if (part === 'comments') {
                        const textInputs = oldP.querySelectorAll('input[type="text"]');
                        textInputs.forEach(inp => {
                            if (inputDrafts[inp.id]) inp.value = inputDrafts[inp.id];
                        });
                        if (focusedId) {
                            const focusTarget = document.getElementById(focusedId);
                            if (focusTarget) setTimeout(() => focusTarget.focus(), 0);
                        }
                    }
                }
            });

            if (prevNode) {
                if (prevNode.nextSibling !== existingEl) container.insertBefore(existingEl, prevNode.nextSibling);
            } else {
                if (container.firstChild !== existingEl) container.insertBefore(existingEl, container.firstChild);
            }
            prevNode = existingEl;
        } else {
            if (prevNode) container.insertBefore(newEl, prevNode.nextSibling);
            else container.insertBefore(newEl, container.firstChild);
            prevNode = newEl;
        }
    });
    
    return prevNode;
};

window.renderFeed = (resetLimit = true) => {
    if (!window.usersReady) {
        window._pendingPostRender = true;
        return;
    }
    if(window.activeProfileUid) return; 
    const feed = document.getElementById('feed');
    const searchBarContainer = document.getElementById('search-bar-container');
    const catFilters = document.getElementById('category-filters');
    
    if (resetLimit) window.feedRenderLimit = 15;
    
    if (window.isolatedPostId) {
        const singlePost = window.isolatedPostData || window.allPosts.find(p => p.id === window.isolatedPostId);
        searchBarContainer.classList.add('hidden');
        catFilters.classList.add('hidden');

        if (!singlePost) {
            let loader = feed.querySelector('#spotlight-loader');
            if (!loader) {
                feed.innerHTML = `<div id="spotlight-loader" class="text-center text-gray-500 py-10">
                    <i class="fa-solid fa-spinner fa-spin text-2xl mb-2 text-blue-600"></i>
                    <p>Loading spotlight post...</p>
                </div>`;
            }
            if (!window.isolatedPostUnsubscribe) {
                const targetRef = getPostDocRef(window.isolatedPostId);
                window.isolatedPostUnsubscribe = onSnapshot(targetRef, (snapshot) => {
                    if (snapshot.exists()) {
                        const dbSource = snapshot.ref.firestore === fsdb2 ? 2 : 1;
                        const post = { id: snapshot.id, ...snapshot.data(), _dbSource: dbSource };
                        window._postDbMap.set(window.isolatedPostId, dbSource);
                        window.isolatedPostData = post;
                        const existingIndex = window.allPosts.findIndex(p => p.id === post.id);
                        if (existingIndex >= 0) {
                            window.allPosts[existingIndex] = post;
                        } else {
                            window.allPosts.push(post);
                        }

                        if (!window.isUserTyping && !window._bingoGlobalSpinning) {
                            if (!window.usersReady) {
                                window._pendingPostRender = true;
                            } else {
                                window.renderFeed(false);
                            }
                        }
                    } else if (snapshot.ref.firestore === fsdb) {
                        if (window.isolatedPostUnsubscribe) window.isolatedPostUnsubscribe();
                        window.isolatedPostUnsubscribe = onSnapshot(doc(fsdb2, 'community_posts', window.isolatedPostId), (snap2) => {
                            if (snap2.exists()) {
                                const post = { id: snap2.id, ...snap2.data(), _dbSource: 2 };
                                window._postDbMap.set(window.isolatedPostId, 2);
                                window.isolatedPostData = post;
                                const existingIndex = window.allPosts.findIndex(p => p.id === post.id);
                                if (existingIndex >= 0) window.allPosts[existingIndex] = post;
                                else window.allPosts.push(post);
                                if (!window.isUserTyping && !window._bingoGlobalSpinning) {
                                    if (!window.usersReady) window._pendingPostRender = true;
                                    else window.renderFeed(false);
                                }
                            } else {
                                feed.innerHTML = `<p class="text-center text-gray-500 py-10">Post not found or deleted.</p>
                                <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
                            }
                        });
                    } else {
                        feed.innerHTML = `<p class="text-center text-gray-500 py-10">Post not found or deleted.</p>
                        <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
                    }
                }, (err) => {
                    console.error("Error fetching isolated post:", err);
                    feed.innerHTML = `<p class="text-center text-gray-500 py-10">Failed to load post.</p>
                    <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
                });
            }
            return;
        }

        feed.querySelectorAll('#spotlight-loader').forEach(el => el.remove());

        const bannerId = 'isolated-banner';
        let banner = document.getElementById(bannerId);
        if (!banner) {
            const bannerEl = document.createElement('div');
            bannerEl.id = bannerId;
            bannerEl.className = 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 p-3 rounded-xl mb-3 flex items-center justify-between shadow-sm border border-blue-100 dark:border-blue-800/50';
            bannerEl.innerHTML = `
                <span class="text-sm font-bold"><i class="fa-solid fa-magnifying-glass mr-2"></i>Post Spotlight ✨</span>
                <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-full text-xs font-bold shadow-sm transition">Back to Feed</button>
            `;
            if (feed.firstChild) feed.insertBefore(bannerEl, feed.firstChild);
            else feed.appendChild(bannerEl);
        }

        // Guard against the race condition: don't render if users cache isn't loaded yet
        if (!window.usersReady) {
            window._pendingPostRender = true;
            return;
        }

        window.renderPostList(feed, [singlePost], 'main', 'isolated');
        if (window.processBingoAnimations) window.processBingoAnimations();
        return;
    }
    
    const existingBanner = document.getElementById('isolated-banner');
    if (existingBanner) existingBanner.remove();

    searchBarContainer.classList.remove('hidden');
    catFilters.classList.remove('hidden');

    const postSearchQ = (document.getElementById('post-search')?.value || '').toLowerCase();
    // Merge global pinned posts into the display pool so old pinned posts are always available
    const mergedMap = new Map();
    window.allPosts.forEach(p => mergedMap.set(p.id, p));
    if (window.currentFilter === 'All' || window.currentFilter === 'My Posts') {
        window.globalPinnedPosts.forEach(p => mergedMap.set(p.id, p));
    } else {
        window.globalPinnedPosts.filter(p => p.category === window.currentFilter).forEach(p => mergedMap.set(p.id, p));
    }
    const mergedPosts = Array.from(mergedMap.values());
    
    let displayPosts = mergedPosts.filter(p => {
        if (window.currentFilter === "My Posts" && (!window.currentUser || p.authorId !== window.currentUser.uid)) return false;
        if (window.currentFilter !== "All" && window.currentFilter !== "My Posts" && p.category !== window.currentFilter) return false;
        
        // ==========================================
        // V6.1 & V6.2: VISIBILITY & ADMIN BYPASS
        // ==========================================
        if (p.visibility === 'private') {
            if (!window.currentUser) return false; // Guests never see private posts
            
            const myRole = window.getRole(window.currentUser.uid).level;
            
            // If the user is NOT an Admin (3) AND NOT the Author, check mentions
            if (myRole !== 3 && p.authorId !== window.currentUser.uid) { 
                const myData = window.globalUsersCache[window.currentUser.uid];
                if (!myData || !myData.name) return false;
                
                const mentionStr = `@${myData.name}`.toLowerCase();
                const postText = (p.text || '').toLowerCase();
                
                // Allow user to see post if the author used @everyone (and was authorized to do so)
                const authorRole = window.getRole(p.authorId).level;
                const hasEveryone = postText.includes('@everyone') && authorRole >= 2;
                
                if (!postText.includes(mentionStr) && !hasEveryone) return false;
            }
        }
        
        if (postSearchQ) {
            const pText = (p.text || '').toLowerCase();
            const pAuth = (window.globalUsersCache[p.authorId]?.name || '').toLowerCase();
            if(!pText.includes(postSearchQ) && !pAuth.includes(postSearchQ)) return false;
        }
        return true;
    });

    displayPosts.sort((a, b) => { 
        const pinA = window.isPostPinned(a, window.currentFilter);
        const pinB = window.isPostPinned(b, window.currentFilter);
        if (pinA !== pinB) return pinA ? -1 : 1;
        const tsA = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp || 0);
        const tsB = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp || 0);
        return tsB - tsA;
    });

    const currentScroll = window.scrollY;
    const activeId = document.activeElement ? document.activeElement.id : null;
    const inputStates = window.saveInputStates();
    feed.style.minHeight = feed.clientHeight + 'px'; 
    
    if(displayPosts.length === 0 && !window.hasMorePosts) {
        feed.innerHTML = `<p class="text-center text-gray-400 text-xs py-10">No posts found.</p>`;
        feed.style.minHeight = '';
        return;
    }

    window.filteredPostsLength = displayPosts.length;
    const postsToRender = displayPosts.slice(0, window.feedRenderLimit);
    
    window.renderPostList(feed, postsToRender, 'main', window.currentFilter);

    // Clean up any existing loaders or catchup messages first
    feed.querySelectorAll('.sentinel-loader, .end-message-catchup').forEach(el => el.remove());

    if (window.feedRenderLimit < window.filteredPostsLength || window.hasMorePosts) {
        const sentinel = document.createElement('div');
        sentinel.className = 'sentinel-loader w-full flex items-center justify-center text-blue-500 font-bold text-sm py-4 animate-pulse';
        sentinel.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i><span>Loading...</span>';
        feed.appendChild(sentinel);
        
        if(window.feedObserver) window.feedObserver.disconnect();
        window.feedObserver = new IntersectionObserver((entries) => {
            if(entries[0].isIntersecting) {
                if (window.feedRenderLimit < window.filteredPostsLength) {
                    window.feedRenderLimit += 15;
                    window.renderFeed(false);
                } else if (window.hasMorePosts) {
                    window.loadMorePosts();
                }
            }
        }, { rootMargin: "300px" });
        window.feedObserver.observe(sentinel);
    } else if (displayPosts.length > 0) {
        const endMessage = document.createElement('div');
        endMessage.className = 'w-full text-center text-gray-400 dark:text-gray-500 text-xs py-4 font-semibold end-message-catchup';
        endMessage.innerHTML = '<i class="fa-solid fa-check-circle mr-1"></i> You caught up! No more posts.';
        feed.appendChild(endMessage);
    }

    window.restoreInputStates(inputStates);
    if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
            el.focus();
            try {
                const saved = inputStates[activeId];
                const pos = saved ? saved.end : el.value.length;
                el.setSelectionRange(pos, pos);
            } catch(e) {}
        }
    }
    window.scrollTo(0, currentScroll);
    requestAnimationFrame(() => feed.style.minHeight = '');
    if (window.processBingoAnimations) window.processBingoAnimations();
};

window.renderProfileData = (resetLimit = true) => {
    if (!window.usersReady) {
        window._pendingPostRender = true;
        return;
    }
    if(!window.activeProfileUid) return;
    const uData = window.globalUsersCache[window.activeProfileUid] || { name: "Unknown User", pic: window.generateAvatar(window.activeProfileUid), points: 0 };
    const role = window.getRole(window.activeProfileUid);
    const isOnline = window.onlineUsers[window.activeProfileUid];
    const isBanned = uData.isBanned === true;
    
    if (resetLimit) window.profileRenderLimit = 15;

    const followerIds = uData.followers ? Object.keys(uData.followers) : [];
    const followerCount = followerIds.length;
    let followersHtml = '';
    
    if(followerCount > 0) {
        followersHtml = '<div class="flex space-x-3 overflow-x-auto py-2 scrollbar-hide">';
        followerIds.forEach(fid => {
            const fData = window.globalUsersCache[fid] || { name: "User", pic: window.generateAvatar(fid) };
            followersHtml += `<div class="shrink-0 text-center w-12"><img src="${fData.pic || window.generateAvatar(fid)}" loading="lazy" class="w-10 h-10 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 mx-auto" onclick="window.openProfile('${fid}')" title="${fData.name}"><p class="text-[9px] mt-1 text-gray-500 truncate text-center">${fData.name}</p></div>`;
        });
        followersHtml += '</div>';
    } else {
        followersHtml = '<p class="text-xs text-gray-500">No followers yet.</p>';
    }

    let followBtn = '';
    let pokeBtn = '';
    let pokeStats = `<p class="text-xs text-gray-500 mt-1"><span class="text-orange-500"><i class="fa-solid fa-hand-point-right"></i> Total Pokes Received: ${uData.totalPokes || 0}</span></p>`;

    if(window.currentUser && window.currentUser.uid !== window.activeProfileUid) {
        const isFollowing = window.globalUsersCache[window.currentUser.uid]?.following?.[window.activeProfileUid];
        followBtn = `<button onclick="window.toggleFollow('${window.activeProfileUid}')" class="mt-3 ${isFollowing ? 'bg-gray-200 text-gray-600 dark:bg-slate-700 dark:text-gray-300' : 'bg-blue-600 text-white'} text-xs font-bold px-5 py-1.5 rounded-full transition shadow-sm">${isFollowing ? 'Following' : 'Follow'}</button>`;
        
        pokeBtn = `<button onclick="window.pokeUser('${window.activeProfileUid}')" class="mt-3 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-800 text-xs font-bold px-5 py-1.5 rounded-full transition shadow-sm ml-2 hover:bg-orange-200 dark:hover:bg-orange-800"><i class="fa-solid fa-hand-point-right"></i> Poke</button>`;
        pokeStats += `<p id="personal-poke-stats" class="text-[10px] text-gray-400 mt-0.5">Loading your pokes...</p>`;
        
        get(ref(db, `users/${window.activeProfileUid}/pokesFrom/${window.currentUser.uid}`)).then(snap => {
            const d = snap.val();
            const pokedToday = d && d.lastPokedDate === new Date().toLocaleDateString();
            const used = pokedToday ? Number(d.count || 0) : 0;
            const limit = Number(window.siteSettings.pokeLimit ?? 3);
            const el = document.getElementById('personal-poke-stats');
            if(el) el.innerHTML = `Poked today: <span class="font-bold text-orange-400">${used}${limit > 0 ? ' / ' + limit : ''}</span>`;
        }).catch(err => console.error("Error fetching pokes:", err));
    }

    const genderBadge = (uData.gender && uData.gender !== "Prefer not to say") ? `<span class="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800/50 text-[9px] px-2 py-0.5 rounded-full font-bold ml-2 shadow-sm"><i class="fa-solid fa-venus-mars mr-1"></i>${uData.gender}</span>` : '';
    
    let relStr = '';
    if(uData.relationship && uData.relationship !== "Prefer not to say") {
        const partnerStr = uData.partner ? ` with <span class="font-bold text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-red-500">${uData.partner}</span>` : '';
        relStr = `<div class="mt-2 bg-pink-50 dark:bg-pink-900/20 px-3 py-1 rounded-full border border-pink-100 dark:border-pink-800/30 text-xs text-gray-700 dark:text-gray-200 inline-flex items-center shadow-sm"><i class="fa-solid fa-heart text-pink-500 mr-1.5 animate-pulse"></i><span>${uData.relationship}${partnerStr}</span></div>`;
    }

    document.getElementById('profile-header').innerHTML = `
        <div class="flex flex-col items-center bg-white dark:bg-slate-800 p-5 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700 relative">
            <button onclick="window.copyProfileLink('${window.activeProfileUid}')" class="absolute top-4 right-4 text-gray-400 hover:text-blue-500 transition bg-gray-50 dark:bg-slate-900 rounded-full w-8 h-8 flex items-center justify-center border border-gray-100 dark:border-slate-700 shadow-sm"><i class="fa-solid fa-share"></i></button>
            
            <div class="relative mt-2">
                <img src="${uData.pic || window.generateAvatar(window.activeProfileUid)}" loading="lazy" class="w-20 h-20 rounded-full object-cover border-4 ${isBanned ? 'border-red-500 grayscale' : 'border-gray-50 dark:border-slate-700'}">
                <div class="absolute bottom-1 right-1 w-4 h-4 rounded-full border-2 border-white dark:border-slate-800 ${isOnline ? 'bg-green-500' : 'bg-gray-400'}"></div>
            </div>
            
            <div class="flex items-center mt-3 justify-center flex-wrap">
                <h2 class="text-xl font-bold dark:text-white flex items-center">${uData.name}</h2>
                ${role.badgeHtml} ${genderBadge}
            </div>
            
            ${isBanned ? '<span class="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase mt-1">Banned</span>' : ''}
            <p class="text-sm text-gray-500 mt-1"><span class="text-yellow-500">⭐ ${uData.points || 0}</span> • <span class="text-yellow-600 dark:text-yellow-500 ml-1">🏆 ${uData.lbPoints || 0}</span> • <span class="text-blue-500">👥 ${followerCount}</span> Followers</p>
            ${pokeStats}
            
            ${uData.bio ? `<div class="mt-2 w-fit mx-auto px-3 py-2 rounded-lg bg-gray-50 dark:bg-slate-900/60 border-l-2 border-blue-400 dark:border-blue-500 text-[0.9rem] text-gray-600 dark:text-gray-300 italic text-center shadow-inner" style="line-height: 0.9;"><i class="fa-solid fa-quote-left text-blue-300 dark:text-blue-600 mr-1 text-[9px]"></i>${uData.bio}<i class="fa-solid fa-quote-right text-blue-300 dark:text-blue-600 ml-1 text-[9px]"></i></div>` : ''}
            
            ${relStr}
            <div class="flex items-center justify-center">
                ${followBtn}
                ${pokeBtn}
            </div>
        </div>
        <div class="mt-4 bg-white dark:bg-slate-800 p-3 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700">
            <h3 class="text-xs font-bold text-gray-500 uppercase mb-1">Followers (${followerCount})</h3>
            ${followersHtml}
        </div>
        ${(uData.galleryImages && uData.galleryImages.filter(u => u).length > 0) ? `
        <div class="mt-4 bg-white dark:bg-slate-800 p-3 rounded-xl shadow-sm border border-gray-200 dark:border-slate-700">
            <h3 class="text-xs font-bold text-gray-500 uppercase mb-2"><i class="fa-solid fa-images text-blue-500 mr-1"></i> Photos</h3>
            <div class="flex gap-2">
                ${uData.galleryImages.filter(u => u).slice(0,4).map(imgUrl => `
                    <div class="flex-1 min-w-0 rounded-lg overflow-hidden border border-gray-100 dark:border-slate-700 cursor-pointer hover:opacity-90 transition" style="height:120px" onclick="window.viewImage('${imgUrl}')">
                        <img src="${imgUrl}" loading="lazy" class="w-full h-full object-cover">
                    </div>
                `).join('')}
            </div>
        </div>` : ''}
    `;

    const profPostsFilter = document.getElementById('profile-posts-filter')?.value || 'All';
    const pFeed = document.getElementById('profile-feed');
    // Merge profile pinned posts into the display pool
    const mergedMap = new Map();
    window.allPosts.forEach(p => mergedMap.set(p.id, p));
    window.profilePinnedPosts.filter(p => p.authorId === window.activeProfileUid).forEach(p => mergedMap.set(p.id, p));
    const mergedPosts = Array.from(mergedMap.values());
    
    let pPosts = mergedPosts.filter(p => {
        if (p.authorId !== window.activeProfileUid) return false;
        
        // ==========================================
        // V6.1 & V6.2: PROFILE VISIBILITY FILTERING
        // ==========================================
        if (p.visibility === 'private') {
            if (!window.currentUser) return false; 
            
            const myRole = window.getRole(window.currentUser.uid).level;
            
            if (myRole !== 3 && p.authorId !== window.currentUser.uid) { 
                const myData = window.globalUsersCache[window.currentUser.uid];
                if (!myData || !myData.name) return false;
                
                const mentionStr = `@${myData.name}`.toLowerCase();
                const postText = (p.text || '').toLowerCase();
                
                const authorRole = window.getRole(p.authorId).level;
                const hasEveryone = postText.includes('@everyone') && authorRole >= 2;
                
                if (!postText.includes(mentionStr) && !hasEveryone) return false;
            }
        }
        return true;
    });
    
    pPosts.sort((a, b) => { 
        const pinA = window.isPostPinned(a, 'profile');
        const pinB = window.isPostPinned(b, 'profile');
        if (pinA !== pinB) return pinA ? -1 : 1;
        const tsA = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp || 0);
        const tsB = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp || 0);
        return tsB - tsA;
    });

    const currentScroll = window.scrollY;
    const activeId = document.activeElement ? document.activeElement.id : null;
    const inputStates = window.saveInputStates();
    pFeed.style.minHeight = pFeed.clientHeight + 'px';

    if(pPosts.length === 0 && !window.hasMorePosts) {
        pFeed.innerHTML = `<p class="text-center text-gray-500 text-xs py-5">No posts yet.</p>`;
        pFeed.style.minHeight = '';
        return;
    }

    const postsToRender = pPosts.slice(0, window.profileRenderLimit);
    window.renderPostList(pFeed, postsToRender, 'profile', 'profile');

    // Clean up any existing loaders or catchup messages first
    pFeed.querySelectorAll('.sentinel-loader, .end-message-catchup').forEach(el => el.remove());

    if (window.profileRenderLimit < pPosts.length || window.hasMorePosts) {
        const sentinel = document.createElement('div');
        sentinel.className = 'sentinel-loader w-full flex items-center justify-center text-blue-500 font-bold text-sm py-4 animate-pulse';
        sentinel.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i><span>Loading...</span>';
        pFeed.appendChild(sentinel);
        
        if(window.profileObserver) window.profileObserver.disconnect();
        window.profileObserver = new IntersectionObserver((entries) => {
            if(entries[0].isIntersecting) {
                if (window.profileRenderLimit < pPosts.length) {
                    window.profileRenderLimit += 15;
                    window.renderProfileData(false);
                } else if (window.hasMorePosts) {
                    window.loadMorePosts();
                }
            }
        }, { rootMargin: "300px" });
        window.profileObserver.observe(sentinel);
    } else if (pPosts.length > 0) {
        const endMessage = document.createElement('div');
        endMessage.className = 'w-full text-center text-gray-400 dark:text-gray-500 text-xs py-4 font-semibold end-message-catchup';
        endMessage.innerHTML = '<i class="fa-solid fa-check-circle mr-1"></i> You caught up! No more posts.';
        pFeed.appendChild(endMessage);
    }

    window.restoreInputStates(inputStates);
    if (activeId) {
        const el = document.getElementById(activeId);
        if (el) {
            el.focus();
            try {
                const saved = inputStates[activeId];
                const pos = saved ? saved.end : el.value.length;
                el.setSelectionRange(pos, pos);
            } catch(e) {}
        }
    }
    window.scrollTo(0, currentScroll);
    requestAnimationFrame(() => pFeed.style.minHeight = '');
    if (window.processBingoAnimations) window.processBingoAnimations();
};

window.generatePostHTML = function(post, prefix, filterContext) {
    const displayAuthorId = post.isRepost ? post.originalAuthorId : post.authorId;
    const authorInfo = window.globalUsersCache[displayAuthorId] || { name: "Unknown", pic: window.generateAvatar(displayAuthorId), points: 0 };
    const roleData = window.getRole(displayAuthorId);
    const followerCount = authorInfo.followers ? Object.keys(authorInfo.followers).length : 0; 
    
    let repostBanner = '';
    if (post.isRepost) {
        const reposter = window.globalUsersCache[post.authorId] || { name: 'Someone' };
        repostBanner = `<div class="flex items-center space-x-1 text-xs text-gray-500 mb-2 font-medium">
            <i class="fa-solid fa-retweet"></i>
            <span>Reposted by ${reposter.name}</span>
        </div>`;
    }
    
    let timeStr = 'Just now';
    if (post.timestamp) {
        const ts = post.timestamp?.toMillis ? post.timestamp.toMillis() : post.timestamp;
        const d = new Date(ts);
        timeStr = d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' at ' + d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    }

    const isBannedAuthor = authorInfo.isBanned === true;
    const effectivelyPinned = window.isPostPinned(post, filterContext);
    const isGamePost = post.isGame || post.category === 'Games';
    const myRole = window.currentUser ? window.getRole(window.currentUser.uid).level : 0;
    const isAuthorOfPost = window.currentUser && window.currentUser.uid === post.authorId;
    // Mods (level 2) cannot bypass the lock on Game posts; only Admin (level 3) or the author can
    const canBypassLock = isAuthorOfPost || (isGamePost ? myRole >= 3 : myRole >= 2);
    const canComment = !post.locked || (window.currentUser && canBypassLock);

    const rxColors = { like: "text-blue-500 bg-blue-50 dark:bg-blue-900/30", heart: "text-pink-500 bg-pink-50 dark:bg-pink-900/30", haha: "text-orange-500 bg-orange-50 dark:bg-orange-900/30", wow: "text-yellow-500 bg-yellow-50 dark:bg-yellow-900/30", sad: "text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30", angry: "text-red-500 bg-red-50 dark:bg-red-900/30" };
    const rxHover = { like: "hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20", heart: "hover:text-pink-500 hover:bg-pink-50 dark:hover:bg-pink-900/20", haha: "hover:text-orange-500 hover:bg-orange-50 dark:hover:bg-orange-900/20", wow: "hover:text-yellow-500 hover:bg-yellow-50 dark:hover:bg-yellow-900/20", sad: "hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/20", angry: "hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20" };

    const getRxColor = (type) => rxColors[type] || "text-emerald-500 bg-emerald-50 dark:bg-emerald-900/30";
    const getRxHover = (type) => rxHover[type] || "hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20";
    
    const defaultIcons = {
        like: '<i class="fa-solid fa-thumbs-up"></i>',
        heart: '<i class="fa-solid fa-heart"></i>',
        haha: '<i class="fa-solid fa-face-laugh-squint"></i>',
        wow: '<i class="fa-solid fa-face-surprise"></i>',
        sad: '<i class="fa-solid fa-face-sad-cry"></i>',
        angry: '<i class="fa-solid fa-face-angry"></i>'
    };
    
    const getRxIcon = (type) => defaultIcons[type] || `<span>${type}</span>`;

    const generatePostReactionsUI = () => {
        const rx = post.reactions || {};
        const activeReactions = Object.keys(rx).map(type => ({
            type,
            count: Object.keys(rx[type]).length,
            hasReacted: window.currentUser && rx[type][window.currentUser.uid]
        })).filter(r => r.count > 0).sort((a, b) => b.count - a.count);
        
        let activeHtml = '';
        activeReactions.forEach(r => {
            const baseClass = "flex items-center space-x-1 transition shrink-0 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50";
            activeHtml += `<button onclick="window.react('${post.id}', '${post.authorId}', '${r.type}')" class="${baseClass} ${r.hasReacted ? getRxColor(r.type) : `text-gray-500 bg-gray-50 dark:bg-slate-900 ${getRxHover(r.type)}`}">
                ${getRxIcon(r.type)} <span>${r.count}</span>
            </button>`;
        });

        const triggerHtml = `
            <div class="relative group/rx flex shrink-0">
                <button class="flex items-center space-x-1 transition shrink-0 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 text-gray-500 bg-gray-50 dark:bg-slate-900 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer">
                    <i class="fa-regular fa-thumbs-up"></i>
                </button>
                <div class="absolute bottom-full left-0 mb-1 invisible opacity-0 flex group-hover/rx:visible group-hover/rx:opacity-100 transition-all duration-300 delay-300 group-hover/rx:delay-0 items-center space-x-1.5 bg-white dark:bg-slate-800 p-1.5 rounded-full shadow-lg border border-gray-100 dark:border-slate-700 z-50">
                    ${['like', 'heart', 'haha', 'wow', 'sad', 'angry'].map(t => `
                        <button onclick="window.react('${post.id}', '${post.authorId}', '${t}')" class="w-8 h-8 rounded-full flex items-center justify-center text-lg ${getRxHover(t)} hover:scale-110 transition-transform ${rxColors[t] && (rx[t] && rx[t][window.currentUser?.uid]) ? getRxColor(t) : 'text-gray-500'}">
                            ${getRxIcon(t)}
                        </button>
                    `).join('')}
                    <button onclick="window.promptCustomReaction('${post.id}', '${post.authorId}')" class="w-8 h-8 rounded-full flex items-center justify-center text-lg text-gray-500 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:scale-110 transition-transform bg-gray-50 dark:bg-slate-900 border border-gray-100 dark:border-slate-700">
                        <i class="fa-solid fa-plus text-sm"></i>
                    </button>
                </div>
            </div>
        `;
        return { triggerHtml, activeHtml };
    };
    
    const generateCommentReactionsUI = (c, cId) => {
        const cRx = c.reactions || {};
        const activeReactions = Object.keys(cRx).map(type => ({
            type,
            count: Object.keys(cRx[type]).length,
            hasReacted: window.currentUser && cRx[type][window.currentUser.uid]
        })).filter(r => r.count > 0).sort((a, b) => b.count - a.count);
        
        let activeHtml = '';
        activeReactions.forEach(r => {
            const baseClass = "flex items-center space-x-1 transition shrink-0 px-1.5 py-0.5 rounded-full border border-gray-200 dark:border-slate-600/50 text-[10px]";
            activeHtml += `<button onclick="window.reactComment('${post.id}', '${cId}', '${c.uid}', '${r.type}')" class="${baseClass} ${r.hasReacted ? getRxColor(r.type) : `text-gray-400 bg-white dark:bg-slate-800 ${getRxHover(r.type)}`}">
                ${getRxIcon(r.type)} <span>${r.count}</span>
            </button>`;
        });

        const triggerHtml = `
            <div class="relative group/rx flex shrink-0">
                <button class="flex items-center space-x-1 transition shrink-0 px-1.5 py-0.5 rounded-full border border-gray-200 dark:border-slate-600/50 text-[10px] text-gray-400 bg-white dark:bg-slate-800 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 font-bold cursor-pointer">
                    <i class="fa-regular fa-thumbs-up"></i>
                </button>
                <div class="absolute bottom-full left-0 mb-1 invisible opacity-0 flex group-hover/rx:visible group-hover/rx:opacity-100 transition-all duration-300 delay-300 group-hover/rx:delay-0 items-center space-x-1 bg-white dark:bg-slate-800 p-1 rounded-full shadow-lg border border-gray-100 dark:border-slate-700 z-50">
                    ${['like', 'heart', 'haha', 'wow', 'sad', 'angry'].map(t => `
                        <button onclick="window.reactComment('${post.id}', '${cId}', '${c.uid}', '${t}')" class="w-6 h-6 rounded-full flex items-center justify-center text-[11px] ${getRxHover(t)} hover:scale-110 transition-transform ${rxColors[t] && (cRx[t] && cRx[t][window.currentUser?.uid]) ? getRxColor(t) : 'text-gray-500'}">
                            ${getRxIcon(t)}
                        </button>
                    `).join('')}
                    <button onclick="window.promptCustomReaction('${post.id}', '${post.authorId}', '${cId}', '${c.uid}')" class="w-6 h-6 rounded-full flex items-center justify-center text-[10px] text-gray-500 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 hover:scale-110 transition-transform bg-gray-50 dark:bg-slate-900 border border-gray-100 dark:border-slate-700">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </div>
        `;
        return { triggerHtml, activeHtml };
    };

    const generateReplyReactionsUI = (r, cId, rId) => {
        const rRx = r.reactions || {};
        const activeReactions = Object.keys(rRx).map(type => ({
            type,
            count: Object.keys(rRx[type]).length,
            hasReacted: window.currentUser && rRx[type][window.currentUser.uid]
        })).filter(rx => rx.count > 0).sort((a, b) => b.count - a.count);
        
        let activeHtml = '';
        activeReactions.forEach(rx => {
            const baseClass = "flex items-center space-x-1 transition shrink-0 px-1 py-0.5 rounded border border-gray-200 dark:border-slate-600/50 text-[9px]";
            activeHtml += `<button onclick="window.reactReply('${post.id}', '${cId}', '${rId}', '${r.uid}', '${rx.type}')" class="${baseClass} ${rx.hasReacted ? getRxColor(rx.type) : `text-gray-400 bg-white dark:bg-slate-800 ${getRxHover(rx.type)}`}">
                ${getRxIcon(rx.type)} <span>${rx.count}</span>
            </button>`;
        });

        const triggerHtml = `
            <div class="relative group/rx flex shrink-0">
                <button class="flex items-center space-x-1 transition shrink-0 px-1 py-0.5 rounded border border-gray-200 dark:border-slate-600/50 text-[9px] text-gray-400 bg-white dark:bg-slate-800 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 font-bold cursor-pointer">
                    <i class="fa-regular fa-thumbs-up"></i>
                </button>
                <div class="absolute bottom-full left-0 mb-1 invisible opacity-0 flex group-hover/rx:visible group-hover/rx:opacity-100 transition-all duration-300 delay-300 group-hover/rx:delay-0 items-center space-x-1 bg-white dark:bg-slate-800 p-1 rounded-full shadow-lg border border-gray-100 dark:border-slate-700 z-50">
                    ${['like', 'heart', 'haha', 'wow', 'sad', 'angry'].map(t => `
                        <button onclick="window.reactReply('${post.id}', '${cId}', '${rId}', '${r.uid}', '${t}')" class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${getRxHover(t)} hover:scale-110 transition-transform ${rxColors[t] && (rRx[t] && rRx[t][window.currentUser?.uid]) ? getRxColor(t) : 'text-gray-500'}">
                            ${getRxIcon(t)}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
        return { triggerHtml, activeHtml };
    };

    const commentsObj = post.comments || {};
    let commentsArray = Object.keys(commentsObj).map(key => ({ id: key, ...commentsObj[key] }));
    let commentCount = 0;
    commentsArray.forEach(c => {
        commentCount++;
        if (c.replies) commentCount += Object.keys(c.replies).length;
    });

    let sortMode = window.commentSortState[post.id] || 'oldest';
    commentsArray.sort((a, b) => sortMode === 'newest' ? (b.timestamp || 0) - (a.timestamp || 0) : (a.timestamp || 0) - (b.timestamp || 0));

    let commentsHtml = '';
    if (commentCount > 0) {
        commentsHtml += `
            <div class="flex justify-between items-center mt-2 mb-2 pb-1.5 border-b border-gray-100 dark:border-slate-700/50">
                <span class="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Comments</span>
                ${commentsArray.length > 1 ? `<button onclick="window.toggleCommentSort('${post.id}')" class="text-[9px] text-gray-500 hover:text-blue-500 flex items-center transition bg-gray-50 dark:bg-slate-900 px-2 py-1 rounded shadow-sm border border-gray-200 dark:border-slate-700"><i class="fa-solid ${sortMode === 'newest' ? 'fa-arrow-down-wide-short' : 'fa-arrow-up-wide-short'} mr-1.5"></i> ${sortMode === 'newest' ? 'Newest' : 'Oldest'}</button>` : ''}
            </div>
        `;
    }
    
    commentsArray.forEach(c => {
        const cId = c.id;
        let cAuth = window.globalUsersCache[c.uid] || { name: "Unknown", pic: window.generateAvatar(c.uid) };
        
        let repliesHtml = '';
        let repliesArr = [];
        if(c.replies) {
            repliesArr = Object.keys(c.replies).map(rId => ({ id: rId, ...c.replies[rId] }));
            repliesArr.sort((a,b) => (a.timestamp || 0) - (b.timestamp || 0)); 

            repliesArr.forEach(r => {
                const rId = r.id;
                let rAuth = window.globalUsersCache[r.uid] || { name: "Unknown", pic: window.generateAvatar(r.uid) };
                const safeReplyText = window.formatText(r.text);

                repliesHtml += `
                    <div class="flex items-start space-x-2 mt-2 ml-6 reply-line pl-2 relative group">
                        <img src="${rAuth.pic || window.generateAvatar(r.uid)}" loading="lazy" class="w-5 h-5 rounded-full object-cover cursor-pointer hover:opacity-80 transition" onclick="window.openProfile('${r.uid}')">
                        <div class="flex-1 bg-gray-50 dark:bg-slate-900/50 p-1.5 rounded-lg border border-gray-100 dark:border-slate-800 text-xs w-full overflow-hidden">
                            <div class="flex justify-between items-start">
                                <p class="font-bold text-gray-700 dark:text-gray-300 text-[10px] cursor-pointer hover:underline flex items-center" onclick="window.openProfile('${r.uid}')">
                                    ${rAuth.name} ${window.getRole(r.uid).badgeHtml} <span class="text-gray-400 font-normal ml-1">· ${window.timeAgo(r.timestamp)}</span>
                                </p>
                                <div class="flex items-center space-x-2">
                                    ${r.uid === window.currentUser?.uid ? `<button onclick="window.editReply('${post.id}', '${cId}', '${rId}')" class="text-[9px] text-blue-400 hidden group-hover:block"><i class="fa-solid fa-pen"></i></button>` : ''}
                                    ${window.canDelete(r.uid) ? `<button onclick="window.deleteItem('community_posts/${post.id}/comments/${cId}/replies/${rId}', '${r.uid}')" class="text-[9px] text-red-400 hidden group-hover:block"><i class="fa-solid fa-trash"></i></button>` : ''}
                                </div>
                            </div>
                            <p class="text-gray-800 dark:text-gray-200 mt-0.5 break-words text-[11px] leading-tight">${safeReplyText} ${r.edited ? '<span class="text-[9px] italic text-gray-400 ml-1 font-normal">(edited)</span>' : ''}</p>
                            ${window.generateEmbed(r.text)}
                            <div class="flex items-center mt-1 space-x-2">
                                <div class="flex items-center space-x-1 shrink-0">
                                    ${(() => { const ui = generateReplyReactionsUI(r, cId, rId); return ui.triggerHtml; })()}
                                </div>
                                <div class="flex-1 flex items-center space-x-1 overflow-x-auto scrollbar-hide">
                                    ${(() => { const ui = generateReplyReactionsUI(r, cId, rId); return ui.activeHtml; })()}
                                </div>
                                ${canComment ? `<button onclick="window.prepareReplyToReply('${cId}', '${prefix}', '${r.uid}')" class="text-[9px] text-gray-400 hover:text-blue-500 font-bold transition ml-auto">Reply</button>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            });
        }

        const safeCommentText = window.formatText(c.text);
        const isReplyBoxOpen = window.openReplies.has(cId);
        const isRepliesListOpen = window.openRepliesList.has(cId);

        let repliesToggleBtn = '';
        if(repliesArr.length > 0) {
            repliesToggleBtn = `<button onclick="window.toggleRepliesList('${cId}', '${prefix}')" class="text-[10px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition ml-8 mt-2 flex items-center space-x-1.5 shrink-0"><i class="fa-solid fa-reply text-xs"></i> <span>${repliesArr.length} ${repliesArr.length === 1 ? 'Reply' : 'Replies'}</span></button>`;
        }

        commentsHtml += `
            <div class="mt-2 relative group">
                <div class="flex items-start space-x-2">
                    <img src="${cAuth.pic || window.generateAvatar(c.uid)}" loading="lazy" class="w-6 h-6 rounded-full object-cover cursor-pointer hover:opacity-80 transition" onclick="window.openProfile('${c.uid}')">
                    <div class="flex-1 bg-gray-50 dark:bg-slate-900 p-2 rounded-lg border border-gray-100 dark:border-slate-700/50 text-xs w-full overflow-hidden">
                        <div class="flex justify-between items-start">
                            <p class="font-bold text-gray-700 dark:text-gray-300 text-[11px] cursor-pointer hover:underline flex items-center" onclick="window.openProfile('${c.uid}')">
                                ${cAuth.name} ${window.getRole(c.uid).badgeHtml} <span class="text-gray-400 font-normal ml-1">· ${window.timeAgo(c.timestamp)}</span>
                            </p>
                            <div class="flex items-center space-x-2">
                                ${c.uid === window.currentUser?.uid ? `<button onclick="window.editComment('${post.id}', '${cId}')" class="text-[10px] text-blue-400 hidden group-hover:block"><i class="fa-solid fa-pen"></i></button>` : ''}
                                ${window.canDelete(c.uid) ? `<button onclick="window.deleteItem('community_posts/${post.id}/comments/${cId}', '${c.uid}')" class="text-[10px] text-red-400 hidden group-hover:block"><i class="fa-solid fa-trash"></i></button>` : ''}
                            </div>
                        </div>
                        <p class="text-gray-800 dark:text-gray-200 mt-0.5 break-words text-xs">${safeCommentText} ${c.edited ? '<span class="text-[9px] italic text-gray-400 ml-1 font-normal">(edited)</span>' : ''}</p>
                        ${window.generateEmbed(c.text)}
                        ${c.image ? `<img src="${c.image}" loading="lazy" class="w-full rounded-lg mt-2 object-cover max-h-60 border border-gray-200 dark:border-slate-600 shadow-sm cursor-pointer hover:opacity-90 transition" onclick="window.viewImage('${c.image}')">` : ''}
                        
                        <div class="flex items-center justify-between mt-1.5 py-0.5">
                            <div class="flex items-center space-x-1 shrink-0">
                                <button onclick="window.showReactors('${post.id}', '${cId}')" class="flex items-center space-x-1 transition shrink-0 px-1.5 py-0.5 rounded-full border border-gray-200 dark:border-slate-600/50 text-[10px] text-gray-400 bg-white dark:bg-slate-800 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                                    <i class="fa-solid fa-users"></i>
                                </button>
                                ${(() => { const ui = generateCommentReactionsUI(c, cId); return ui.triggerHtml; })()}
                            </div>
                            <div class="flex-1 flex items-center space-x-1 overflow-x-auto scrollbar-hide mx-1 px-1">
                                ${(() => { const ui = generateCommentReactionsUI(c, cId); return ui.activeHtml; })()}
                            </div>
                            <div class="flex items-center shrink-0 ml-auto">
                                ${canComment ? `<button onclick="window.toggleReplyBox('${cId}', '${prefix}')" class="text-[10px] text-gray-500 hover:text-blue-500 font-semibold px-2">Reply</button>` : ''}
                            </div>
                        </div>
                    </div>
                </div>
                
                ${canComment ? `
                <div id="reply-box-${prefix}-${cId}" class="${isReplyBoxOpen ? 'flex' : 'hidden'} ml-8 mt-1 space-x-1">
                    <input type="text" id="reply-input-${prefix}-${cId}" class="flex-1 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded text-[10px] px-2 py-1 focus:outline-none dark:text-white" placeholder="Reply or @mention...">
                    <button onclick="window.submitReply('${post.id}', '${cId}', '${prefix}', '${c.uid}')" class="bg-blue-600 text-white px-2 py-1 rounded text-[10px]"><i class="fa-solid fa-paper-plane"></i></button>
                </div>
                ` : ''}
                
                ${repliesToggleBtn}
                
                <div id="replies-list-${prefix}-${cId}" class="${isRepliesListOpen ? '' : 'hidden'}">
                    ${repliesHtml}
                </div>
            </div>
        `;
    });

    let commentInputBox = '';
    if (canComment) {
        commentInputBox = `
            <div class="flex mt-3 items-center space-x-1.5 bg-gray-50 dark:bg-slate-900/50 p-1.5 rounded-lg border border-gray-200 dark:border-slate-700">
                <label class="cursor-pointer text-gray-400 hover:text-blue-500 transition p-1 shrink-0" title="Upload Image">
                    <i class="fa-solid fa-camera"></i>
                    <input type="file" id="comment-image-${prefix}-${post.id}" accept="image/*" class="hidden" onchange="document.getElementById('comment-img-name-${prefix}-${post.id}').innerText = this.files[0] ? this.files[0].name : ''">
                </label>
                <div class="flex-1 flex flex-col justify-center overflow-hidden">
                    <input type="text" id="comment-input-${prefix}-${post.id}" class="w-full bg-transparent text-xs px-1 py-1 focus:outline-none dark:text-white" placeholder="Write a comment...">
                    <span id="comment-img-name-${prefix}-${post.id}" class="text-[9px] text-blue-500 truncate px-1 font-bold"></span>
                </div>
                <button id="comment-submit-btn-${prefix}-${post.id}" onclick="window.submitComment('${post.id}', '${post.authorId}', '${prefix}')" class="bg-blue-600 hover:bg-blue-500 text-white rounded px-3 py-1.5 text-xs font-bold shrink-0 shadow-sm transition">Send</button>
            </div>
        `;
    } else {
        commentInputBox = `<div class="mt-3 text-center text-[11px] text-gray-500 font-semibold bg-gray-50 dark:bg-slate-900/50 py-2 rounded-lg border border-gray-100 dark:border-slate-800"><i class="fa-solid fa-lock text-orange-500 mr-1"></i> Comments locked by author</div>`;
    }

    const postEl = document.createElement('div');
    postEl.id = `post-${prefix}-${post.id}`;
    postEl.className = `bg-white dark:bg-slate-800 rounded-xl p-3 shadow-sm border ${effectivelyPinned ? 'border-l-4 border-l-green-500 border-y-0 border-r-0' : 'border-gray-100 dark:border-slate-700'} relative mb-3`;
    
    let adminControls = '';
    if(window.currentUser) {
        if(window.getRole(window.currentUser.uid).level >= 2 || window.currentUser.uid === post.authorId) {
            const isProfilePinned = (window.profilePinnedPosts || []).some(p => p.id === post.id);
            const isFeedPinned = (window.globalPinnedPosts || []).some(p => p.id === post.id);
            const isAnyPinned = isProfilePinned || isFeedPinned;
            adminControls += `<button onclick="window.openPinModal('${post.id}', ${isProfilePinned}, ${isFeedPinned}, '${post.authorId}')" class="text-gray-400 hover:text-green-500 mr-2 text-xs" title="Pin Post Options"><i class="fa-solid fa-thumbtack ${isAnyPinned ? 'text-green-500' : ''}"></i></button>`;
        }
        
        const isGamePostUI = post.isGame || post.category === 'Games';
        const myRoleLevelUI = window.getRole(window.currentUser.uid).level;
        const canToggleLock = window.currentUser.uid === post.authorId || myRoleLevelUI >= 3 || (myRoleLevelUI >= 2 && !isGamePostUI);
        const isEndedGame = isGamePostUI && post.gameStatus === 'ended';
        
        if (canToggleLock) {
            adminControls += `<button onclick="window.toggleLock('${post.id}', ${post.locked})" class="text-gray-400 hover:text-orange-500 mr-2 text-xs" title="${post.locked ? 'Unlock Comments' : 'Lock Comments'}"><i class="fa-solid ${post.locked ? 'fa-lock text-orange-500' : 'fa-lock-open'}"></i></button>`;
        }

        if(window.currentUser.uid === post.authorId && !post.isRepost && !isEndedGame) {
            const isPriv = post.visibility === 'private';
            adminControls += `<button onclick="window.togglePostVisibility('${post.id}', '${post.visibility || 'public'}')" class="text-gray-400 hover:text-blue-500 mr-2 text-xs" title="${isPriv ? 'Make Public' : 'Make Private'}"><i class="fa-solid ${isPriv ? 'fa-eye-slash' : 'fa-eye'}"></i></button>`;
            adminControls += `<button onclick="window.editPost('${post.id}')" class="text-gray-400 hover:text-blue-500 mr-2 text-xs"><i class="fa-solid fa-pen"></i></button>`;
        }
        
        if(window.canDelete(post.authorId)) {
            // Freeze deletion by host if game is ended, unless they are an admin
            if (!(isEndedGame && window.currentUser.uid === post.authorId && myRoleLevelUI < 3)) {
                adminControls += `<button onclick="window.deleteItem('community_posts/${post.id}', '${post.authorId}')" class="text-gray-400 hover:text-red-500 text-xs"><i class="fa-solid fa-trash"></i></button>`;
            }
        }
    }

    const isCommentsOpen = window.openComments.has(post.id);
    const safePostText = window.formatText(post.text);

    
    const visibilityIcon = post.visibility === 'private'
        ? `<i class="fa-solid fa-eye-slash text-[10px] text-gray-400 ml-2" title="Private Post"></i>`
        : `<i class="fa-solid fa-eye text-[10px] text-blue-500 ml-2" title="Public Post"></i>`;

    let gameHtml = '';
    if (post.isRepostedGame && post.isRepost) {
        // This is a reshared game — show a link card to the original game
        const origId = post.originalPostId;
        const origAuthorName = window.globalUsersCache[post.originalAuthorId]?.name || 'the host';
        gameHtml = `
            <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-purple-50 dark:from-slate-800 dark:to-slate-900 rounded-xl border-2 border-blue-200 dark:border-blue-800 flex flex-col items-center text-center">
                <div class="text-3xl mb-2">🎮</div>
                <p class="font-bold text-sm text-blue-800 dark:text-blue-200 mb-1">Game shared by ${origAuthorName}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">Join the original game to participate!</p>
                <button onclick="window.goToPost('${origId}')" class="bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-full shadow transition text-sm">
                    <i class="fa-solid fa-gamepad mr-2"></i>View Game
                </button>
            </div>`;
    } else if (post.isGame) {
        const badges = [];

        // 1. Gift Icon: Prize Amount (PHP)
        let numPrize = 0;
        let isLegacyTextPrize = false;
        if (post.gamePrize !== undefined && post.gamePrize !== null && post.gamePrize !== '') {
            if (typeof post.gamePrize === 'number') {
                numPrize = post.gamePrize;
            } else {
                const str = String(post.gamePrize).trim();
                const parsed = parseFloat(str.replace(/^PHP\s*/i, ''));
                if (!isNaN(parsed) && parsed > 0 && (str === String(parsed) || str.toUpperCase() === `PHP ${parsed}` || str.toUpperCase() === `PHP${parsed}`)) {
                    numPrize = parsed;
                } else if (str && str !== '0') {
                    isLegacyTextPrize = true;
                }
            }
        }
        if (numPrize > 0) {
            badges.push(`<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 backdrop-blur-sm shadow-sm"><i class="fa-solid fa-gift text-emerald-500 text-xs"></i> PHP ${numPrize.toLocaleString()}</span>`);
        } else if (isLegacyTextPrize && post.gamePrize) {
            badges.push(`<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 backdrop-blur-sm shadow-sm"><i class="fa-solid fa-gift text-emerald-500 text-xs"></i> ${escapeHtml(String(post.gamePrize))}</span>`);
        }

        // 2. Trophy Icon: LB Points
        const lb = (post.gameLbPoints !== undefined && post.gameLbPoints !== null) ? Number(post.gameLbPoints) : 0;
        if (lb > 0) {
            badges.push(`<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 backdrop-blur-sm shadow-sm"><i class="fa-solid fa-trophy text-amber-500 text-xs"></i> +${lb} LB Points</span>`);
        }

        // 3. Magic Icon: Bonus Prize
        const bonus = (post.gameBonusPrize || post.gameBonus || '').trim();
        if (bonus) {
            badges.push(`<span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-purple-500/10 dark:bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/30 backdrop-blur-sm shadow-sm"><i class="fa-solid fa-wand-magic-sparkles text-purple-500 text-xs"></i> Bonus: ${escapeHtml(bonus)}</span>`);
        }

        const prizeStr = badges.length ? `<div class="flex flex-wrap items-center justify-center gap-2 mb-3">${badges.join('')}</div>` : '';
        
        if (post.gameType === 'first_to_mine') {
            if (post.gameStatus === 'active') {
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-purple-50 dark:bg-slate-800 rounded-xl border-2 border-purple-200 dark:border-purple-900/50 flex flex-col items-center">
                        ${prizeStr}
                        <button onclick="window.mineGame('${post.id}')" class="bg-purple-600 hover:bg-purple-500 text-white font-black text-xl py-3 px-10 rounded-full shadow-lg transform transition hover:scale-105 active:scale-95 animate-pulse"><i class="fa-solid fa-gem mr-2"></i>MINE!</button>
                    </div>`;
            } else {
                const winnerName = post.gameWinner ? (window.globalUsersCache[post.gameWinner]?.name || "Someone") : "No one";
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80">
                        ${prizeStr}
                        <div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} mined it first!</span></div>
                    </div>`;
            }
        } else if (post.gameType === 'last_comment') {
            let timerHtml = '';
            if (post.gameStatus === 'active') {
                if (post.gameEndTime) {
                    timerHtml = `<div class="text-center font-mono text-2xl font-black text-purple-600 dark:text-purple-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`;
                } else {
                    timerHtml = `<div class="text-center text-xs font-bold text-gray-500 mt-2 bg-gray-100 dark:bg-slate-700 px-3 py-1 rounded-full w-fit mx-auto">Waiting for host to end...</div>`;
                }
                
                const endGameBtn = (!post.gameEndTime && window.currentUser && post.authorId === window.currentUser.uid) ? `<button onclick="window.endLastCommentGame('${post.id}')" class="mt-3 bg-red-100 text-red-600 hover:bg-red-200 text-xs font-bold py-1.5 px-4 rounded-full transition w-fit mx-auto border border-red-200 shadow-sm"><i class="fa-solid fa-stop-circle mr-1"></i>End Game Now</button>` : '';

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-purple-50 dark:bg-slate-800 rounded-xl border-2 border-purple-200 dark:border-purple-900/50 flex flex-col">
                        ${prizeStr}
                        ${timerHtml}
                        ${endGameBtn}
                    </div>`;
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'none' || !post.gameWinner) {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-xmark"></i> Game forfeited! (No winners)</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || "Someone";
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} won the Last Comment!</span></div>`;
                }
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80">
                        ${prizeStr}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'challenge') {
            const targetUserName = window.globalUsersCache[post.gameTargetUser]?.name || post.gameTargetUser;
            const currentReacts = Object.keys(post.reactions || {}).reduce((sum, type) => sum + Object.keys(post.reactions[type] || {}).length, 0);
            const currentComments = Object.keys(post.comments || {}).length;

            if (post.gameStatus === 'active') {
                let timerHtml = '';
                if (post.gameEndTime) {
                    timerHtml = `<div class="text-center font-mono text-2xl font-black text-purple-600 dark:text-purple-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`;
                }

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-purple-50 dark:bg-slate-800 rounded-xl border-2 border-purple-200 dark:border-purple-900/50 flex flex-col items-center">
                        ${prizeStr}
                        <h4 class="font-bold text-sm text-gray-800 dark:text-gray-200 mb-2">Challenge for @${targetUserName}</h4>
                        <div class="flex space-x-4 mb-2 text-sm font-semibold">
                            <span class="${currentReacts >= post.gameTargetReacts ? 'text-green-500' : 'text-gray-500'}">Reacts: ${currentReacts}/${post.gameTargetReacts}</span>
                            <span class="${currentComments >= post.gameTargetComments ? 'text-green-500' : 'text-gray-500'}">Comments: ${currentComments}/${post.gameTargetComments}</span>
                        </div>
                        ${timerHtml}
                        <button onclick="window.checkChallenge('${post.id}')" class="mt-3 bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-full shadow transition"><i class="fa-solid fa-check mr-2"></i>Check Progress</button>
                    </div>`;
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'none') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-xmark"></i> @${targetUserName} failed the challenge!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-trophy text-amber-400"></i> <span>Challenge Completed by ${winnerName}!</span></div>`;
                }
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80">
                        ${prizeStr}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'quick_challenge') {
            const targetUserName = window.globalUsersCache[post.gameTargetUser]?.name || post.gameTargetUser;
            if (post.gameStatus === 'active') {
                const isTargetUser = window.currentUser && window.currentUser.uid === post.gameTargetUser;
                const qcTimer = post.gameEndTime
                    ? `<div class="text-center font-mono text-2xl font-black text-orange-600 dark:text-orange-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`
                    : `<div class="text-center text-xs font-bold text-gray-500 mt-2">No time limit</div>`;
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-orange-50 dark:bg-slate-800 rounded-xl border-2 border-orange-200 dark:border-orange-900/50 flex flex-col items-center">
                        ${prizeStr}
                        <h4 class="font-bold text-sm text-orange-800 dark:text-orange-200 mb-2">⚡ Quick Challenge for @${targetUserName}</h4>
                        ${qcTimer}
                        ${isTargetUser 
                            ? `<button onclick="window.mineGame('${post.id}')" class="mt-3 bg-orange-600 hover:bg-orange-500 text-white font-black text-xl py-3 px-10 rounded-full shadow-lg transform transition hover:scale-105 active:scale-95 animate-pulse"><i class="fa-solid fa-bolt mr-2"></i>MINE QUICK!</button>` 
                            : `<button disabled class="mt-3 bg-gray-400 text-white font-black text-xl py-3 px-10 rounded-full shadow cursor-not-allowed">Only @${targetUserName} can mine</button>`
                        }
                    </div>`;
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'none') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-xmark"></i> @${targetUserName} failed the challenge!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} mined it!</span></div>`;
                }
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80">
                        ${prizeStr}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'guess_emoji' || post.gameType === 'bring_me_emoji') {
            const isGuess = post.gameType === 'guess_emoji';
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;

            if (post.gameStatus === 'active') {
                let displayContent, gameTitle, hostHint = '', answerHint = '';

                if (isGuess) {
                    // guess_emoji: show the emoji CHAR to all (players guess its NAME)
                    displayContent = `<div class="text-5xl mb-2">${post.gameEmojiChar || '❓'}</div>`;
                    gameTitle = 'What emoji is this? Type the name!';
                    if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameEmojiName}</div>`;
                    answerHint = `<p class="text-xs text-gray-400 mt-1">Type the emoji name, e.g. "Red Apple"</p>`;
                } else {
                    // bring_me_emoji: show the NAME to all (players send the emoji CHAR)
                    // Host can see the answer emoji char
                    displayContent = `<div class="text-2xl font-bold text-blue-700 dark:text-blue-300 mb-2 text-center">${post.gameEmojiName || 'Emoji'}</div>`;
                    gameTitle = 'Find and send this emoji!';
                    if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameEmojiChar || '(no char stored)'}</div>`;
                    answerHint = `<p class="text-xs text-gray-400 mt-1">Paste or type the emoji character</p>`;
                }

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-blue-50 dark:bg-slate-800 rounded-xl border-2 border-blue-200 dark:border-blue-900/50 flex flex-col items-center">
                        ${prizeStr}
                        ${displayContent}
                        <h4 class="font-bold text-sm text-blue-800 dark:text-blue-200 mb-1">${gameTitle}</h4>
                        ${hostHint}
                        ${answerHint}
                        <button onclick="window.openAnswerModal('${post.id}')" class="mt-3 bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-full shadow transition"><i class="fa-solid fa-keyboard mr-2"></i>Answer</button>
                    </div>`;
            } else {
                const revealedChar = post.gameEmojiChar || '';
                let outcomeHtml = '';
                if (post.gameWinner === 'none') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-xmark"></i> No one guessed it!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} won!</span></div>`;
                }
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80">
                        ${prizeStr}
                        <div class="text-2xl mb-1">${revealedChar} ${post.gameEmojiName || ''}</div>
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (['flags', 'math', 'jumbled_words', 'trivia', 'periodic_table'].includes(post.gameType)) {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            let displayContent = '', gameTitle = '', hostHint = '', answerHint = '';
            let timerHtml = '';

            if (post.gameEndTime && post.gameStatus === 'active') {
                timerHtml = `<div class="text-center font-mono text-2xl font-black text-blue-600 dark:text-blue-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`;
            }

            if (post.gameType === 'flags') {
                const flagImgSrc = post.gameFlagCode ? `https://flagcdn.com/w80/${post.gameFlagCode}.png` : '';
                displayContent = flagImgSrc
                    ? `<img src="${flagImgSrc}" class="h-16 rounded shadow mb-2 border border-gray-200 dark:border-slate-600" alt="Flag">`
                    : `<div class="text-4xl mb-2">🏳️</div>`;
                gameTitle = 'What country does this flag belong to?';
                if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameFlagName}</div>`;
                answerHint = `<p class="text-xs text-gray-400 mt-1">Type the country name, e.g. "France"</p>`;
            } else if (post.gameType === 'periodic_table') {
                const isNameMode = post.gameElementGuessMode === 'name';
                if (isNameMode) {
                    displayContent = `
                        <div class="p-3 bg-gradient-to-br from-cyan-500 to-blue-600 text-white rounded-2xl shadow-md flex flex-col items-center justify-between w-24 h-24 mb-2 border-2 border-cyan-300">
                            <span class="text-[10px] font-mono font-bold opacity-80 self-start">#${post.gameElementNumber || ''}</span>
                            <span class="text-3xl font-black tracking-wider leading-none">${post.gameElementSymbol || ''}</span>
                            <span class="text-[10px] font-semibold opacity-90">?</span>
                        </div>`;
                    gameTitle = 'Guess the Element Name!';
                    answerHint = `<p class="text-xs text-gray-400 mt-1">Type the element name (e.g. "Iron", "Gold")</p>`;
                } else {
                    displayContent = `
                        <div class="p-3 bg-gradient-to-br from-cyan-500 to-blue-600 text-white rounded-2xl shadow-md flex flex-col items-center justify-between w-24 h-24 mb-2 border-2 border-cyan-300">
                            <span class="text-[10px] font-mono font-bold opacity-80 self-start">#${post.gameElementNumber || ''}</span>
                            <span class="text-2xl font-black tracking-wider leading-none">?</span>
                            <span class="text-[10px] font-bold opacity-90 text-center truncate w-full">${post.gameElementName || ''}</span>
                        </div>`;
                    gameTitle = 'Guess the Chemical Symbol!';
                    answerHint = `<p class="text-xs text-gray-400 mt-1">Type the symbol (e.g. "Fe", "Au")</p>`;
                }
                if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameElementAnswer} ([#${post.gameElementNumber}] ${post.gameElementSymbol} - ${post.gameElementName})</div>`;
            } else if (post.gameType === 'math') {
                // Only append "= ?" if the question doesn't already contain it (algebra questions include it)
                const mathDisplay = post.gameMathQuestion.includes('=') 
                    ? post.gameMathQuestion 
                    : `${post.gameMathQuestion} = ?`;
                displayContent = `<div class="text-3xl font-bold font-mono text-blue-700 dark:text-blue-300 mb-2">${mathDisplay}</div>`;
                gameTitle = 'Solve the math problem!';
                if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameMathAnswer}</div>`;
                answerHint = `<p class="text-xs text-gray-400 mt-1">Type the number</p>`;
            } else if (post.gameType === 'jumbled_words') {
                displayContent = `<div class="text-3xl font-bold tracking-widest font-mono text-blue-700 dark:text-blue-300 mb-2 text-center break-words break-all w-full">${post.gameJumbledScrambled}</div>`;
                gameTitle = 'Unscramble the word!';
                if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameJumbledOriginal}</div>`;
                answerHint = `<p class="text-xs text-gray-400 mt-1">Type the original word</p>`;
            } else if (post.gameType === 'trivia') {
                displayContent = `<div class="text-lg font-semibold text-center text-blue-800 dark:text-blue-200 mb-2 max-w-sm">${post.gameTriviaQuestion}</div>`;
                gameTitle = 'Trivia Time!';
                if (isHost) hostHint = `<div class="text-xs text-yellow-600 dark:text-yellow-400 font-bold mt-1 bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1 rounded-full">🔑 Answer: ${post.gameTriviaAnswer}</div>`;
                answerHint = `<p class="text-xs text-gray-400 mt-1">Type the answer</p>`;
            }

            if (post.gameStatus === 'active') {
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-blue-50 dark:bg-slate-800 rounded-xl border-2 border-blue-200 dark:border-blue-900/50 flex flex-col items-center">
                        ${prizeStr}
                        ${displayContent}
                        <h4 class="font-bold text-sm text-blue-800 dark:text-blue-200 mb-1">${gameTitle}</h4>
                        ${hostHint}
                        ${answerHint}
                        ${timerHtml}
                        <button onclick="window.openAnswerModal('${post.id}')" class="mt-3 bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-full shadow transition"><i class="fa-solid fa-keyboard mr-2"></i>Answer</button>
                    </div>`;
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'none') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-xmark"></i> No one got it in time!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} won!</span></div>`;
                }
                
                let answerReveal = '';
                if (post.gameType === 'flags') {
                    const flagImgSrc = post.gameFlagCode ? `https://flagcdn.com/w80/${post.gameFlagCode}.png` : '';
                    answerReveal = `<div class="flex flex-col items-center mb-1">${flagImgSrc ? `<img src="${flagImgSrc}" class="h-12 rounded shadow mb-1 border border-gray-200" alt="Flag">` : ''}<span class="font-bold">${post.gameFlagName}</span></div>`;
                }
                else if (post.gameType === 'periodic_table') {
                    answerReveal = `
                        <div class="flex flex-col items-center mb-1">
                            <div class="px-3 py-1.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-900 dark:text-cyan-200 rounded-lg font-mono font-bold text-sm mb-1 border border-cyan-300 dark:border-cyan-800">
                                [#${post.gameElementNumber}] <strong>${post.gameElementSymbol}</strong> — ${post.gameElementName}
                            </div>
                        </div>`;
                }
                else if (post.gameType === 'math') answerReveal = `<div class="text-xl mb-1">${post.gameMathQuestion} = <strong>${post.gameMathAnswer}</strong></div>`;
                else if (post.gameType === 'jumbled_words') answerReveal = `<div class="text-lg mb-1">${post.gameJumbledScrambled} ➔ <strong>${post.gameJumbledOriginal}</strong></div>`;
                else if (post.gameType === 'trivia') answerReveal = `<div class="text-sm mb-1">${post.gameTriviaQuestion}<br>➔ <strong>${post.gameTriviaAnswer}</strong></div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80 text-center">
                        ${prizeStr}
                        ${answerReveal}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'bingo') {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            const myEntry = post.bingoEntries && window.currentUser ? post.bingoEntries[window.currentUser.uid] : null;
            const entryCount = post.bingoEntries ? Object.keys(post.bingoEntries).length : 0;
            const calledItems = Array.isArray(post.bingoCalledItems) ? post.bingoCalledItems : [];

            const animatingItem = (post.bingoLastSpin && Date.now() - post.bingoLastSpin.startTime < 4000) ? post.bingoLastSpin.item : null;
            
            // Build called items chips HTML, excluding the animating item so we don't spoil it early
            const displayItems = calledItems.filter(item => item !== animatingItem);
            const calledChipsHtml = displayItems.length
                ? displayItems.map(item => {
                    const isNum = !isNaN(Number(item));
                    const cls = isNum ? 'bg-orange-500 text-white' : 'bg-purple-600 text-white';
                    return `<span class="inline-block px-2 py-0.5 rounded-full text-xs font-bold ${cls}">${item}</span>`;
                }).join('')
                : '<span class="text-gray-400 text-xs">None yet</span>';

            if (post.bingoPhase === 'submission') {
                const myEntryBadge = myEntry
                    ? `<div class="mt-1 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full font-bold"><i class="fa-solid fa-check mr-1"></i>Your entry: ${myEntry.letters.join(' ')} | ${myEntry.numbers.join(' ')}</div>`
                    : '';
                const timerHtml = post.gameEndTime
                    ? `<div class="text-center font-mono text-xl font-black text-purple-600 dark:text-purple-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`
                    : '';
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-purple-50 to-pink-50 dark:from-slate-800 dark:to-slate-800 rounded-xl border-2 border-purple-200 dark:border-purple-900/50 flex flex-col items-center">
                        ${prizeStr}
                        <h4 class="font-black text-purple-800 dark:text-purple-200 text-lg mb-1">🎱 BINGO!</h4>
                        <p class="text-sm text-gray-600 dark:text-gray-300 mb-1">Pick <strong>${post.bingoLetterCount}</strong> letters (A–${post.bingoMaxLetter || 'Z'}) + <strong>${post.bingoNumberCount}</strong> numbers (1–${post.bingoMaxNumber || 10}) for your entry.</p>
                        <p class="text-xs text-gray-400 mb-2"><i class="fa-solid fa-users mr-1"></i>${entryCount} entries submitted</p>
                        ${timerHtml}
                        ${myEntryBadge}
                        ${!myEntry && !isHost ? `<button onclick="window.openBingoEntryModal('${post.id}')" class="mt-3 bg-purple-600 hover:bg-purple-500 text-white font-bold py-2 px-6 rounded-full shadow transition"><i class="fa-solid fa-dice mr-2"></i>Submit My Entry</button>` : ''}
                        ${isHost ? `<button onclick="window.closeBingoSubmissions('${post.id}')" class="mt-3 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 text-white font-bold py-2 px-6 rounded-full shadow transition"><i class="fa-solid fa-rotate mr-2"></i>Close Submissions & Start Draw</button>` : ''}
                    </div>`;
            } else if (post.bingoPhase === 'drawing' || (post.bingoPhase === 'ended' && animatingItem !== null)) {
                const myEntryBadge = myEntry
                    ? `<div class="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-3 py-1 rounded-full font-bold mb-2"><i class="fa-solid fa-ticket mr-1"></i>Your entry: ${myEntry.letters.join(' ')} | ${myEntry.numbers.join(' ')}</div>`
                    : '';
                    
                const isSpinning = animatingItem !== null;
                const canvasClass = isSpinning ? "opacity-100 scale-100" : "opacity-80 scale-95";
                
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-yellow-50 to-orange-50 dark:from-slate-800 dark:to-slate-800 rounded-xl border-2 border-yellow-300 dark:border-yellow-900/50 flex flex-col items-center overflow-hidden">
                        ${prizeStr}
                        <h4 class="font-black text-orange-800 dark:text-orange-200 text-base mb-1">🎱 Draw in Progress!</h4>
                        <p class="text-xs text-gray-500 mb-2"><i class="fa-solid fa-users mr-1"></i>${entryCount} entries</p>
                        ${myEntryBadge}
                        
                        <!-- Bingo Spin Canvas inline in post -->
                        <div class="relative my-3 transform transition-all duration-300 ${canvasClass}">
                            <div class="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10 text-red-500 text-2xl leading-none drop-shadow-md">▼</div>
                            <canvas id="bingo-wheel-${post.id}" width="200" height="200" class="rounded-full shadow-lg border-4 border-yellow-400 bg-white dark:bg-slate-700"></canvas>
                        </div>
                        
                        <div class="w-full mb-3 text-center">
                            <p class="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1.5">Called: <span class="text-gray-400">(${displayItems.length} so far)</span></p>
                            <div class="flex flex-wrap justify-center gap-1">${calledChipsHtml}</div>
                        </div>
                        
                        ${isHost ? `<div class="flex gap-2 w-full"><button id="bingo-spin-btn-${post.id}" onclick="window.spinBingoWheel('${post.id}')" ${isSpinning ? 'disabled' : ''} class="flex-1 bg-gradient-to-r from-yellow-500 to-orange-500 hover:from-yellow-400 hover:to-orange-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black py-2 rounded-full shadow transition"><i class="fa-solid fa-play mr-2"></i>SPIN!</button><button onclick="window.resetBingoGame('${post.id}')" class="bg-red-500 hover:bg-red-400 text-white font-bold px-3 rounded-full transition text-xs" title="End Game (No Winner)"><i class="fa-solid fa-stop"></i></button></div>` : ''}
                    </div>`;
                
                // Track this post for post-render animation setup
                if (!window._bingoRenderQueue) window._bingoRenderQueue = [];
                window._bingoRenderQueue.push({ id: post.id, postData: post });
            } else if (post.bingoPhase === 'ended' || post.gameStatus === 'ended') {
                const winnerName = post.gameWinner && post.gameWinner !== 'none'
                    ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone')
                    : null;
                const winnerEntry = winnerName && post.bingoEntries && post.gameWinner && post.gameWinner !== 'none'
                    ? post.bingoEntries[post.gameWinner]
                    : null;
                const outcomeHtml2 = winnerName
                    ? `<div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm"><i class="fa-solid fa-trophy mr-1"></i>${winnerName} got BINGO!</div>
                       ${winnerEntry ? `<p class="text-xs text-gray-400 mt-1">Winning entry: ${winnerEntry.letters.join(' ')} | ${winnerEntry.numbers.join(' ')}</p>` : ''}`
                    : `<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-bold px-4 py-2 rounded-full text-sm"><i class="fa-solid fa-xmark mr-1"></i>No winner this round!</div>`;
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center text-center opacity-90">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-2">🎱 Bingo Ended</h4>
                        <div class="w-full mb-2">
                            <p class="text-xs font-bold text-gray-500 dark:text-gray-400 mb-1.5">All called items:</p>
                            <div class="flex flex-wrap gap-1 justify-center">${calledChipsHtml}</div>
                        </div>
                        ${outcomeHtml2}
                    </div>`;
            }
        } else if (post.gameType === 'spin_names') {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            const joinedArray = post.spinNamesJoined 
                ? Object.entries(post.spinNamesJoined).map(([uid, data]) => ({ ...data, uid: data.uid || uid }))
                : [];
            const hasJoined = window.currentUser ? joinedArray.some(u => u.uid === window.currentUser.uid) : false;
            const entryCount = joinedArray.length;
            const prizes = Array.isArray(post.spinNamesPrizes) ? post.spinNamesPrizes : [];
            let prizesBadges = '';
            if (prizes.length > 0) {
                prizesBadges = prizes.map(pz => {
                    return `<span class="inline-flex items-center gap-1 bg-amber-500/10 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[11px] font-bold px-2.5 py-0.5 rounded-full"><i class="fa-solid fa-trophy text-amber-500"></i>Spin #${pz.target}: ${escapeHtml(pz.prize || '')}</span>`;
                }).join(' ');
            }
            
            const animatingItem = (post.spinNamesLastSpin && Date.now() - post.spinNamesLastSpin.startTime < 4000) ? post.spinNamesLastSpin.item : null;
            const winnersList = Array.isArray(post.spinNamesWinners) ? post.spinNamesWinners : [];
            
            if (post.spinNamesPhase === 'submission') {
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-slate-800 dark:to-slate-800 rounded-xl border-2 border-blue-200 dark:border-blue-900/50 flex flex-col items-center">
                        <h4 class="font-black text-blue-800 dark:text-blue-200 text-lg mb-1">🎡 Spin the Names!</h4>
                        <p class="text-xs text-gray-600 dark:text-gray-300 mb-2">Join the draw for a chance to win.</p>
                        ${prizesBadges ? `<div class="flex flex-wrap gap-1.5 justify-center mb-2">${prizesBadges}</div>` : ''}
                        <p class="text-xs text-gray-400 mb-2"><i class="fa-solid fa-users mr-1"></i>${entryCount} players joined</p>
                        ${hasJoined 
                            ? `<div class="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full font-bold mb-2"><i class="fa-solid fa-check mr-1"></i>You joined!</div>`
                            : (!isHost ? `<button onclick="window.joinSpinNames('${post.id}')" class="mt-2 bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-6 rounded-full shadow transition"><i class="fa-solid fa-right-to-bracket mr-2"></i>Join Spin</button>` : `<div class="text-xs text-gray-400 italic">You are the host</div>`)
                        }
                        ${isHost ? `<button onclick="window.closeSpinNames('${post.id}')" class="mt-3 bg-indigo-500 hover:bg-indigo-400 text-white font-bold py-2 px-6 rounded-full shadow transition text-xs"><i class="fa-solid fa-play mr-2"></i>Close Submissions & Start Draw</button>` : ''}
                    </div>`;
            } else if (post.spinNamesPhase === 'drawing' || (post.spinNamesPhase === 'ended' && animatingItem !== null)) {
                const isSpinning = animatingItem !== null;
                const canvasClass = isSpinning ? "opacity-100 scale-100" : "opacity-80 scale-95";
                
                // Show which spin number comes NEXT — use spinNamesSpinCount (increments every spin, not just prize spins)
                const currentSpinNum = (post.spinNamesSpinCount || 0) + (isSpinning ? 0 : 1);
                
                // Build history from spinNamesSpinHistory (all spins) not just prize winners
                const spinHistory = Array.isArray(post.spinNamesSpinHistory) ? post.spinNamesSpinHistory : [];
                // During animation, hide the current spin's entry until the wheel stops
                const displayHistory = isSpinning ? spinHistory.filter(s => s.name !== animatingItem || s !== spinHistory[spinHistory.length - 1]) : spinHistory;
                
                let historyHtml = displayHistory.length > 0
                    ? displayHistory.map(s => s.prize
                        ? `<div class="text-[10px] bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/40 rounded px-2.5 py-1 shadow-sm mb-1"><i class="fa-solid fa-trophy text-yellow-500 mr-1"></i>Spin #${s.spinNumber}: <strong>${escapeHtml(s.name)}</strong> — ${escapeHtml(s.prize)}</div>`
                        : `<div class="text-[10px] bg-white dark:bg-slate-700 rounded px-2.5 py-1 shadow-sm mb-1 text-gray-500 dark:text-gray-400"><i class="fa-solid fa-rotate-right mr-1"></i>Spin #${s.spinNumber}: <strong>${escapeHtml(s.name)}</strong> — <span class="italic">No prize</span></div>`
                    ).join('')
                    : `<span class="text-xs text-gray-400">None yet</span>`;
                    
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-slate-800 dark:to-slate-800 rounded-xl border-2 border-indigo-300 dark:border-indigo-900/50 flex flex-col items-center overflow-hidden">
                        <h4 class="font-black text-indigo-800 dark:text-indigo-200 text-base mb-1">🎡 Draw in Progress!</h4>
                        <p class="text-xs text-gray-500 mb-2"><i class="fa-solid fa-users mr-1"></i>${entryCount} players · Spin #${currentSpinNum}</p>
                        ${prizesBadges ? `<div class="flex flex-wrap gap-1.5 justify-center mb-2">${prizesBadges}</div>` : ''}
                        
                        <div class="relative my-3 transform transition-all duration-300 ${canvasClass}">
                            <div class="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10 text-red-500 text-2xl leading-none drop-shadow-md">▼</div>
                            <canvas id="spin-names-wheel-${post.id}" width="200" height="200" class="rounded-full shadow-lg border-4 border-indigo-400 bg-white dark:bg-slate-700"></canvas>
                        </div>
                        
                        <div class="w-full mb-3 text-center">
                            <p class="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1.5">Spin results:</p>
                            <div class="flex flex-col items-center gap-1">${historyHtml}</div>
                        </div>
                        
                        ${isHost ? `<div class="flex gap-2 w-full"><button id="spin-names-btn-${post.id}" onclick="window.drawSpinNamesItem('${post.id}')" ${isSpinning ? 'disabled' : ''} class="flex-1 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-400 hover:to-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black py-2 rounded-full shadow transition"><i class="fa-solid fa-play mr-2"></i>SPIN!</button></div>` : ''}
                    </div>`;
                
                if (!window._bingoRenderQueue) window._bingoRenderQueue = [];
                window._bingoRenderQueue.push({ id: post.id, postData: post }); // Reuse bingo queue to trigger canvas drawing
                
            } else if (post.spinNamesPhase === 'ended' || post.gameStatus === 'ended') {
                const fullHistory = Array.isArray(post.spinNamesSpinHistory) ? post.spinNamesSpinHistory : [];

                let resultsHtml;
                if (fullHistory.length > 0) {
                    resultsHtml = fullHistory.map(s => s.prize
                        ? `<div class="inline-flex items-center gap-1.5 bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 text-xs font-semibold px-3 py-1.5 rounded-full mb-1.5 shadow-sm border border-indigo-500/20"><i class="fa-solid fa-trophy text-yellow-500"></i><span>Spin #${s.spinNumber}: <strong>${escapeHtml(s.name)}</strong> won ${escapeHtml(s.prize)}!</span></div>`
                        : `<div class="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-gray-400 text-xs px-3 py-1 rounded-full mb-1"><i class="fa-solid fa-rotate-right mr-1"></i>Spin #${s.spinNumber}: <strong>${escapeHtml(s.name)}</strong> — <span class="italic">No prize</span></div>`
                    ).join('');
                } else {
                    // Fallback for old games that don't have spinNamesSpinHistory yet
                    resultsHtml = winnersList.length > 0
                        ? winnersList.map(w => `<div class="inline-flex items-center gap-1.5 bg-indigo-500/10 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 text-xs font-semibold px-3 py-1.5 rounded-full mb-1.5 shadow-sm border border-indigo-500/20"><i class="fa-solid fa-trophy text-yellow-500"></i><span>Spin #${w.target}: <strong>${escapeHtml(w.name)}</strong> won ${escapeHtml(w.prize)}!</span></div>`).join('')
                        : `<div class="bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs font-bold px-3 py-2 rounded">No winners.</div>`;
                }
                    
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center text-center opacity-90">
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-2">🎡 Spin the Names Ended</h4>
                        <div class="w-full mb-2 flex flex-col items-center">
                            ${resultsHtml}
                        </div>
                    </div>`;
            }
        } else if (post.gameType === 'ncl') {
            const winnerName = post.gameWinner ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone') : 'Someone';
            gameHtml = `
                <div class="mt-3 mb-2 p-4 bg-gradient-to-r from-pink-100 to-rose-100 dark:from-pink-900/40 dark:to-rose-900/40 rounded-xl border-2 border-pink-300 dark:border-pink-700/50 flex flex-col items-center text-center shadow-sm">
                    <div class="text-3xl mb-2">🎁</div>
                    <h4 class="font-black text-pink-800 dark:text-pink-300 text-lg mb-1">ncl @${winnerName}</h4>
                    ${prizeStr ? `<div class="mt-2">${prizeStr}</div>` : (post.gamePrize ? `<div class="mt-2 bg-white dark:bg-slate-800/80 px-4 py-2 rounded-lg font-bold text-pink-600 dark:text-pink-400 shadow-inner text-sm">${escapeHtml(String(post.gamePrize))}</div>` : '')}
                </div>`;
        } else if (post.gameType === 'count_dots') {
            if (post.gameStatus === 'active') {
                const timerHtml = post.gameEndTime
                    ? `<div class="text-center font-mono text-xl font-black text-indigo-600 dark:text-indigo-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`
                    : '';
                const isHost = window.currentUser && window.currentUser.uid === post.authorId;
                const answerBtn = !isHost ? `<button onclick="window.openAnswerModal('${post.id}', 'Count the Dots', 'Enter exact number of dots (●)')" class="mt-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold py-2.5 px-8 rounded-full shadow-md transition transform hover:scale-105 active:scale-95 text-sm flex items-center gap-1.5"><i class="fa-solid fa-calculator"></i>Guess Dot Count</button>` : `<div class="text-xs text-gray-500 dark:text-gray-400 mt-2 bg-gray-100 dark:bg-slate-700 px-3 py-1 rounded-full">You are the host (${post.gameDotsCount} dots)</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-indigo-50/70 dark:bg-slate-800 rounded-2xl border-2 border-indigo-200 dark:border-indigo-900/50 flex flex-col items-center">
                        ${prizeStr}
                        <h4 class="font-black text-indigo-900 dark:text-indigo-200 text-base mb-1">🔢 Count the Dots!</h4>
                        <p class="text-xs text-gray-600 dark:text-gray-300 mb-2 text-center">How many dots (<span class="font-bold text-indigo-600 text-sm">●</span>) can you count in the scramble below?</p>
                        <div class="w-full max-w-sm bg-white dark:bg-slate-900 border border-indigo-100 dark:border-slate-700 rounded-xl p-3.5 shadow-inner">
                            <pre class="font-mono text-xs md:text-sm tracking-widest text-center whitespace-pre-wrap leading-relaxed select-none text-slate-700 dark:text-indigo-200 font-bold">${post.gameDotsScrambled || ''}</pre>
                        </div>
                        ${timerHtml}
                        ${answerBtn}
                    </div>`;
            } else {
                const winnerName = post.gameWinner && post.gameWinner !== 'none'
                    ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone')
                    : 'No one';
                const outcomeHtml = post.gameWinner && post.gameWinner !== 'none'
                    ? `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} guessed correctly!</span></div>`
                    : `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-xmark"></i> Game ended! No correct guess.</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">🔢 Count the Dots Ended</h4>
                        <div class="bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-300 font-bold px-4 py-1.5 rounded-lg text-sm mb-1">
                            Solution: <strong>${post.gameDotsCount || 0}</strong> dots
                        </div>
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'tictactoe') {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            const playerX = post.tictactoePlayerX;
            const playerO = post.tictactoePlayerO;
            const nameX = (playerX ? (window.globalUsersCache[playerX]?.name || 'Host') : 'Host');
            const nameO = (playerO ? (window.globalUsersCache[playerO]?.name || 'Challenger') : (post.tictactoeTargetUser ? (window.globalUsersCache[post.tictactoeTargetUser]?.name || 'Challenger') : 'Waiting...'));
            const isTargeted = Boolean(post.tictactoeTargetUser);
            const isEligibleChallenger = window.currentUser && !isHost && (!isTargeted || post.tictactoeTargetUser === window.currentUser.uid);

            const board = post.tictactoeBoard || Array(9).fill('');
            const turn = post.tictactoeTurn || 'X';
            const isMyTurn = window.currentUser && (
                (turn === 'X' && window.currentUser.uid === playerX) ||
                (turn === 'O' && window.currentUser.uid === playerO)
            );

            if (post.gameStatus === 'active') {
                if (post.tictactoeStatus === 'waiting') {
                    const acceptBtn = isEligibleChallenger ? `
                        <button onclick="window.acceptTicTacToeChallenge('${post.id}')" class="mt-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-black py-2.5 px-8 rounded-full shadow-lg transform transition hover:scale-105 active:scale-95 animate-pulse text-sm">
                            <i class="fa-solid fa-handshake mr-2"></i>Accept Challenge & Play (O)!
                        </button>` : (isHost ? `<div class="mt-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-3 py-1 rounded-full">Waiting for ${isTargeted ? `@${nameO}` : 'a challenger'} to accept...</div>` : `<div class="mt-2 text-xs text-gray-400">Waiting for @${nameO} to accept...</div>`);

                    gameHtml = `
                        <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-emerald-200 dark:border-emerald-900/50 flex flex-col items-center">
                            ${prizeStr}
                            <h4 class="font-black text-emerald-900 dark:text-emerald-200 text-base mb-1">⚔️ Tic Tac Toe Match</h4>
                            <div class="flex items-center gap-3 my-2 text-xs font-bold">
                                <span class="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 px-3 py-1 rounded-full">❌ @${nameX} (Host)</span>
                                <span class="text-gray-400 font-extrabold">VS</span>
                                <span class="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-3 py-1 rounded-full">⭕ ${isTargeted ? `@${nameO}` : 'Open Challenger'}</span>
                            </div>
                            ${acceptBtn}
                        </div>`;
                } else {
                    const turnName = (turn === 'X' ? nameX : nameO);
                    const turnBadge = isMyTurn
                        ? `<div class="bg-emerald-500 text-white font-extrabold px-4 py-1.5 rounded-full text-xs animate-bounce shadow"><i class="fa-solid fa-play mr-1"></i>YOUR TURN (${turn})!</div>`
                        : `<div class="bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold px-3 py-1 rounded-full text-xs">Waiting for @${turnName} (${turn})'s move...</div>`;

                    const gridSize = Number(post.tictactoeGridSize) || (board.length === 16 ? 4 : 3);
                    const gridClass = gridSize === 4
                        ? 'grid grid-cols-4 grid-rows-4 gap-1.5 p-2 bg-white/80 dark:bg-slate-900/80 rounded-2xl border-2 border-emerald-300 dark:border-slate-700 shadow-inner w-64 h-64 mx-auto my-2 shrink-0'
                        : 'grid grid-cols-3 grid-rows-3 gap-2 p-2 bg-white/80 dark:bg-slate-900/80 rounded-2xl border-2 border-emerald-300 dark:border-slate-700 shadow-inner w-56 h-56 mx-auto my-2 shrink-0';
                    const fontClass = gridSize === 4 ? 'text-2xl' : 'text-3xl';

                    let gridHtml = `<div class="${gridClass}">`;
                    board.forEach((cell, idx) => {
                        const canClick = isMyTurn && cell === '';
                        let cellContent = `<span class="text-transparent font-black ${fontClass} leading-none select-none pointer-events-none">&nbsp;</span>`;
                        if (cell === 'X') {
                            cellContent = `<span class="text-rose-500 font-black ${fontClass} leading-none select-none flex items-center justify-center">✕</span>`;
                        } else if (cell === 'O') {
                            cellContent = `<span class="text-blue-500 font-black ${fontClass} leading-none select-none flex items-center justify-center">◯</span>`;
                        }
                        const clickHandler = canClick ? `onclick="window.makeTicTacToeMove('${post.id}', ${idx})"` : '';
                        const hoverClass = canClick ? 'hover:bg-emerald-100 dark:hover:bg-emerald-950/40 cursor-pointer hover:scale-105 active:scale-95' : 'cursor-default';
                        gridHtml += `
                            <div ${clickHandler} class="w-full h-full min-h-0 min-w-0 rounded-xl bg-slate-50 dark:bg-slate-800 flex items-center justify-center border border-slate-200 dark:border-slate-700 transition transform select-none leading-none overflow-hidden ${hoverClass}">
                                ${cellContent}
                            </div>`;
                    });
                    gridHtml += `</div>`;

                    gameHtml = `
                        <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-emerald-200 dark:border-emerald-900/50 flex flex-col items-center">
                            ${prizeStr}
                            <div class="flex items-center justify-between w-full max-w-xs text-xs font-bold mb-2">
                                <span class="text-rose-600 dark:text-rose-400">❌ @${nameX}</span>
                                <span class="text-gray-400">VS</span>
                                <span class="text-blue-600 dark:text-blue-400">⭕ @${nameO}</span>
                            </div>
                            ${turnBadge}
                            ${gridHtml}
                        </div>`;
                }
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'draw') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-handshake"></i> Match ended in a Draw!</div>`;
                } else {
                    const winnerName = post.gameWinner ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone') : 'Someone';
                    const winnerSymbol = post.gameWinner === playerX ? '❌' : '⭕';
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerSymbol} ${winnerName} won the match!</span></div>`;
                }

                const gridSize = Number(post.tictactoeGridSize) || (board.length === 16 ? 4 : 3);
                const endedGridClass = gridSize === 4
                    ? 'grid grid-cols-4 grid-rows-4 gap-1 p-2 bg-white/60 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-700 w-44 h-44 mx-auto my-2 opacity-90 shrink-0'
                    : 'grid grid-cols-3 grid-rows-3 gap-1.5 p-2 bg-white/60 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-700 w-44 h-44 mx-auto my-2 opacity-90 shrink-0';
                const endedFontClass = gridSize === 4 ? 'text-lg' : 'text-xl';

                let gridHtml = `<div class="${endedGridClass}">`;
                board.forEach((cell) => {
                    let cellContent = `<span class="text-transparent font-black ${endedFontClass} leading-none select-none pointer-events-none">&nbsp;</span>`;
                    if (cell === 'X') cellContent = `<span class="text-rose-500 font-black ${endedFontClass} leading-none select-none flex items-center justify-center">✕</span>`;
                    else if (cell === 'O') cellContent = `<span class="text-blue-500 font-black ${endedFontClass} leading-none select-none flex items-center justify-center">◯</span>`;
                    gridHtml += `<div class="w-full h-full min-h-0 min-w-0 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center border border-slate-200 dark:border-slate-700 select-none leading-none overflow-hidden">${cellContent}</div>`;
                });
                gridHtml += `</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">⚔️ Tic Tac Toe Ended</h4>
                        ${gridHtml}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'four_in_a_row') {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            const count = Number(post.fourPlayerCount) || 2;
            const playerR = post.fourPlayerR;
            const playerB = post.fourPlayerB;
            const playerY = post.fourPlayerY;
            const nameR = (playerR ? (window.globalUsersCache[playerR]?.name || 'Host') : 'Host');
            const nameB = (playerB ? (window.globalUsersCache[playerB]?.name || 'Challenger 1') : (post.fourTargetUser ? (window.globalUsersCache[post.fourTargetUser]?.name || 'Challenger 1') : 'Waiting...'));
            const nameY = (playerY ? (window.globalUsersCache[playerY]?.name || 'Challenger 2') : 'Waiting...');
            const isTargeted = Boolean(post.fourTargetUser);
            const myUid = window.currentUser ? window.currentUser.uid : null;
            const isAlreadyIn = myUid && (myUid === playerR || myUid === playerB || myUid === playerY);
            const isEligibleChallenger = myUid && !isAlreadyIn && (!isTargeted || post.fourTargetUser === myUid || (count === 3 && playerB && !playerY));

            const board = post.fourBoard || Array(49).fill('');
            const turn = post.fourTurn || 'R';
            const isMyTurn = myUid && (
                (turn === 'R' && myUid === playerR) ||
                (turn === 'B' && myUid === playerB) ||
                (turn === 'Y' && myUid === playerY)
            );

            if (post.gameStatus === 'active') {
                if (post.fourStatus === 'waiting') {
                    const acceptBtn = isEligibleChallenger ? `
                        <button onclick="window.acceptFourInARowChallenge('${post.id}')" class="mt-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-black py-2.5 px-8 rounded-full shadow-lg transform transition hover:scale-105 active:scale-95 animate-pulse text-sm">
                            <i class="fa-solid fa-circle-dot mr-2"></i>Accept Challenge & Join!
                        </button>` : (isHost ? `<div class="mt-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-3 py-1 rounded-full">Waiting for challenger(s) to accept...</div>` : `<div class="mt-2 text-xs text-gray-400">Waiting for players to join...</div>`);

                    const playersBadges = count === 3 ? `
                        <div class="flex flex-wrap items-center justify-center gap-2 my-2 text-xs font-bold">
                            <span class="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 px-2.5 py-1 rounded-full">🔴 @${escapeHtml(nameR)}</span>
                            <span class="text-gray-400 font-extrabold">VS</span>
                            <span class="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-2.5 py-1 rounded-full">🔵 ${playerB ? `@${escapeHtml(nameB)}` : 'Open Slot'}</span>
                            <span class="text-gray-400 font-extrabold">VS</span>
                            <span class="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 px-2.5 py-1 rounded-full">🟡 ${playerY ? `@${escapeHtml(nameY)}` : 'Open Slot'}</span>
                        </div>` : `
                        <div class="flex items-center gap-3 my-2 text-xs font-bold">
                            <span class="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 px-3 py-1 rounded-full">🔴 @${escapeHtml(nameR)} (Host)</span>
                            <span class="text-gray-400 font-extrabold">VS</span>
                            <span class="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-3 py-1 rounded-full">🔵 ${isTargeted ? `@${escapeHtml(nameB)}` : 'Open Challenger'}</span>
                        </div>`;

                    gameHtml = `
                        <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-blue-200 dark:border-blue-900/50 flex flex-col items-center">
                            ${prizeStr}
                            <h4 class="font-black text-blue-900 dark:text-blue-200 text-base mb-1">🔴🔵 4 in a Row (7x7)</h4>
                            ${playersBadges}
                            ${acceptBtn}
                        </div>`;
                } else {
                    const turnName = (turn === 'R' ? nameR : (turn === 'B' ? nameB : nameY));
                    const turnColor = turn === 'R' ? 'Red 🔴' : (turn === 'B' ? 'Blue 🔵' : 'Yellow 🟡');
                    const turnBadge = isMyTurn
                        ? `<div class="bg-blue-600 text-white font-extrabold px-4 py-1.5 rounded-full text-xs animate-bounce shadow"><i class="fa-solid fa-play mr-1"></i>YOUR TURN (${turnColor})!</div>`
                        : `<div class="bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold px-3 py-1 rounded-full text-xs">Waiting for @${escapeHtml(turnName)} (${turnColor})'s move...</div>`;

                    const playersBadges = count === 3 ? `
                        <div class="flex flex-wrap items-center justify-between w-full max-w-xs text-xs font-bold mb-2">
                            <span class="text-rose-600 dark:text-rose-400">🔴 @${escapeHtml(nameR)}</span>
                            <span class="text-blue-600 dark:text-blue-400">🔵 @${escapeHtml(nameB)}</span>
                            <span class="text-amber-600 dark:text-amber-400">🟡 @${escapeHtml(nameY)}</span>
                        </div>` : `
                        <div class="flex items-center justify-between w-full max-w-xs text-xs font-bold mb-2">
                            <span class="text-rose-600 dark:text-rose-400">🔴 @${escapeHtml(nameR)}</span>
                            <span class="text-gray-400">VS</span>
                            <span class="text-blue-600 dark:text-blue-400">🔵 @${escapeHtml(nameB)}</span>
                        </div>`;

                    let gridHtml = `<div class="grid grid-cols-7 grid-rows-7 gap-1 p-2 bg-blue-900/15 dark:bg-slate-900/90 rounded-2xl border-2 border-blue-400 dark:border-slate-700 shadow-inner w-72 h-72 mx-auto my-2 shrink-0">`;
                    board.forEach((cell, idx) => {
                        const canClick = isMyTurn && cell === '';
                        let cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white/70 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 shadow-inner"></div>`;
                        if (cell === 'R') {
                            cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-rose-500 to-red-600 shadow-md border-2 border-rose-300 animate-scale-in"></div>`;
                        } else if (cell === 'B') {
                            cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 shadow-md border-2 border-blue-300 animate-scale-in"></div>`;
                        } else if (cell === 'Y') {
                            cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-amber-300 to-yellow-500 shadow-md border-2 border-amber-200 animate-scale-in"></div>`;
                        }
                        const clickHandler = canClick ? `onclick="window.makeFourInARowMove('${post.id}', ${idx})"` : '';
                        const hoverClass = canClick ? 'hover:bg-blue-200/50 dark:hover:bg-blue-950/40 cursor-pointer hover:scale-105 active:scale-95' : 'cursor-default';
                        gridHtml += `
                            <div ${clickHandler} class="w-full h-full flex items-center justify-center rounded-lg transition transform select-none ${hoverClass}">
                                ${cellContent}
                            </div>`;
                    });
                    gridHtml += `</div>`;

                    gameHtml = `
                        <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-blue-200 dark:border-blue-900/50 flex flex-col items-center">
                            ${prizeStr}
                            <h4 class="font-black text-blue-900 dark:text-blue-200 text-base mb-1">🔴🔵 4 in a Row (7x7)</h4>
                            ${playersBadges}
                            ${turnBadge}
                            ${gridHtml}
                        </div>`;
                }
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'draw') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-handshake"></i> Match ended in a Draw!</div>`;
                } else {
                    const winnerName = post.gameWinner ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone') : 'Someone';
                    const winnerSymbol = post.gameWinner === playerR ? '🔴' : (post.gameWinner === playerB ? '🔵' : '🟡');
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerSymbol} ${escapeHtml(winnerName)} won 4 in a Row!</span></div>`;
                }

                const winningLine = Array.isArray(post.fourWinningLine) ? post.fourWinningLine : [];
                let gridHtml = `<div class="grid grid-cols-7 grid-rows-7 gap-1 p-2 bg-white/60 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-700 w-64 h-64 mx-auto my-2 opacity-90 shrink-0">`;
                board.forEach((cell, idx) => {
                    const isWinCell = winningLine.includes(idx);
                    let cellContent = `<div class="w-6 h-6 rounded-full bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700"></div>`;
                    if (cell === 'R') {
                        cellContent = `<div class="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-red-600 shadow border border-rose-300 ${isWinCell ? 'ring-2 ring-yellow-400 scale-110' : ''}"></div>`;
                    } else if (cell === 'B') {
                        cellContent = `<div class="w-6 h-6 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 shadow border border-blue-300 ${isWinCell ? 'ring-2 ring-yellow-400 scale-110' : ''}"></div>`;
                    } else if (cell === 'Y') {
                        cellContent = `<div class="w-6 h-6 rounded-full bg-gradient-to-br from-amber-300 to-yellow-500 shadow border border-amber-200 ${isWinCell ? 'ring-2 ring-yellow-400 scale-110' : ''}"></div>`;
                    }
                    gridHtml += `<div class="w-full h-full flex items-center justify-center select-none">${cellContent}</div>`;
                });
                gridHtml += `</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">🔴🔵 4 in a Row Ended</h4>
                        ${gridHtml}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'drop_four') {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            const count = Number(post.dropFourPlayerCount) || 2;
            const playerR = post.dropFourPlayerR;
            const playerY = post.dropFourPlayerY;
            const playerB = post.dropFourPlayerB;
            const nameR = (playerR ? (window.globalUsersCache[playerR]?.name || 'Host') : 'Host');
            const nameY = (playerY ? (window.globalUsersCache[playerY]?.name || 'Challenger 1') : (post.dropFourTargetUser ? (window.globalUsersCache[post.dropFourTargetUser]?.name || 'Challenger 1') : 'Waiting...'));
            const nameB = (playerB ? (window.globalUsersCache[playerB]?.name || 'Challenger 2') : 'Waiting...');
            const isTargeted = Boolean(post.dropFourTargetUser);
            const myUid = window.currentUser ? window.currentUser.uid : null;
            const isAlreadyIn = myUid && (myUid === playerR || myUid === playerY || myUid === playerB);
            const isEligibleChallenger = myUid && !isAlreadyIn && (!isTargeted || post.dropFourTargetUser === myUid || (count === 3 && playerY && !playerB));

            const board = post.dropFourBoard || Array(42).fill('');
            const turn = post.dropFourTurn || 'R';
            const isMyTurn = myUid && (
                (turn === 'R' && myUid === playerR) ||
                (turn === 'Y' && myUid === playerY) ||
                (turn === 'B' && myUid === playerB)
            );

            if (post.gameStatus === 'active') {
                if (post.dropFourStatus === 'waiting') {
                    const acceptBtn = isEligibleChallenger ? `
                        <button onclick="window.acceptDropFourChallenge('${post.id}')" class="mt-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-black py-2.5 px-8 rounded-full shadow-lg transform transition hover:scale-105 active:scale-95 animate-pulse text-sm">
                            <i class="fa-solid fa-circle-arrow-down mr-2"></i>Accept Challenge & Join Drop!
                        </button>` : (isHost ? `<div class="mt-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-3 py-1 rounded-full">Waiting for challenger(s) to accept...</div>` : `<div class="mt-2 text-xs text-gray-400">Waiting for players to join...</div>`);

                    const playersBadges = count === 3 ? `
                        <div class="flex flex-wrap items-center justify-center gap-2 my-2 text-xs font-bold">
                            <span class="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 px-2.5 py-1 rounded-full">🔴 @${escapeHtml(nameR)}</span>
                            <span class="text-gray-400 font-extrabold">VS</span>
                            <span class="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 px-2.5 py-1 rounded-full">🟡 ${playerY ? `@${escapeHtml(nameY)}` : 'Open Slot'}</span>
                            <span class="text-gray-400 font-extrabold">VS</span>
                            <span class="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 px-2.5 py-1 rounded-full">🔵 ${playerB ? `@${escapeHtml(nameB)}` : 'Open Slot'}</span>
                        </div>` : `
                        <div class="flex items-center gap-3 my-2 text-xs font-bold">
                            <span class="bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 px-3 py-1 rounded-full">🔴 @${escapeHtml(nameR)} (Host)</span>
                            <span class="text-gray-400 font-extrabold">VS</span>
                            <span class="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 px-3 py-1 rounded-full">🟡 ${isTargeted ? `@${escapeHtml(nameY)}` : 'Open Challenger'}</span>
                        </div>`;

                    gameHtml = `
                        <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-blue-300 dark:border-blue-900/50 flex flex-col items-center">
                            ${prizeStr}
                            <h4 class="font-black text-blue-900 dark:text-blue-200 text-base mb-1">🟡🔴 Connect 4</h4>
                            ${playersBadges}
                            ${acceptBtn}
                        </div>`;
                } else {
                    const turnName = (turn === 'R' ? nameR : (turn === 'Y' ? nameY : nameB));
                    const turnColor = turn === 'R' ? 'Red 🔴' : (turn === 'Y' ? 'Yellow 🟡' : 'Blue 🔵');
                    const turnBadge = isMyTurn
                        ? `<div class="bg-blue-600 text-white font-extrabold px-4 py-1.5 rounded-full text-xs animate-bounce shadow"><i class="fa-solid fa-play mr-1"></i>YOUR TURN (${turnColor})!</div>`
                        : `<div class="bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-gray-300 font-bold px-3 py-1 rounded-full text-xs">Waiting for @${escapeHtml(turnName)} (${turnColor})'s move...</div>`;

                    const playersBadges = count === 3 ? `
                        <div class="flex flex-wrap items-center justify-between w-full max-w-xs text-xs font-bold mb-2">
                            <span class="text-rose-600 dark:text-rose-400">🔴 @${escapeHtml(nameR)}</span>
                            <span class="text-amber-600 dark:text-amber-400">🟡 @${escapeHtml(nameY)}</span>
                            <span class="text-blue-600 dark:text-blue-400">🔵 @${escapeHtml(nameB)}</span>
                        </div>` : `
                        <div class="flex items-center justify-between w-full max-w-xs text-xs font-bold mb-2">
                            <span class="text-rose-600 dark:text-rose-400">🔴 @${escapeHtml(nameR)}</span>
                            <span class="text-gray-400">VS</span>
                            <span class="text-amber-600 dark:text-amber-400">🟡 @${escapeHtml(nameY)}</span>
                        </div>`;

                    // Top drop buttons for 7 columns
                    let dropBtnsHtml = `<div class="grid grid-cols-7 gap-1 w-72 mx-auto mb-1 shrink-0">`;
                    for (let c = 0; c < 7; c++) {
                        const canDrop = isMyTurn && (board[c] === ''); // top row empty
                        const btnClick = canDrop ? `onclick="window.makeDropFourMove('${post.id}', ${c})"` : '';
                        const btnClass = canDrop ? 'bg-blue-500 hover:bg-blue-400 text-white cursor-pointer active:scale-90 hover:scale-105' : 'bg-transparent text-transparent cursor-default';
                        dropBtnsHtml += `<button type="button" ${btnClick} class="w-full py-1 text-xs font-black rounded-lg transition ${btnClass}">⬇</button>`;
                    }
                    dropBtnsHtml += `</div>`;

                    // 7 columns x 6 rows board
                    let gridHtml = `<div class="grid grid-cols-7 grid-rows-6 gap-1 p-2.5 bg-blue-600 dark:bg-blue-800 rounded-2xl shadow-xl border-4 border-blue-700 dark:border-blue-900 w-72 h-64 mx-auto my-1 shrink-0">`;
                    board.forEach((cell, idx) => {
                        const col = idx % 7;
                        const canClick = isMyTurn && (board[col] === '');
                        let cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-slate-100 dark:bg-slate-900 border border-blue-500/50 dark:border-blue-900 shadow-inner"></div>`;
                        if (cell === 'R') {
                            cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-rose-500 to-red-600 shadow-md border-2 border-rose-300 animate-scale-in"></div>`;
                        } else if (cell === 'Y') {
                            cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-amber-300 to-yellow-400 shadow-md border-2 border-amber-200 animate-scale-in"></div>`;
                        } else if (cell === 'B') {
                            cellContent = `<div class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-br from-sky-400 to-blue-500 shadow-md border-2 border-sky-200 animate-scale-in"></div>`;
                        }
                        const clickHandler = canClick ? `onclick="window.makeDropFourMove('${post.id}', ${col})"` : '';
                        const hoverClass = canClick ? 'cursor-pointer hover:opacity-85' : 'cursor-default';
                        gridHtml += `
                            <div ${clickHandler} class="w-full h-full flex items-center justify-center select-none ${hoverClass}">
                                ${cellContent}
                            </div>`;
                    });
                    gridHtml += `</div>`;

                    gameHtml = `
                        <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-blue-300 dark:border-blue-900/50 flex flex-col items-center">
                            ${prizeStr}
                            <h4 class="font-black text-blue-900 dark:text-blue-200 text-base mb-1">🟡🔴 Connect 4</h4>
                            ${playersBadges}
                            ${turnBadge}
                            ${dropBtnsHtml}
                            ${gridHtml}
                        </div>`;
                }
            } else {
                let outcomeHtml = '';
                if (post.gameWinner === 'draw') {
                    outcomeHtml = `<div class="inline-flex items-center gap-1.5 bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-handshake"></i> Match ended in a Draw!</div>`;
                } else {
                    const winnerName = post.gameWinner ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone') : 'Someone';
                    const winnerSymbol = post.gameWinner === playerR ? '🔴' : (post.gameWinner === playerY ? '🟡' : '🔵');
                    outcomeHtml = `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerSymbol} ${escapeHtml(winnerName)} won Connect 4!</span></div>`;
                }

                const winningLine = Array.isArray(post.dropFourWinningLine) ? post.dropFourWinningLine : [];
                let gridHtml = `<div class="grid grid-cols-7 grid-rows-6 gap-1 p-2 bg-blue-600/90 dark:bg-blue-900/90 rounded-2xl border-2 border-blue-700 dark:border-blue-950 w-64 h-56 mx-auto my-2 opacity-95 shrink-0">`;
                board.forEach((cell, idx) => {
                    const isWinCell = winningLine.includes(idx);
                    let cellContent = `<div class="w-6 h-6 rounded-full bg-slate-100/70 dark:bg-slate-900/70 border border-blue-400/50 dark:border-blue-950"></div>`;
                    if (cell === 'R') {
                        cellContent = `<div class="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-red-600 shadow border border-rose-300 ${isWinCell ? 'ring-4 ring-yellow-300 scale-110' : ''}"></div>`;
                    } else if (cell === 'Y') {
                        cellContent = `<div class="w-6 h-6 rounded-full bg-gradient-to-br from-amber-300 to-yellow-400 shadow border border-amber-200 ${isWinCell ? 'ring-4 ring-white scale-110' : ''}"></div>`;
                    } else if (cell === 'B') {
                        cellContent = `<div class="w-6 h-6 rounded-full bg-gradient-to-br from-sky-400 to-blue-500 shadow border border-sky-200 ${isWinCell ? 'ring-4 ring-yellow-300 scale-110' : ''}"></div>`;
                    }
                    gridHtml += `<div class="w-full h-full flex items-center justify-center select-none">${cellContent}</div>`;
                });
                gridHtml += `</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">🟡🔴 Connect 4 Ended</h4>
                        ${gridHtml}
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'hangman') {
            const isHost = window.currentUser && window.currentUser.uid === post.authorId;
            const secretWord = (post.hangmanWord || '').toUpperCase();
            const guessedLetters = post.hangmanGuessedLetters || [];
            const wrongLetters = post.hangmanWrongLetters || [];

            const blanks = secretWord.split('').map(ch => {
                if (ch === ' ') return '<span class="inline-block w-4"></span>';
                if (guessedLetters.includes(ch)) return `<span class="inline-block w-7 h-9 text-lg font-black border-b-4 border-rose-500 text-rose-600 dark:text-rose-400 text-center">${ch}</span>`;
                return `<span class="inline-block w-7 h-9 text-lg font-black border-b-4 border-gray-300 dark:border-slate-600 text-transparent text-center">_</span>`;
            }).join(' ');

            const wrongChips = wrongLetters.length > 0
                ? wrongLetters.map(l => `<span class="inline-block px-2 py-0.5 rounded-md text-xs font-black bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-400 border border-red-200 dark:border-red-900/50">${l}</span>`).join(' ')
                : '<span class="text-xs text-gray-400">None</span>';

            if (post.gameStatus === 'active') {
                const timerHtml = post.gameEndTime
                    ? `<div class="text-center font-mono text-xl font-black text-rose-600 dark:text-rose-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`
                    : '';

                let playerControls = '';
                if (isHost) {
                    playerControls = `<div class="mt-3 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-3 py-1.5 rounded-full">You are the host — <span class="font-bold tracking-wider text-rose-600 dark:text-rose-400">${secretWord}</span></div>`;
                } else if (window.currentUser) {
                    const uid = window.currentUser.uid;
                    const letterFailCount = Number(post.hangmanLetterWrong?.[uid] || 0);
                    const wordFailCount = Number(post.hangmanWordWrong?.[uid] || 0);
                    const letterFailed = letterFailCount >= 2;
                    const wordFailed = wordFailCount >= 2;
                    const letterRemaining = 2 - letterFailCount;
                    const wordRemaining = 2 - wordFailCount;

                    if (letterFailed && wordFailed) {
                        playerControls = `<div class="mt-3 text-xs font-bold text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 px-4 py-1.5 rounded-full"><i class="fa-solid fa-skull mr-1"></i>You used all guesses and are eliminated.</div>`;
                    } else {
                        const letterLabel = letterFailed ? '(0 left)' : `(${letterRemaining} left)`;
                        const wordLabel = wordFailed ? '(0 left)' : `(${wordRemaining} left)`;
                        const guessLetterBtn = `<button onclick="window.openHangmanGuessModal('${post.id}', 'letter')" ${letterFailed ? 'disabled' : ''} class="bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-xl shadow transition text-xs flex items-center gap-1.5"><i class="fa-solid fa-font"></i>Guess Letter ${letterLabel}</button>`;
                        const guessWordBtn = `<button onclick="window.openHangmanGuessModal('${post.id}', 'word')" ${wordFailed ? 'disabled' : ''} class="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-xl shadow transition text-xs flex items-center gap-1.5"><i class="fa-solid fa-bullseye"></i>Guess Word ${wordLabel}</button>`;
                        playerControls = `<div class="flex flex-wrap justify-center gap-2 mt-3">${guessLetterBtn}${guessWordBtn}</div>`;
                    }
                } else {
                    playerControls = `<div class="mt-3 text-xs text-gray-400">Sign in to guess!</div>`;
                }

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-rose-50 to-pink-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-rose-200 dark:border-rose-900/50 flex flex-col items-center">
                        ${prizeStr}
                        <h4 class="font-black text-rose-900 dark:text-rose-200 text-base mb-1">🪓 Hangman Game</h4>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mb-3">Guess letters or solve the full word:</p>
                        <div class="flex flex-wrap justify-center gap-1.5 my-2 tracking-widest font-mono">
                            ${blanks}
                        </div>
                        <div class="text-xs text-gray-500 dark:text-gray-400 mb-1">
                            Wrong Letters: ${wrongChips}
                        </div>
                        ${timerHtml}
                        ${playerControls}
                    </div>`;
            } else {
                const winnerName = post.gameWinner && post.gameWinner !== 'none'
                    ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone')
                    : 'No one';
                const outcomeHtml = post.gameWinner && post.gameWinner !== 'none'
                    ? `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} solved the word!</span></div>`
                    : `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-xmark"></i> Game ended! No one solved it.</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">🪓 Hangman Ended</h4>
                        <div class="bg-rose-100 dark:bg-rose-900/40 text-rose-800 dark:text-rose-300 font-black px-4 py-2 rounded-lg text-base tracking-widest my-2">
                            ${secretWord}
                        </div>
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'gibberish') {
            if (post.gameStatus === 'active') {
                const timerHtml = post.gameEndTime
                    ? `<div class="text-center font-mono text-xl font-black text-amber-600 dark:text-amber-400 mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`
                    : '';
                const isAuthor = window.currentUser && window.currentUser.uid === post.authorId;
                const answerBtn = isAuthor
                    ? `<div class="mt-3 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-3 py-1.5 rounded-full">You are the host — Answer: <span class="font-bold text-amber-600 dark:text-amber-400">${post.gameGibberishAnswer || ''}</span></div>`
                    : `<button onclick="window.openAnswerModal('${post.id}', 'Guess the Gibberish', 'Enter the real phrase...')" class="mt-3 bg-amber-600 hover:bg-amber-500 text-white font-bold py-2 px-5 rounded-xl shadow transition text-xs flex items-center gap-1.5"><i class="fa-solid fa-microphone-lines mr-1"></i>Guess Phrase</button>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-slate-800 dark:to-slate-800 rounded-2xl border-2 border-amber-200 dark:border-amber-900/50 flex flex-col items-center text-center">
                        ${prizeStr}
                        <h4 class="font-black text-amber-900 dark:text-amber-200 text-base mb-1">🗣️ Guess the Gibberish!</h4>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">Say this phrase out loud quickly to figure out what it means:</p>
                        <div class="w-full max-w-sm bg-white dark:bg-slate-900 border border-amber-200 dark:border-slate-700 rounded-xl p-3 shadow-inner my-1">
                            <p class="font-black text-base md:text-lg text-amber-800 dark:text-amber-300 tracking-wide font-mono select-all">"${post.gameGibberishClue || ''}"</p>
                        </div>
                        ${timerHtml}
                        ${answerBtn}
                    </div>`;
            } else {
                const winnerName = post.gameWinner && post.gameWinner !== 'none'
                    ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone')
                    : 'No one';
                const outcomeHtml = post.gameWinner && post.gameWinner !== 'none'
                    ? `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} got the right answer!</span></div>`
                    : `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-xmark"></i> Game ended! No one got it.</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">🗣️ Guess the Gibberish Ended</h4>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">"${post.gameGibberishClue || ''}"</p>
                        <div class="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 font-bold px-4 py-2 rounded-xl text-sm my-1">
                            Real Phrase: <span class="font-black">${post.gameGibberishAnswer || ''}</span>
                        </div>
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (post.gameType === 'emoji_riddle') {
            const cat = post.emojiRiddleCategory || 'movies';
            const catInfo = {
                movies: { name: 'Movie', icon: '🎬', gradient: 'from-purple-50 to-indigo-50 dark:from-slate-800 dark:to-slate-800', border: 'border-purple-200 dark:border-purple-900/50', text: 'text-purple-900 dark:text-purple-200', btn: 'bg-purple-600 hover:bg-purple-500', timerText: 'text-purple-600 dark:text-purple-400' },
                songs: { name: 'Song', icon: '🎵', gradient: 'from-pink-50 to-rose-50 dark:from-slate-800 dark:to-slate-800', border: 'border-pink-200 dark:border-pink-900/50', text: 'text-pink-900 dark:text-pink-200', btn: 'bg-pink-600 hover:bg-pink-500', timerText: 'text-pink-600 dark:text-pink-400' },
                idioms: { name: 'Idiom', icon: '💬', gradient: 'from-teal-50 to-emerald-50 dark:from-slate-800 dark:to-slate-800', border: 'border-teal-200 dark:border-teal-900/50', text: 'text-teal-900 dark:text-teal-200', btn: 'bg-teal-600 hover:bg-teal-500', timerText: 'text-teal-600 dark:text-teal-400' },
                custom: { name: 'Riddle', icon: '✨', gradient: 'from-indigo-50 to-sky-50 dark:from-slate-800 dark:to-slate-800', border: 'border-indigo-200 dark:border-indigo-900/50', text: 'text-indigo-900 dark:text-indigo-200', btn: 'bg-indigo-600 hover:bg-indigo-500', timerText: 'text-indigo-600 dark:text-indigo-400' }
            }[cat] || { name: 'Riddle', icon: '✨', gradient: 'from-indigo-50 to-purple-50 dark:from-slate-800 dark:to-slate-800', border: 'border-indigo-200 dark:border-indigo-900/50', text: 'text-indigo-900 dark:text-indigo-200', btn: 'bg-indigo-600 hover:bg-indigo-500', timerText: 'text-indigo-600 dark:text-indigo-400' };

            if (post.gameStatus === 'active') {
                const timerHtml = post.gameEndTime
                    ? `<div class="text-center font-mono text-xl font-black ${catInfo.timerText} mt-2 game-timer" data-endtime="${post.gameEndTime}">00:00</div>`
                    : '';
                const isAuthor = window.currentUser && window.currentUser.uid === post.authorId;
                const answerBtn = isAuthor
                    ? `<div class="mt-3 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-slate-700 px-3 py-1.5 rounded-full">You are the host — Answer: <span class="font-bold ${catInfo.text}">${post.emojiRiddleAnswer || ''}</span></div>`
                    : `<button onclick="window.openAnswerModal('${post.id}', 'Guess the ${catInfo.name}', 'Enter the ${catInfo.name} title...')" class="mt-3 ${catInfo.btn} text-white font-bold py-2 px-5 rounded-xl shadow transition text-xs flex items-center gap-1.5">${catInfo.icon} Guess ${catInfo.name}</button>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br ${catInfo.gradient} rounded-2xl border-2 ${catInfo.border} flex flex-col items-center text-center">
                        ${prizeStr}
                        <h4 class="font-black ${catInfo.text} text-base mb-1">${catInfo.icon} Guess the ${catInfo.name}!</h4>
                        <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">What ${catInfo.name.toLowerCase()} is described by these emojis?</p>
                        <div class="w-full max-w-sm bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl p-4 shadow-inner my-1 flex items-center justify-center">
                            <span class="text-4xl md:text-5xl tracking-widest select-all leading-relaxed">${post.emojiRiddleEmojis || ''}</span>
                        </div>
                        ${timerHtml}
                        ${answerBtn}
                    </div>`;
            } else {
                const winnerName = post.gameWinner && post.gameWinner !== 'none'
                    ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone')
                    : 'No one';
                const outcomeHtml = post.gameWinner && post.gameWinner !== 'none'
                    ? `<div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-trophy text-amber-400"></i> <span>${winnerName} solved the riddle!</span></div>`
                    : `<div class="inline-flex items-center gap-1.5 bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 font-bold px-4 py-1.5 rounded-full text-xs text-center shadow-sm mt-2"><i class="fa-solid fa-xmark"></i> Game ended! No one solved it.</div>`;

                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gray-50 dark:bg-slate-900/50 rounded-2xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-90 text-center">
                        ${prizeStr}
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-1">${catInfo.icon} Emoji Riddle Ended</h4>
                        <div class="text-2xl tracking-widest my-1 select-all">${post.emojiRiddleEmojis || ''}</div>
                        <div class="bg-indigo-100 dark:bg-indigo-900/40 text-indigo-800 dark:text-indigo-300 font-bold px-4 py-2 rounded-xl text-sm my-1">
                            ${catInfo.name}: <span class="font-black">${post.emojiRiddleAnswer || ''}</span>
                        </div>
                        ${outcomeHtml}
                    </div>`;
            }
        }
    }

    postEl.innerHTML = `
        <div id="post-header-${prefix}-${post.id}" class="flex flex-col mb-2">
            ${repostBanner}
            <div class="flex justify-between items-start">
                <div class="flex items-center space-x-2 min-w-0">
                    <img src="${authorInfo.pic || window.generateAvatar(displayAuthorId)}" loading="lazy" class="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 transition shrink-0 ${isBannedAuthor ? 'grayscale' : ''}" onclick="window.openProfile('${displayAuthorId}')">
                    <div class="leading-tight min-w-0 flex-1 overflow-hidden">
                        <div class="flex items-center overflow-x-auto scrollbar-hide space-x-1 pb-0.5">
                            <h3 class="font-bold text-sm text-gray-900 dark:text-gray-100 cursor-pointer hover:underline shrink-0 whitespace-nowrap ${isBannedAuthor ? 'line-through text-red-500' : ''}" onclick="window.openProfile('${displayAuthorId}')">${authorInfo.name}</h3>
                            <div class="shrink-0 flex items-center">${roleData.badgeHtml}</div>
                            <div class="shrink-0 flex items-center">${visibilityIcon}</div>
                            <span class="text-[9px] text-yellow-500 shrink-0 whitespace-nowrap">⭐ ${authorInfo.points || 0}</span>
                            <span class="text-[9px] text-yellow-600 dark:text-yellow-500 shrink-0 whitespace-nowrap">🏆 ${authorInfo.lbPoints || 0}</span>
                            <span class="text-[9px] text-blue-500 font-bold shrink-0 whitespace-nowrap">👥 ${followerCount}</span>
                        </div>
                        <p class="text-[10px] text-gray-500 truncate">${timeStr} • <span class="bg-gray-100 dark:bg-slate-700 px-1 rounded">${post.category}</span></p>
                    </div>
                </div>
                <div class="shrink-0 ml-1 flex items-start">${adminControls}</div>
            </div>
        </div>
        
        <div id="post-body-${prefix}-${post.id}">
            ${post.text ? `<p class="text-sm text-gray-800 dark:text-gray-200 mb-1 whitespace-pre-wrap break-words leading-snug">${safePostText} ${post.edited ? '<span class="text-[10px] italic text-gray-400 ml-1 font-normal">(edited)</span>' : ''}</p>${window.generateEmbed(post.text)}` : ''}
            ${window.renderPostMedia(post)}
            ${gameHtml}
        </div>
        
        <div id="reactions-${prefix}-${post.id}" class="flex items-center justify-between border-t border-gray-100 dark:border-slate-700 pt-2 text-xs pb-1 mt-1">
            <div class="flex items-center space-x-2 shrink-0">
                <button onclick="window.showReactors('${post.id}')" class="flex items-center space-x-1 transition shrink-0 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 text-gray-500 bg-gray-50 dark:bg-slate-900 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                    <i class="fa-solid fa-users"></i>
                </button>
                ${(() => { const ui = generatePostReactionsUI(); return ui.triggerHtml; })()}
            </div>
            
            <div class="flex-1 flex items-center space-x-1 overflow-x-auto scrollbar-hide mx-2 px-1">
                ${(() => { const ui = generatePostReactionsUI(); return ui.activeHtml; })()}
            </div>
            
            <div class="flex items-center space-x-1 shrink-0 ml-auto">
                <button onclick="window.refreshSinglePost('${post.id}')" class="refresh-btn flex items-center ${window._postLiveListeners && window._postLiveListeners[post.id] ? 'text-green-500' : 'text-gray-400'} hover:text-blue-500 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition" title="${window._postLiveListeners && window._postLiveListeners[post.id] ? 'Live (click to stop)' : 'Refresh Post'}">
                    <i class="fa-solid fa-arrows-rotate"></i>
                </button>
                <button onclick="window.repostPost('${post.id}')" class="flex items-center text-gray-400 hover:text-blue-500 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition" title="Repost">
                    <i class="fa-solid fa-share"></i>
                </button>
                <button onclick="window.copyPostLink('${post.id}')" class="flex items-center text-gray-400 hover:text-blue-500 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition" title="Copy Link">
                    <i class="fa-solid fa-link"></i>
                </button>
                <button onclick="window.toggleComments('${post.id}', '${prefix}')" class="flex items-center space-x-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition">
                    <i class="fa-regular fa-comment text-sm"></i> <span>${commentCount}</span>
                </button>
            </div>
        </div>
        
        <div id="comments-${prefix}-${post.id}" class="${isCommentsOpen ? '' : 'hidden'} mt-1 border-t border-gray-100 dark:border-slate-700 pt-1">
            ${commentInputBox}
            ${commentsHtml}
        </div>
    `;
    return postEl;
}

window.renderMembers = (resetLimit = true) => {
    const list = document.getElementById('members-list');
    
    if(resetLimit) window.membersRenderLimit = 20;

    const searchQuery = (document.getElementById('member-search')?.value || '').toLowerCase();
    
    let usersArray = Object.keys(window.globalUsersCache).map(uid => ({uid, ...window.globalUsersCache[uid]})).filter(u => u.name);
    
    document.getElementById('members-total-count').innerText = `${usersArray.length} Total`;
    document.getElementById('members-online-count').innerText = Object.keys(window.onlineUsers).length;

    if(window.currentMemberFilter === "Online") usersArray = usersArray.filter(u => window.onlineUsers[u.uid]);
    else if(window.currentMemberFilter === "Mods") usersArray = usersArray.filter(u => u.isMod === true);
    else if(window.currentMemberFilter === "Admins") usersArray = usersArray.filter(u => window.getRole(u.uid).level === 3);

    if (searchQuery) usersArray = usersArray.filter(u => u.name.toLowerCase().includes(searchQuery));
    
    usersArray.sort((a, b) => (b.points || 0) - (a.points || 0));

    const currentScroll = list.scrollTop;
    list.style.minHeight = list.clientHeight + 'px';

    list.innerHTML = '';
    
    if(usersArray.length === 0) {
        list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">No members found.</p>`;
        list.style.minHeight = '';
        return;
    }

    const usersToRender = usersArray.slice(0, window.membersRenderLimit);
    const myFollowing = (window.currentUser && window.globalUsersCache[window.currentUser.uid]?.following) || {};
    const isAdmin = window.currentUser && window.getRole(window.currentUser.uid).level === 3;

    const fragment = document.createDocumentFragment();

    usersToRender.forEach(u => {
        const isOnline = window.onlineUsers[u.uid];
        const followerCount = u.followers ? Object.keys(u.followers).length : 0;
        
        let followBtn = '';
        if(window.currentUser && window.currentUser.uid !== u.uid) {
            const isFollowing = myFollowing[u.uid];
            followBtn = `<button onclick="window.toggleFollow('${u.uid}')" class="${isFollowing ? 'bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-gray-300' : 'bg-blue-600 text-white'} text-[10px] font-bold px-3 py-1 rounded-full transition ml-1 shrink-0">${isFollowing ? 'Following' : 'Follow'}</button>`;
        }

        let modBtn = '';
        if(isAdmin && !u.isAdmin) {
            modBtn = `<button onclick="window.toggleMod('${u.uid}')" class="${u.isMod ? 'bg-red-500 hover:bg-red-600' : 'bg-purple-500 hover:bg-purple-600'} text-white text-[10px] font-bold px-2 py-1 rounded-full transition ml-1 shrink-0">${u.isMod ? '- Mod' : '+ Mod'}</button>`;
        }

        let banBtn = '';
        if (window.currentUser && window.canDelete(u.uid) && window.currentUser.uid !== u.uid) {
            const isBanned = u.isBanned === true;
            banBtn = `<button onclick="window.toggleBan('${u.uid}')" class="${isBanned ? 'bg-orange-500 hover:bg-orange-600' : 'bg-red-600 hover:bg-red-700'} text-white text-[10px] font-bold px-2 py-1 rounded-full transition ml-1 shrink-0 shadow-sm">${isBanned ? 'Unban' : 'Ban'}</button>`;
        }

        const el = document.createElement('div');
        el.className = `flex items-center justify-between p-2 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-100 dark:border-slate-700/50 mb-2 ${u.isBanned ? 'opacity-70' : ''}`;
        el.innerHTML = `
            <div class="flex items-center space-x-3 overflow-hidden">
                <div class="relative shrink-0">
                    <img src="${u.pic || window.generateAvatar(u.uid)}" loading="lazy" class="w-10 h-10 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 ${u.isBanned ? 'grayscale' : ''}" onclick="window.openProfile('${u.uid}')">
                    <div class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border border-white dark:border-slate-900 ${isOnline ? 'bg-green-500' : 'bg-gray-400'}"></div>
                </div>
                <div class="leading-tight truncate pr-2">
                    <div class="flex items-center">
                        <h3 class="font-bold text-sm text-gray-900 dark:text-white truncate cursor-pointer hover:underline ${u.isBanned ? 'line-through text-red-500' : ''}" onclick="window.openProfile('${u.uid}')">${u.name}</h3>
                        ${window.getRole(u.uid).badgeHtml}
                        ${u.isBanned ? '<span class="bg-red-500 text-white text-[8px] font-bold px-1 ml-1 rounded">BANNED</span>' : ''}
                    </div>
                    <p class="text-[10px] text-gray-500 mt-0.5"><span class="text-yellow-600 dark:text-yellow-500">⭐ ${u.points || 0}</span> • <span class="text-yellow-600 dark:text-yellow-500 ml-1">🏆 ${u.lbPoints || 0}</span> • <span class="text-blue-500">👥 ${followerCount}</span></p>
                </div>
            </div>
            <div class="flex items-center shrink-0">${banBtn}${modBtn}${followBtn}</div>
        `;
        fragment.appendChild(el);
    });
    
    if (window.membersRenderLimit < usersArray.length) {
        const sentinel = document.createElement('div');
        sentinel.className = 'h-10 w-full flex items-center justify-center text-gray-400 text-xs py-2';
        sentinel.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
        fragment.appendChild(sentinel);
        
        list.appendChild(fragment);
        
        if(window.membersObserver) window.membersObserver.disconnect();
        window.membersObserver = new IntersectionObserver((entries) => {
            if(entries[0].isIntersecting) {
                window.membersRenderLimit += 20;
                window.renderMembers(false);
            }
        }, { rootMargin: "200px" });
        window.membersObserver.observe(sentinel);
    } else {
        list.appendChild(fragment);
    }

    list.scrollTop = currentScroll;
    requestAnimationFrame(() => list.style.minHeight = '');
};

window.showReactors = (postId, commentId = null) => {
    const post = window.allPosts.find(p => p.id === postId) || (window.globalPinnedPosts || []).find(p => p.id === postId) || (window.profilePinnedPosts || []).find(p => p.id === postId);
    if (!post) return;
    const target = commentId ? post.comments?.[commentId] : post;
    if (!target) return;
    
    const rx = target.reactions || {};
    const content = document.getElementById('reactors-content');
    let reactors = [];
    
    const icons = {
        like: '<i class="fa-solid fa-thumbs-up text-blue-500"></i>',
        heart: '<i class="fa-solid fa-heart text-pink-500"></i>',
        haha: '<i class="fa-solid fa-face-laugh-squint text-orange-500"></i>',
        wow: '<i class="fa-solid fa-face-surprise text-yellow-500"></i>',
        sad: '<i class="fa-solid fa-face-sad-cry text-indigo-500"></i>',
        angry: '<i class="fa-solid fa-face-angry text-red-500"></i>'
    };

    for (let type in rx) {
        for (let uid in rx[type]) {
            reactors.push({ uid, type });
        }
    }

    document.getElementById('reactors-total-count').innerText = reactors.length;

    if (reactors.length === 0) {
        content.innerHTML = "<p class='text-gray-500 font-normal text-center py-5'>No reactions yet.</p>";
    } else {
        content.innerHTML = reactors.map(r => {
            const u = window.globalUsersCache[r.uid] || { name: 'User', pic: window.generateAvatar(r.uid) };
            return `
            <div class="flex items-center justify-between p-2 rounded-lg mb-1 border border-gray-100 dark:border-slate-700/50 bg-gray-50 dark:bg-slate-900/50 hover:opacity-80 cursor-pointer transition" onclick="window.openProfile('${r.uid}'); document.getElementById('reactors-modal').classList.add('hidden');">
                <div class="flex items-center space-x-2">
                    <img src="${u.pic || window.generateAvatar(r.uid)}" loading="lazy" class="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-slate-600">
                    <span class="font-bold text-[13px] text-gray-900 dark:text-white">${u.name}</span>
                </div>
                <div class="text-base bg-white dark:bg-slate-800 min-w-[2rem] h-8 px-2 rounded-full flex items-center justify-center shadow-sm border border-gray-100 dark:border-slate-700 shrink-0">${icons[r.type] || `<span class="text-sm">${r.type}</span>`}</div>
            </div>
            `;
        }).join('');
    }
    
    document.getElementById('reactors-modal').classList.remove('hidden');
};

window.promptCustomReaction = (postId, authorId, commentId = null, commentAuthorId = null) => {
    if (!window.currentUser) {
        window.showAlert("You must be logged in to react.");
        return;
    }
    
    const modal = document.getElementById('edit-modal');
    const input = document.getElementById('edit-content-input');
    const saveBtn = document.getElementById('save-edit-btn');
    const title = modal.querySelector('h2');
    
    title.innerHTML = '<i class="fa-regular fa-face-smile text-blue-500 mr-2"></i> Add Custom Emoji';
    input.value = '';
    input.placeholder = 'Enter a single emoji...';
    
    saveBtn.onclick = () => {
        const emoji = input.value.trim();
        if (!emoji) return;
        
        if (emoji.length > 10) {
            window.showAlert("Please enter a valid emoji (keep it short).");
            return;
        }
        
        if (commentId) {
            window.reactComment(postId, commentId, commentAuthorId, emoji);
        } else {
            window.react(postId, authorId, emoji);
        }
        modal.classList.add('hidden');
    };
    
    modal.classList.remove('hidden');
    input.focus();
};

window.openRankingModal = () => {
    document.getElementById('ranking-modal').classList.remove('hidden');
    // Clear caches so data is fresh on every open
    window._earningsCache = null;
    window._hostedGamesCache = null;
    if (window.updateLbPeriodBar) window.updateLbPeriodBar();
    window.renderRankings(true);
};

window.renderRankings = async (resetLimit = true) => {
    const list = document.getElementById('ranking-list');
    const loader = document.getElementById('ranking-loader');
    
    if(resetLimit) window.rankingRenderLimit = 20;

    const currentScroll = list.scrollTop;
    list.style.minHeight = list.clientHeight + 'px';
    
    if(resetLimit) list.innerHTML = '';
    
    if (window.currentRankingFilter === "Earnings") {
        if (!window.currentUser) {
            list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">Please log in to view your earnings.</p>`;
            return;
        }
        
        // Use a cached version to prevent refetching during lazy loading if we already have it
        if (resetLimit || !window._earningsCache) {
            if(resetLimit) list.innerHTML = '';
            loader.classList.remove('hidden');
            try {
                const [newSnap, legacySnap] = await Promise.all([
                    get(ref(db, `earnings/${window.currentUser.uid}`)).catch(() => null),
                    get(ref(db, `users/${window.currentUser.uid}/earnings`)).catch(() => null)
                ]);
                loader.classList.add('hidden');
                
                let earningsArray = [];
                const seenEarningsKeys = new Set();
                if (newSnap && newSnap.exists()) {
                    newSnap.forEach(child => {
                        const val = child.val();
                        earningsArray.push({ id: child.key, ...val });
                        if (val && val.postId) seenEarningsKeys.add(`${val.postId}_${val.title}`);
                        seenEarningsKeys.add(child.key);
                    });
                }
                if (legacySnap && legacySnap.exists()) {
                    legacySnap.forEach(child => {
                        const val = child.val();
                        const postKey = val && val.postId ? `${val.postId}_${val.title}` : null;
                        if (!seenEarningsKeys.has(child.key) && (!postKey || !seenEarningsKeys.has(postKey))) {
                            earningsArray.push({ id: child.key, ...val });
                            seenEarningsKeys.add(child.key);
                            if (postKey) seenEarningsKeys.add(postKey);
                        }
                    });
                }

                if (earningsArray.length === 0) {
                    list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">You have no earnings yet.</p>`;
                    window._earningsCache = [];
                    return;
                }
                
                earningsArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                window._earningsCache = earningsArray;
            } catch (error) {
                console.error(error);
                loader.classList.add('hidden');
                list.innerHTML = `<p class="text-center text-red-500 text-sm py-4">Error loading earnings.</p>`;
                return;
            }
        }
        
        if (resetLimit) list.innerHTML = '';
        const earningsArray = window._earningsCache;

        // Build totals summary when showing from the beginning
        if (resetLimit && earningsArray.length > 0) {
            const totalLb = earningsArray.reduce((sum, e) => sum + (e.lbPoints || 0), 0);
            const totalPrize = earningsArray.reduce((sum, e) => {
                const str = (e.prize || '').toString().split(' + Bonus:')[0];
                const num = parseFloat(str.replace(/[^0-9.]/g, ''));
                return sum + (isNaN(num) ? 0 : num);
            }, 0);

            const summaryEl = document.createElement('div');
            summaryEl.className = 'flex items-center justify-around p-3 bg-gradient-to-r from-yellow-50 to-amber-50 dark:from-yellow-900/20 dark:to-amber-900/20 rounded-xl border border-yellow-200 dark:border-yellow-800/50 mb-3';
            summaryEl.innerHTML = `
                <div class="text-center">
                    <div class="text-xl font-black text-yellow-600 dark:text-yellow-400">🏆 ${totalLb}</div>
                    <div class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold mt-0.5">Total LB Points</div>
                </div>
                <div class="w-px h-10 bg-yellow-200 dark:bg-yellow-800/50"></div>
                <div class="text-center">
                    <div class="text-xl font-black text-green-600 dark:text-green-400">🎁 ${totalPrize > 0 ? 'PHP ' + totalPrize.toLocaleString() : (earningsArray.filter(e => e.prize).length + ' reward(s)')}</div>
                    <div class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold mt-0.5">Total Prize Value</div>
                </div>
                <div class="w-px h-10 bg-yellow-200 dark:bg-yellow-800/50"></div>
                <div class="text-center">
                    <div class="text-xl font-black text-blue-600 dark:text-blue-400">${earningsArray.length}</div>
                    <div class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold mt-0.5">Total Wins</div>
                </div>
            `;
            list.appendChild(summaryEl);
        }

        const toRender = earningsArray.slice(resetLimit ? 0 : window.rankingRenderLimit - 20, window.rankingRenderLimit);
        const fragment = document.createDocumentFragment();
        
        toRender.forEach(e => {
            const el = document.createElement('div');
            el.className = `flex flex-col p-3 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-100 dark:border-slate-700/50 mb-2`;
            
            const ts = e.timestamp?.toMillis ? e.timestamp.toMillis() : e.timestamp;
            const date = new Date(ts).toLocaleDateString();
            const badgesHtml = window.formatLogPrizeBadges(e.prize, e.lbPoints);
            
            el.innerHTML = `
                <div class="flex justify-between items-start mb-1">
                    <h4 class="font-bold text-sm text-gray-800 dark:text-gray-200 leading-tight">
                        ${escapeHtml(e.title)}
                    </h4>
                    <span class="text-[10px] text-gray-400 shrink-0 ml-2">${date}</span>
                </div>
                <div class="flex flex-wrap items-center gap-1 mb-1">
                    ${badgesHtml}
                </div>
                ${e.postId ? `<button onclick="window.goToPost('${e.postId}'); document.getElementById('ranking-modal').classList.add('hidden');" class="text-[10px] text-blue-500 hover:underline mt-1 self-start">View Game</button>` : ''}
            `;
            fragment.appendChild(el);
        });
        
        if (window.rankingRenderLimit < earningsArray.length) {
            const sentinel = document.createElement('div');
            sentinel.className = 'h-10 w-full flex items-center justify-center text-gray-400 text-xs py-2';
            sentinel.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
            fragment.appendChild(sentinel);
            list.appendChild(fragment);
            
            if(window.rankingObserver) window.rankingObserver.disconnect();
            window.rankingObserver = new IntersectionObserver((entries) => {
                if(entries[0].isIntersecting) {
                    window.rankingRenderLimit += 20;
                    // Remove old sentinel
                    const s = list.querySelector('.fa-spinner')?.closest('div');
                    if (s) s.remove();
                    window.renderRankings(false);
                }
            }, { rootMargin: "200px" });
            window.rankingObserver.observe(sentinel);
        } else {
            list.appendChild(fragment);
        }

    } else if (window.currentRankingFilter === "Host Log") {
        if (!window.currentUser) {
            list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">Please log in to view your host log.</p>`;
            return;
        }

        if (resetLimit || !window._hostedGamesCache) {
            if (resetLimit) list.innerHTML = '';
            loader.classList.remove('hidden');
            try {
                const [newSnap, legacySnap] = await Promise.all([
                    get(ref(db, `hostedGames/${window.currentUser.uid}`)).catch(() => null),
                    get(ref(db, `users/${window.currentUser.uid}/hostedGames`)).catch(() => null)
                ]);
                loader.classList.add('hidden');

                let hostedArray = [];
                const seenHostedKeys = new Set();
                if (newSnap && newSnap.exists()) {
                    newSnap.forEach(child => {
                        const val = child.val();
                        hostedArray.push({ id: child.key, ...val });
                        if (val && val.postId) seenHostedKeys.add(`${val.postId}_${val.title}`);
                        seenHostedKeys.add(child.key);
                    });
                }
                if (legacySnap && legacySnap.exists()) {
                    legacySnap.forEach(child => {
                        const val = child.val();
                        const postKey = val && val.postId ? `${val.postId}_${val.title}` : null;
                        if (!seenHostedKeys.has(child.key) && (!postKey || !seenHostedKeys.has(postKey))) {
                            hostedArray.push({ id: child.key, ...val });
                            seenHostedKeys.add(child.key);
                            if (postKey) seenHostedKeys.add(postKey);
                        }
                    });
                }

                if (hostedArray.length === 0) {
                    list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">You have no hosted games yet.</p>`;
                    window._hostedGamesCache = [];
                    return;
                }

                hostedArray.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

                // Filter to only show games with a monetary prize (PHP amount > 0)
                const prizedGames = hostedArray.filter(e => {
                    const prizeStr = (e.prize || '').toString().split('+')[0].trim();
                    const num = parseFloat(prizeStr.replace(/[^0-9.]/g, ''));
                    return !isNaN(num) && num > 0;
                });

                if (prizedGames.length === 0) {
                    list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">No games with monetary prizes yet.</p>`;
                    window._hostedGamesCache = [];
                    return;
                }

                window._hostedGamesCache = prizedGames;
            } catch (error) {
                console.error(error);
                loader.classList.add('hidden');
                list.innerHTML = `<p class="text-center text-red-500 text-sm py-4">Error loading host log.</p>`;
                return;
            }
        }

        if (resetLimit) list.innerHTML = '';
        const hostedArray = window._hostedGamesCache;

        // Summary banner
        if (resetLimit && hostedArray.length > 0) {
            const totalPrize = hostedArray.reduce((sum, e) => {
                const str = (e.prize || '').toString().split(' + Bonus:')[0];
                const num = parseFloat(str.replace(/[^0-9.]/g, ''));
                return sum + (isNaN(num) ? 0 : num);
            }, 0);
            const pendingCount = hostedArray.filter(e => e.paymentStatus !== 'paid').length;

            const summaryEl = document.createElement('div');
            summaryEl.className = 'flex items-center justify-around p-3 bg-gradient-to-r from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-xl border border-indigo-200 dark:border-indigo-800/50 mb-3';
            summaryEl.innerHTML = `
                <div class="text-center">
                    <div class="text-xl font-black text-indigo-600 dark:text-indigo-400">🎮 ${hostedArray.length}</div>
                    <div class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold mt-0.5">Games Hosted</div>
                </div>
                <div class="w-px h-10 bg-indigo-200 dark:bg-indigo-800/50"></div>
                <div class="text-center">
                    <div class="text-xl font-black text-green-600 dark:text-green-400">🎁 ${totalPrize > 0 ? 'PHP ' + totalPrize.toLocaleString() : (hostedArray.filter(e => e.prize).length + ' prize(s)')}</div>
                    <div class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold mt-0.5">Total Prize Given</div>
                </div>
                <div class="w-px h-10 bg-indigo-200 dark:bg-indigo-800/50"></div>
                <div class="text-center">
                    <div class="text-xl font-black text-orange-500 dark:text-orange-400">⏳ ${pendingCount}</div>
                    <div class="text-[10px] text-gray-500 dark:text-gray-400 font-semibold mt-0.5">Pending</div>
                </div>
            `;
            list.appendChild(summaryEl);
        }

        const toRender = hostedArray.slice(resetLimit ? 0 : window.rankingRenderLimit - 20, window.rankingRenderLimit);
        const fragment = document.createDocumentFragment();

        toRender.forEach(e => {
            const el = document.createElement('div');
            el.className = 'flex flex-col p-3 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-100 dark:border-slate-700/50 mb-2';

            const ts = e.timestamp?.toMillis ? e.timestamp.toMillis() : e.timestamp;
            const date = new Date(ts).toLocaleDateString();
            const badgesHtml = window.formatLogPrizeBadges(e.prize, e.lbPoints);
            const isPaid = e.paymentStatus === 'paid';
            const payBtn = `<button
                id="pay-btn-${e.id}"
                onclick="window.markHostedGamePaid('${e.id}', this)"
                class="text-[10px] font-bold px-2 py-0.5 rounded ml-auto shrink-0 ${isPaid ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-default' : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 hover:bg-orange-200 dark:hover:bg-orange-800/50 transition cursor-pointer'}"
                ${isPaid ? 'disabled' : ''}>
                ${isPaid ? '✅ Paid' : '⏳ Pending'}
            </button>`;

            el.innerHTML = `
                <div class="flex justify-between items-start mb-1">
                    <h4 class="font-bold text-sm text-gray-800 dark:text-gray-200 leading-tight truncate pr-2">${escapeHtml(e.title)}</h4>
                    <span class="text-[10px] text-gray-400 shrink-0">${date}</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400 mb-1.5">
                    🏆 Winner: <span class="font-semibold text-gray-700 dark:text-gray-300">${escapeHtml(e.winnerName || 'Unknown')}</span>
                </div>
                <div class="flex items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-1">
                        ${badgesHtml}
                    </div>
                    ${payBtn}
                </div>
                ${e.postId ? `<button onclick="window.goToPost('${e.postId}'); document.getElementById('ranking-modal').classList.add('hidden');" class="text-[10px] text-blue-500 hover:underline mt-1 self-start">View Game</button>` : ''}
            `;
            fragment.appendChild(el);
        });

        if (window.rankingRenderLimit < hostedArray.length) {
            const sentinel = document.createElement('div');
            sentinel.className = 'h-10 w-full flex items-center justify-center text-gray-400 text-xs py-2';
            sentinel.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
            fragment.appendChild(sentinel);
            list.appendChild(fragment);

            if (window.rankingObserver) window.rankingObserver.disconnect();
            window.rankingObserver = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting) {
                    window.rankingRenderLimit += 20;
                    const s = list.querySelector('.fa-spinner')?.closest('div');
                    if (s) s.remove();
                    window.renderRankings(false);
                }
            }, { rootMargin: "200px" });
            window.rankingObserver.observe(sentinel);
        } else {
            list.appendChild(fragment);
        }

    } else {
        // Leaderboards or Stars
        let usersArray = Object.keys(window.globalUsersCache).map(uid => ({uid, ...window.globalUsersCache[uid]})).filter(u => u.name);
        
        if (window.currentRankingFilter === "Leaderboards") {
            const scope = window.lbScope || 'overall';
            let lbMap = null;
            if (scope !== 'overall') {
                const period = window.lbPeriodKey || window.lbPeriodKeyFor(scope);
                const snap = await get(ref(db, `lb${scope === 'weekly' ? 'Weekly' : 'Monthly'}/${period}`)).catch(() => null);
                if (snap && snap.exists()) lbMap = snap.val();
            }
            const emptyPeriod = scope !== 'overall' && !lbMap;
            usersArray.forEach(u => {
                u.displayLb = scope === 'overall' ? (u.lbPoints || 0) : Number((lbMap || {})[u.uid] || 0);
            });
            usersArray.sort((a, b) => (b.displayLb || 0) - (a.displayLb || 0));
            if (emptyPeriod) {
                list.innerHTML = `<p class="text-center text-gray-500 dark:text-gray-400 text-xs py-4">No LB points recorded in this ${scope === 'weekly' ? 'week' : 'month'} yet.</p>`;
                return;
            }
        } else if (window.currentRankingFilter === "Stars") {
            usersArray.sort((a, b) => (b.points || 0) - (a.points || 0));
        }
        
        if(usersArray.length === 0) {
            list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">No users found.</p>`;
            return;
        }

        const toRender = usersArray.slice(resetLimit ? 0 : window.rankingRenderLimit - 20, window.rankingRenderLimit);
        const fragment = document.createDocumentFragment();

        toRender.forEach((u, idx) => {
            const rank = (resetLimit ? 0 : window.rankingRenderLimit - 20) + idx + 1;
            let rankHtml = `<div class="w-6 text-center font-bold text-gray-400 dark:text-gray-500 text-xs">#${rank}</div>`;
            if (rank === 1) rankHtml = `<div class="w-6 text-center text-yellow-500 text-lg"><i class="fa-solid fa-medal"></i></div>`;
            else if (rank === 2) rankHtml = `<div class="w-6 text-center text-gray-400 text-lg"><i class="fa-solid fa-medal"></i></div>`;
            else if (rank === 3) rankHtml = `<div class="w-6 text-center text-amber-600 text-lg"><i class="fa-solid fa-medal"></i></div>`;

            const el = document.createElement('div');
            el.className = `flex items-center justify-between p-2 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-100 dark:border-slate-700/50 mb-2`;
            
            const highlightValue = window.currentRankingFilter === "Leaderboards" 
                ? `<span class="text-yellow-600 dark:text-yellow-500 font-bold">🏆 ${u.displayLb !== undefined ? u.displayLb : (u.lbPoints || 0)}</span>` 
                : `<span class="text-yellow-600 dark:text-yellow-500 font-bold">⭐ ${u.points || 0}</span>`;
            
            el.innerHTML = `
                <div class="flex items-center space-x-3 overflow-hidden">
                    ${rankHtml}
                    <div class="relative shrink-0">
                        <img src="${u.pic || window.generateAvatar(u.uid)}" loading="lazy" class="w-9 h-9 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80" onclick="window.openProfile('${u.uid}'); document.getElementById('ranking-modal').classList.add('hidden');">
                    </div>
                    <div class="leading-tight truncate pr-2">
                        <div class="flex items-center">
                            <h3 class="font-bold text-sm text-gray-900 dark:text-white truncate cursor-pointer hover:underline" onclick="window.openProfile('${u.uid}'); document.getElementById('ranking-modal').classList.add('hidden');">${u.name}</h3>
                        </div>
                    </div>
                </div>
                <div class="flex items-center shrink-0 pr-1 text-sm">${highlightValue}</div>
            `;
            fragment.appendChild(el);
        });

        if (window.rankingRenderLimit < usersArray.length) {
            const sentinel = document.createElement('div');
            sentinel.className = 'h-10 w-full flex items-center justify-center text-gray-400 text-xs py-2';
            sentinel.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
            fragment.appendChild(sentinel);
            list.appendChild(fragment);
            
            if(window.rankingObserver) window.rankingObserver.disconnect();
            window.rankingObserver = new IntersectionObserver((entries) => {
                if(entries[0].isIntersecting) {
                    window.rankingRenderLimit += 20;
                    const s = list.querySelector('.fa-spinner')?.closest('div');
                    if (s) s.remove();
                    window.renderRankings(false);
                }
            }, { rootMargin: "200px" });
            window.rankingObserver.observe(sentinel);
        } else {
            list.appendChild(fragment);
        }
    }
    
    if(resetLimit) list.scrollTop = currentScroll;
    requestAnimationFrame(() => list.style.minHeight = '');
};

// ============================================================
// LEADERBOARD PERIOD CONTROLS (Weekly / Monthly / Overall)
// ============================================================
window.updateLbPeriodBar = () => {
    const bar = document.getElementById('ranking-period-bar');
    if (!bar) return;
    const isFilter = window.currentRankingFilter === 'Leaderboards';
    bar.classList.toggle('hidden', !isFilter);
    if (!isFilter) return;
    const scope = window.lbScope || 'overall';
    ['overall', 'weekly', 'monthly'].forEach(s => {
        const b = document.getElementById('lb-scope-' + s);
        if (!b) return;
        const on = s === scope;
        if (on) {
            b.classList.add('bg-blue-600', 'text-white', 'border-transparent');
            b.classList.remove('bg-gray-100', 'text-gray-700', 'dark:bg-slate-900', 'dark:text-gray-300');
        } else {
            b.classList.remove('bg-blue-600', 'text-white', 'border-transparent');
            b.classList.add('bg-gray-100', 'text-gray-700', 'dark:bg-slate-900', 'dark:text-gray-300');
        }
    });
    const nav = document.getElementById('lb-period-nav');
    const lbl = document.getElementById('lb-period-label');
    if (scope === 'overall') {
        if (nav) nav.classList.add('hidden');
        if (lbl) lbl.textContent = '';
    } else {
        const key = window.lbPeriodKey || window.lbPeriodKeyFor(scope);
        if (nav) nav.classList.remove('hidden');
        if (lbl) lbl.textContent = window.lbPeriodLabel(scope, key);
    }
};

window.setLbScope = (scope) => {
    window.lbScope = scope;
    window.lbPeriodKey = scope === 'overall' ? '' : window.lbPeriodKeyFor(scope);
    window.renderRankings(true);
    window.updateLbPeriodBar();
};

window.shiftLbPeriodView = (delta) => {
    const scope = window.lbScope;
    if (!scope || scope === 'overall') return;
    const cur = window.lbPeriodKey || window.lbPeriodKeyFor(scope);
    window.lbPeriodKey = window.shiftLbPeriod(scope, cur, delta);
    window.renderRankings(true);
    window.updateLbPeriodBar();
};

window.markHostedGamePaid = async (entryId, btn) => {
    if (!window.currentUser) return;
    try {
        btn.disabled = true;
        btn.textContent = 'Saving...';
        await Promise.all([
            update(ref(db, `hostedGames/${window.currentUser.uid}/${entryId}`), { paymentStatus: 'paid' }).catch(() => {}),
            update(ref(db, `users/${window.currentUser.uid}/hostedGames/${entryId}`), { paymentStatus: 'paid' }).catch(() => {})
        ]);
        // Update local cache so re-renders stay consistent
        if (window._hostedGamesCache) {
            const entry = window._hostedGamesCache.find(e => e.id === entryId);
            if (entry) entry.paymentStatus = 'paid';
        }
        btn.textContent = '✅ Paid';
        btn.className = btn.className.replace(/bg-orange-\S+ text-orange-\S+/g, 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 cursor-default');
    } catch(err) {
        console.error('Error marking paid:', err);
        btn.disabled = false;
        btn.textContent = '⏳ Pending';
    }
};