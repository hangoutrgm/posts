import { db, fsdb } from "./firebase-config.js";
import { ref, update, set, push, remove, increment, get, onValue } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Notifications
window.updateNotifBadge = () => {
    if(!window.currentUser) return;
    const myNotifs = window.globalUsersCache[window.currentUser.uid]?.notifications || {};
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
    
    const myNotifs = window.globalUsersCache[window.currentUser.uid]?.notifications || {};
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
                <img src="${u.pic}" loading="lazy" class="w-8 h-8 rounded-full object-cover mr-3 shrink-0 border border-gray-200 dark:border-slate-600" onclick="event.stopPropagation(); window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');">
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
    // Initial render will be handled by listenPosts response, but render the skeleton/header now:
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
    window.renderFeed(true);
    window.scrollTo(0,0);
};

window.clearIsolatedPost = () => {
    window.isolatedPostId = null;
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

    document.getElementById('profile-modal').classList.remove('hidden');
};

// Rendering Engine Functions (DOM Patching)
window.renderPostList = (container, postsToRender, prefix, filterContext) => {
    const validIds = new Set(postsToRender.map(p => `post-${prefix}-${p.id}`));
    const banner = container.querySelector('#isolated-banner');
    
    Array.from(container.children).forEach(child => {
        if (child.id && child.id.startsWith(`post-${prefix}-`) && !validIds.has(child.id)) {
            container.removeChild(child);
        }
    });

    const sentinel = container.querySelector('.sentinel-loader');
    if (sentinel) container.removeChild(sentinel);

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
    if(window.activeProfileUid) return; 
    const feed = document.getElementById('feed');
    const searchBarContainer = document.getElementById('search-bar-container');
    const catFilters = document.getElementById('category-filters');
    
    if (resetLimit) window.feedRenderLimit = 15;
    
    if (window.isolatedPostId) {
        const singlePost = window.allPosts.find(p => p.id === window.isolatedPostId);
        searchBarContainer.classList.add('hidden');
        catFilters.classList.add('hidden');

        if (!singlePost) {
            feed.innerHTML = `<div class="text-center text-gray-500 py-10">
                <i class="fa-solid fa-spinner fa-spin text-2xl mb-2 text-blue-600"></i>
                <p>Loading spotlight post...</p>
            </div>`;
            if (window.isolatedPostUnsubscribe) window.isolatedPostUnsubscribe();
            
            window.isolatedPostUnsubscribe = onSnapshot(doc(fsdb, 'community_posts', window.isolatedPostId), (snapshot) => {
                if (snapshot.exists()) {
                    const post = { id: snapshot.id, ...snapshot.data() };
                    
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
                } else {
                    feed.innerHTML = `<p class="text-center text-gray-500 py-10">Post not found or deleted.</p>
                    <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
                }
            }, (err) => {
                console.error("Error fetching isolated post:", err);
                feed.innerHTML = `<p class="text-center text-gray-500 py-10">Failed to load post.</p>
                <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
            });
            return;
        }

        const bannerId = 'isolated-banner';
        let banner = document.getElementById(bannerId);
        if(!banner) {
            feed.innerHTML = `<div id="${bannerId}" class="bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 p-3 rounded-xl mb-3 flex items-center justify-between shadow-sm border border-blue-100 dark:border-blue-800/50">
                <span class="text-sm font-bold"><i class="fa-solid fa-magnifying-glass mr-2"></i>Post Spotlight ✨</span>
                <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-full text-xs font-bold shadow-sm transition">Back to Feed</button>
            </div>`;
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
        // Prevent multiple end messages from stacking if feed is not wiped
        const existingMsg = feed.querySelector('.end-message-catchup');
        if (existingMsg) existingMsg.remove();
        
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
            followersHtml += `<div class="shrink-0 text-center w-12"><img src="${fData.pic}" loading="lazy" class="w-10 h-10 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 mx-auto" onclick="window.openProfile('${fid}')" title="${fData.name}"><p class="text-[9px] mt-1 text-gray-500 truncate text-center">${fData.name}</p></div>`;
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
            const pokes = snap.val()?.count || 0;
            const el = document.getElementById('personal-poke-stats');
            if(el) el.innerHTML = `You poked them: <span class="font-bold text-orange-400">${pokes} times</span>`;
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
                <img src="${uData.pic}" loading="lazy" class="w-20 h-20 rounded-full object-cover border-4 ${isBanned ? 'border-red-500 grayscale' : 'border-gray-50 dark:border-slate-700'}">
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
        endMessage.className = 'w-full text-center text-gray-400 dark:text-gray-500 text-xs py-4 font-semibold';
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
                        <img src="${rAuth.pic}" loading="lazy" class="w-5 h-5 rounded-full object-cover cursor-pointer hover:opacity-80 transition" onclick="window.openProfile('${r.uid}')">
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
                    <img src="${cAuth.pic}" loading="lazy" class="w-6 h-6 rounded-full object-cover cursor-pointer hover:opacity-80 transition" onclick="window.openProfile('${c.uid}')">
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
            const isProfilePinned = !!post.profilePinned || !!post.pinned;
            const isFeedPinned = !!post.feedPinned || (!!post.pinned && window.getRole(post.authorId).level >= 2);
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
        let prizeText = '';
        if (post.gamePrize) prizeText += `PRIZE: ${post.gamePrize}`;
        if (post.gameLbPoints) prizeText += (prizeText ? ' + ' : '') + `${post.gameLbPoints} LB Points`;
        const prizeStr = prizeText ? `<div class="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-center py-1.5 px-3 rounded-lg text-xs font-bold shadow-sm mb-2"><i class="fa-solid fa-gift mr-1"></i> ${prizeText}</div>` : '';
        
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
                        <div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-trophy mr-1"></i> ${winnerName} mined it first!</div>
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
                    outcomeHtml = `<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-xmark mr-1"></i> Game forfeited! (No winners)</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || "Someone";
                    outcomeHtml = `<div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-trophy mr-1"></i> ${winnerName} won the Last Comment!</div>`;
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
                    outcomeHtml = `<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-xmark mr-1"></i> @${targetUserName} failed the challenge!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-trophy mr-1"></i> Challenge Completed by ${winnerName}!</div>`;
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
                    outcomeHtml = `<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-xmark mr-1"></i> @${targetUserName} failed the challenge!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-trophy mr-1"></i> ${winnerName} mined it!</div>`;
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
                    displayContent = `<div class="text-2xl font-bold text-blue-700 dark:text-blue-300 mb-2">${post.gameEmojiName || 'Emoji'}</div>`;
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
                    outcomeHtml = `<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-xmark mr-1"></i> No one guessed it!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm text-center"><i class="fa-solid fa-trophy mr-1"></i> ${winnerName} won!</div>`;
                }
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center opacity-80">
                        ${prizeStr}
                        <div class="text-2xl mb-1">${revealedChar} ${post.gameEmojiName || ''}</div>
                        ${outcomeHtml}
                    </div>`;
            }
        } else if (['flags', 'math', 'jumbled_words', 'trivia'].includes(post.gameType)) {
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
                    outcomeHtml = `<div class="bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 font-bold px-4 py-2 rounded-full text-sm text-center mt-2"><i class="fa-solid fa-xmark mr-1"></i> No one got it in time!</div>`;
                } else {
                    const winnerName = window.globalUsersCache[post.gameWinner]?.name || post.gameWinner;
                    outcomeHtml = `<div class="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 font-bold px-4 py-2 rounded-full text-sm text-center mt-2"><i class="fa-solid fa-trophy mr-1"></i> ${winnerName} won!</div>`;
                }
                
                let answerReveal = '';
                if (post.gameType === 'flags') {
                    const flagImgSrc = post.gameFlagCode ? `https://flagcdn.com/w80/${post.gameFlagCode}.png` : '';
                    answerReveal = `<div class="flex flex-col items-center mb-1">${flagImgSrc ? `<img src="${flagImgSrc}" class="h-12 rounded shadow mb-1 border border-gray-200" alt="Flag">` : ''}<span class="font-bold">${post.gameFlagName}</span></div>`;
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
            
            const animatingItem = (post.spinNamesLastSpin && Date.now() - post.spinNamesLastSpin.startTime < 4000) ? post.spinNamesLastSpin.item : null;
            const winnersList = Array.isArray(post.spinNamesWinners) ? post.spinNamesWinners : [];
            
            if (post.spinNamesPhase === 'submission') {
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-blue-50 to-cyan-50 dark:from-slate-800 dark:to-slate-800 rounded-xl border-2 border-blue-200 dark:border-blue-900/50 flex flex-col items-center">
                        <h4 class="font-black text-blue-800 dark:text-blue-200 text-lg mb-1">🎡 Spin the Names!</h4>
                        <p class="text-xs text-gray-600 dark:text-gray-300 mb-2">Join the draw for a chance to win.</p>
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
                
                // Show current target for this spin (which spin is this?)
                const currentSpinNum = winnersList.length + (isSpinning ? 1 : 1);
                
                let displayWinners = winnersList;
                if (isSpinning && winnersList.length > 0) {
                    const lastWinner = winnersList[winnersList.length - 1];
                    if (lastWinner.name === animatingItem) {
                        displayWinners = winnersList.slice(0, -1);
                    }
                }
                
                let winnersHtml = displayWinners.length > 0 
                    ? displayWinners.map((w, idx) => `<div class="text-[10px] bg-white dark:bg-slate-700 rounded px-2 py-1 shadow-sm mb-1">Spin #${w.target}: <strong>${w.name}</strong> - ${w.prize}</div>`).join('')
                    : `<span class="text-xs text-gray-400">None yet</span>`;
                    
                gameHtml = `
                    <div class="mt-3 mb-2 p-4 bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-slate-800 dark:to-slate-800 rounded-xl border-2 border-indigo-300 dark:border-indigo-900/50 flex flex-col items-center overflow-hidden">
                        <h4 class="font-black text-indigo-800 dark:text-indigo-200 text-base mb-1">🎡 Draw in Progress!</h4>
                        <p class="text-xs text-gray-500 mb-2"><i class="fa-solid fa-users mr-1"></i>${entryCount} players in wheel</p>
                        
                        <div class="relative my-3 transform transition-all duration-300 ${canvasClass}">
                            <div class="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1 z-10 text-red-500 text-2xl leading-none drop-shadow-md">▼</div>
                            <canvas id="spin-names-wheel-${post.id}" width="200" height="200" class="rounded-full shadow-lg border-4 border-indigo-400 bg-white dark:bg-slate-700"></canvas>
                        </div>
                        
                        <div class="w-full mb-3 text-center">
                            <p class="text-xs font-bold text-gray-600 dark:text-gray-300 mb-1.5">Winners so far:</p>
                            <div class="flex flex-col items-center gap-1">${winnersHtml}</div>
                        </div>
                        
                        ${isHost ? `<div class="flex gap-2 w-full"><button id="spin-names-btn-${post.id}" onclick="window.drawSpinNamesItem('${post.id}')" ${isSpinning ? 'disabled' : ''} class="flex-1 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-400 hover:to-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black py-2 rounded-full shadow transition"><i class="fa-solid fa-play mr-2"></i>SPIN!</button></div>` : ''}
                    </div>`;
                
                if (!window._bingoRenderQueue) window._bingoRenderQueue = [];
                window._bingoRenderQueue.push({ id: post.id, postData: post }); // Reuse bingo queue to trigger canvas drawing
                
            } else if (post.spinNamesPhase === 'ended' || post.gameStatus === 'ended') {
                let winnersHtml = winnersList.length > 0 
                    ? winnersList.map((w, idx) => `<div class="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-300 text-xs font-bold px-3 py-2 rounded mb-1 shadow-sm"><i class="fa-solid fa-trophy mr-1 text-yellow-500"></i>${w.name} won ${w.prize}! (Spin #${w.target})</div>`).join('')
                    : `<div class="bg-gray-100 dark:bg-gray-800 text-gray-500 text-xs font-bold px-3 py-2 rounded">No winners.</div>`;
                    
                gameHtml = `
                    <div class="mt-3 mb-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-xl border border-gray-200 dark:border-slate-700 flex flex-col items-center text-center opacity-90">
                        <h4 class="font-black text-gray-700 dark:text-gray-300 text-base mb-2">🎡 Spin the Names Ended</h4>
                        <div class="w-full mb-2 flex flex-col items-center">
                            ${winnersHtml}
                        </div>
                    </div>`;
            }
        } else if (post.gameType === 'ncl') {
            const winnerName = post.gameWinner ? (window.globalUsersCache[post.gameWinner]?.name || 'Someone') : 'Someone';
            gameHtml = `
                <div class="mt-3 mb-2 p-4 bg-gradient-to-r from-pink-100 to-rose-100 dark:from-pink-900/40 dark:to-rose-900/40 rounded-xl border-2 border-pink-300 dark:border-pink-700/50 flex flex-col items-center text-center shadow-sm">
                    <div class="text-3xl mb-2">🎁</div>
                    <h4 class="font-black text-pink-800 dark:text-pink-300 text-lg mb-1">ncl @${winnerName}</h4>
                    <div class="mt-2 bg-white dark:bg-slate-800/80 px-4 py-2 rounded-lg font-bold text-pink-600 dark:text-pink-400 shadow-inner text-sm">
                        ${post.gamePrize}
                    </div>
                </div>`;
        }
    }

    postEl.innerHTML = `
        <div id="post-header-${prefix}-${post.id}" class="flex flex-col mb-2">
            ${repostBanner}
            <div class="flex justify-between items-start">
                <div class="flex items-center space-x-2 min-w-0">
                    <img src="${authorInfo.pic}" loading="lazy" class="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 transition shrink-0 ${isBannedAuthor ? 'grayscale' : ''}" onclick="window.openProfile('${displayAuthorId}')">
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
            ${post.image ? ((post.image.includes('/video/upload/') || post.image.match(/\.(mp4|webm|mov|ogg)$/i)) ? `<video src="${post.image}" controls class="w-full rounded-lg mb-2 max-h-96 bg-black mt-2"></video>` : `<img src="${post.image}" loading="lazy" class="w-full rounded-lg mb-2 object-cover max-h-80 border border-gray-100 dark:border-slate-700 shadow-sm mt-2 cursor-pointer hover:opacity-90 transition" onclick="window.viewImage('${post.image}')">`) : ''}
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
                <button onclick="window.refreshSinglePost('${post.id}')" class="flex items-center text-gray-400 hover:text-blue-500 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition" title="Refresh Post">
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
                    <img src="${u.pic}" loading="lazy" class="w-10 h-10 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 ${u.isBanned ? 'grayscale' : ''}" onclick="window.openProfile('${u.uid}')">
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
                    <img src="${u.pic}" loading="lazy" class="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-slate-600">
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
                const snap = await get(ref(db, `users/${window.currentUser.uid}/earnings`));
                loader.classList.add('hidden');
                
                if (!snap.exists()) {
                    list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">You have no earnings yet.</p>`;
                    window._earningsCache = [];
                    return;
                }
                
                let earningsArray = [];
                snap.forEach(child => {
                    earningsArray.push({ id: child.key, ...child.val() });
                });
                
                earningsArray.sort((a, b) => b.timestamp - a.timestamp);
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
                const num = parseFloat((e.prize || '').toString().replace(/[^0-9.]/g, ''));
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
                    <div class="text-xl font-black text-green-600 dark:text-green-400">🎁 ${totalPrize > 0 ? totalPrize : earningsArray.filter(e => e.prize).length + ' reward(s)'}</div>
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
            const prizeStr = e.prize ? `<span class="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded text-xs font-bold mr-1">🎁 ${e.prize}</span>` : '';
            const lbStr = e.lbPoints ? `<span class="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 px-2 py-0.5 rounded text-xs font-bold">🏆 +${e.lbPoints}</span>` : '';
            
            el.innerHTML = `
                <div class="flex justify-between items-start mb-1">
                    <h4 class="font-bold text-sm text-gray-800 dark:text-gray-200 leading-tight">
                        ${e.title}
                    </h4>
                    <span class="text-[10px] text-gray-400 shrink-0 ml-2">${date}</span>
                </div>
                <div class="flex items-center mb-1">
                    ${prizeStr}${lbStr}
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
                const snap = await get(ref(db, `users/${window.currentUser.uid}/hostedGames`));
                loader.classList.add('hidden');

                if (!snap.exists()) {
                    list.innerHTML = `<p class="text-center text-gray-500 text-sm py-4">You have no hosted games yet.</p>`;
                    window._hostedGamesCache = [];
                    return;
                }

                let hostedArray = [];
                snap.forEach(child => {
                    hostedArray.push({ id: child.key, ...child.val() });
                });
                hostedArray.sort((a, b) => b.timestamp - a.timestamp);
                window._hostedGamesCache = hostedArray;
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
                const num = parseFloat((e.prize || '').toString().replace(/[^0-9.]/g, ''));
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
                    <div class="text-xl font-black text-green-600 dark:text-green-400">🎁 ${totalPrize > 0 ? totalPrize : hostedArray.filter(e => e.prize).length + ' prize(s)'}</div>
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
            const prizeStr = e.prize ? `<span class="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded text-xs font-bold">🎁 ${e.prize}</span>` : '';
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
                    <h4 class="font-bold text-sm text-gray-800 dark:text-gray-200 leading-tight truncate pr-2">${e.title}</h4>
                    <span class="text-[10px] text-gray-400 shrink-0">${date}</span>
                </div>
                <div class="text-xs text-gray-500 dark:text-gray-400 mb-1.5">
                    🏆 Winner: <span class="font-semibold text-gray-700 dark:text-gray-300">${e.winnerName || 'Unknown'}</span>
                </div>
                <div class="flex items-center gap-2">
                    ${prizeStr}
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
            usersArray.sort((a, b) => (b.lbPoints || 0) - (a.lbPoints || 0));
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
                ? `<span class="text-yellow-600 dark:text-yellow-500 font-bold">🏆 ${u.lbPoints || 0}</span>` 
                : `<span class="text-yellow-600 dark:text-yellow-500 font-bold">⭐ ${u.points || 0}</span>`;
            
            el.innerHTML = `
                <div class="flex items-center space-x-3 overflow-hidden">
                    ${rankHtml}
                    <div class="relative shrink-0">
                        <img src="${u.pic}" loading="lazy" class="w-9 h-9 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80" onclick="window.openProfile('${u.uid}'); document.getElementById('ranking-modal').classList.add('hidden');">
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

window.markHostedGamePaid = async (entryId, btn) => {
    if (!window.currentUser) return;
    try {
        btn.disabled = true;
        btn.textContent = 'Saving...';
        await update(ref(db, `users/${window.currentUser.uid}/hostedGames/${entryId}`), { paymentStatus: 'paid' });
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