import { db } from "./firebase-config.js";
import { ref, update, set, push, remove, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

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
            else if(n.type === 'comment') { text = 'commented on your post.'; icon = '💬'; }
            else if(n.type === 'reply') { text = 'replied to your comment.'; icon = '↪️'; }
            else if(n.type === 'mention') { text = 'mentioned you.'; icon = '📣'; }
            else if(n.type === 'follow') { 
                text = 'started following you.'; icon = '👥'; 
                linkAction = `onclick="window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');"`; 
            }

            return `
            <div class="flex items-center p-2.5 rounded-lg mb-1 border border-gray-100 dark:border-slate-700/50 ${n.read ? 'bg-gray-50 dark:bg-slate-900/50 opacity-80' : 'bg-blue-50 dark:bg-blue-900/20'} hover:opacity-100 cursor-pointer transition shadow-sm" ${linkAction}>
                <img src="${u.pic}" loading="lazy" class="w-8 h-8 rounded-full object-cover mr-3 shrink-0 border border-gray-200 dark:border-slate-600" onclick="event.stopPropagation(); window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');">
                <div class="flex-1 text-[11px] leading-tight">
                    <span class="font-bold text-gray-900 dark:text-white hover:underline" onclick="event.stopPropagation(); window.openProfile('${n.sourceUid}'); document.getElementById('notif-modal').classList.add('hidden'); window.markNotifRead('${n.id}');">${u.name}</span>
                    <span class="text-gray-600 dark:text-gray-300 font-normal">${text}</span>
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
    window.renderProfileData(true);
    window.scrollTo(0,0);
};

window.closeProfile = () => {
    document.getElementById('profile-view').classList.add('hidden');
    document.getElementById('main-view').classList.remove('hidden');
    window.activeProfileUid = null;
    window.renderFeed(false);
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
                const compressed = await window.compressImage(file);
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
            const parts = ['post-header', 'post-body', 'reactions', 'comments'];
            parts.forEach(part => {
                const oldP = existingEl.querySelector(`#${part}-${prefix}-${post.id}`);
                const newP = newEl.querySelector(`#${part}-${prefix}-${post.id}`);
                if (oldP && newP && oldP.innerHTML !== newP.innerHTML) {
                    oldP.innerHTML = newP.innerHTML;
                    oldP.className = newP.className;
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
            feed.innerHTML = `<p class="text-center text-gray-500 py-10">Post not found or deleted.</p>
            <button onclick="window.clearIsolatedPost()" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-4 py-2 rounded-full mx-auto block mt-2 shadow-sm transition">Back to Feed</button>`;
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
        return;
    }
    
    const existingBanner = document.getElementById('isolated-banner');
    if (existingBanner) existingBanner.remove();

    searchBarContainer.classList.remove('hidden');
    catFilters.classList.remove('hidden');

    const postSearchQ = (document.getElementById('post-search')?.value || '').toLowerCase();
    
    let displayPosts = window.allPosts.filter(p => {
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
        return (b.timestamp || 0) - (a.timestamp || 0); 
    });

    const currentScroll = window.scrollY;
    const activeId = document.activeElement ? document.activeElement.id : null;
    const inputStates = window.saveInputStates();
    feed.style.minHeight = feed.clientHeight + 'px'; 
    
    if(displayPosts.length === 0) {
        feed.innerHTML = `<p class="text-center text-gray-400 text-xs py-10">No posts found.</p>`;
        feed.style.minHeight = '';
        return;
    }

    window.filteredPostsLength = displayPosts.length;
    const postsToRender = displayPosts.slice(0, window.feedRenderLimit);
    
    window.renderPostList(feed, postsToRender, 'main', window.currentFilter);

    if (window.feedRenderLimit < window.filteredPostsLength) {
        const sentinel = document.createElement('div');
        sentinel.className = 'sentinel-loader h-10 w-full flex items-center justify-center text-gray-400 text-xs py-2';
        sentinel.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
        feed.appendChild(sentinel);
        
        if(window.feedObserver) window.feedObserver.disconnect();
        window.feedObserver = new IntersectionObserver((entries) => {
            if(entries[0].isIntersecting) {
                window.feedRenderLimit += 15;
                window.renderFeed(false);
            }
        }, { rootMargin: "300px" });
        window.feedObserver.observe(sentinel);
    }

    window.restoreInputStates(inputStates);
    if (activeId) {
        const el = document.getElementById(activeId);
        if (el) { el.focus(); if(el.setSelectionRange && el.value) { try{ const len = el.value.length; el.setSelectionRange(len, len); }catch(e){} } }
    }
    window.scrollTo(0, currentScroll);
    requestAnimationFrame(() => feed.style.minHeight = '');
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
    if(window.currentUser && window.currentUser.uid !== window.activeProfileUid) {
        const isFollowing = window.globalUsersCache[window.currentUser.uid]?.following?.[window.activeProfileUid];
        followBtn = `<button onclick="window.toggleFollow('${window.activeProfileUid}')" class="mt-3 ${isFollowing ? 'bg-gray-200 text-gray-600 dark:bg-slate-700 dark:text-gray-300' : 'bg-blue-600 text-white'} text-xs font-bold px-5 py-1.5 rounded-full transition shadow-sm">${isFollowing ? 'Following' : 'Follow'}</button>`;
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
            <p class="text-sm text-gray-500 mt-1"><span class="text-yellow-500">⭐ ${uData.points || 0}</span> • <span class="text-blue-500">👥 ${followerCount}</span> Followers</p>
            
            ${relStr}
            ${followBtn}
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

    const pFeed = document.getElementById('profile-feed');
    let pPosts = window.allPosts.filter(p => {
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
        return (b.timestamp || 0) - (a.timestamp || 0); 
    });

    const currentScroll = window.scrollY;
    const activeId = document.activeElement ? document.activeElement.id : null;
    const inputStates = window.saveInputStates();
    pFeed.style.minHeight = pFeed.clientHeight + 'px';

    if(pPosts.length === 0) {
        pFeed.innerHTML = `<p class="text-center text-gray-500 text-xs py-5">No posts yet.</p>`;
        pFeed.style.minHeight = '';
        return;
    }

    const postsToRender = pPosts.slice(0, window.profileRenderLimit);
    window.renderPostList(pFeed, postsToRender, 'profile', 'profile');

    if (window.profileRenderLimit < pPosts.length) {
        const sentinel = document.createElement('div');
        sentinel.className = 'sentinel-loader h-10 w-full flex items-center justify-center text-gray-400 text-xs py-2';
        sentinel.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-lg"></i>';
        pFeed.appendChild(sentinel);
        
        if(window.profileObserver) window.profileObserver.disconnect();
        window.profileObserver = new IntersectionObserver((entries) => {
            if(entries[0].isIntersecting) {
                window.profileRenderLimit += 15;
                window.renderProfileData(false);
            }
        }, { rootMargin: "300px" });
        window.profileObserver.observe(sentinel);
    }

    window.restoreInputStates(inputStates);
    if (activeId) {
        const el = document.getElementById(activeId);
        if (el) { el.focus(); if(el.setSelectionRange && el.value) { try{const len = el.value.length; el.setSelectionRange(len,len);}catch(e){} } }
    }
    window.scrollTo(0, currentScroll);
    requestAnimationFrame(() => pFeed.style.minHeight = '');
};

window.generatePostHTML = function(post, prefix, filterContext) {
    const authorInfo = window.globalUsersCache[post.authorId] || { name: "Unknown", pic: window.generateAvatar(post.authorId), points: 0 };
    const roleData = window.getRole(post.authorId);
    const followerCount = authorInfo.followers ? Object.keys(authorInfo.followers).length : 0; 
    
    let timeStr = 'Just now';
    if (post.timestamp) {
        const d = new Date(post.timestamp);
        timeStr = d.toLocaleDateString([], {month:'short', day:'numeric'}) + ' at ' + d.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    }

    const isBannedAuthor = authorInfo.isBanned === true;
    const effectivelyPinned = window.isPostPinned(post, filterContext);
    const canComment = !post.locked || (window.currentUser && (window.currentUser.uid === post.authorId || window.getRole(window.currentUser.uid).level >= 2));

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
                            <div class="flex mt-1">
                                ${canComment ? `<button onclick="window.prepareReplyToReply('${cId}', '${prefix}', '${r.uid}')" class="text-[9px] text-gray-400 hover:text-blue-500 font-bold transition">Reply</button>` : ''}
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
        
        if(window.currentUser.uid === post.authorId || window.getRole(window.currentUser.uid).level >= 2) {
            adminControls += `<button onclick="window.toggleLock('${post.id}', ${post.locked})" class="text-gray-400 hover:text-orange-500 mr-2 text-xs" title="${post.locked ? 'Unlock Comments' : 'Lock Comments'}"><i class="fa-solid ${post.locked ? 'fa-lock text-orange-500' : 'fa-lock-open'}"></i></button>`;
        }

        if(window.currentUser.uid === post.authorId) {
            const isPriv = post.visibility === 'private';
            adminControls += `<button onclick="window.togglePostVisibility('${post.id}', '${post.visibility || 'public'}')" class="text-gray-400 hover:text-blue-500 mr-2 text-xs" title="${isPriv ? 'Make Public' : 'Make Private'}"><i class="fa-solid ${isPriv ? 'fa-eye-slash' : 'fa-eye'}"></i></button>`;
            adminControls += `<button onclick="window.editPost('${post.id}')" class="text-gray-400 hover:text-blue-500 mr-2 text-xs"><i class="fa-solid fa-pen"></i></button>`;
        }
        
        if(window.canDelete(post.authorId)) adminControls += `<button onclick="window.deleteItem('community_posts/${post.id}', '${post.authorId}')" class="text-gray-400 hover:text-red-500 text-xs"><i class="fa-solid fa-trash"></i></button>`;
    }

    const isCommentsOpen = window.openComments.has(post.id);
    const safePostText = window.formatText(post.text);

    const visibilityIcon = post.visibility === 'private'
        ? `<i class="fa-solid fa-eye-slash text-[10px] text-gray-400 ml-2" title="Private Post"></i>`
        : `<i class="fa-solid fa-eye text-[10px] text-blue-500 ml-2" title="Public Post"></i>`;

    postEl.innerHTML = `
        <div id="post-header-${prefix}-${post.id}" class="flex justify-between items-start mb-2">
            <div class="flex items-center space-x-2">
                <img src="${authorInfo.pic}" loading="lazy" class="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-slate-600 cursor-pointer hover:opacity-80 transition ${isBannedAuthor ? 'grayscale' : ''}" onclick="window.openProfile('${post.authorId}')">
                <div class="leading-tight">
                    <div class="flex items-center">
                        <h3 class="font-bold text-sm text-gray-900 dark:text-gray-100 cursor-pointer hover:underline ${isBannedAuthor ? 'line-through text-red-500' : ''}" onclick="window.openProfile('${post.authorId}')">${authorInfo.name}</h3>${roleData.badgeHtml}${visibilityIcon}
                        <span class="text-[9px] text-yellow-500 ml-1">⭐ ${authorInfo.points || 0}</span>
                        <span class="text-[9px] text-blue-500 ml-1 font-bold">👥 ${followerCount}</span>
                    </div>
                    <p class="text-[10px] text-gray-500">${timeStr} • <span class="bg-gray-100 dark:bg-slate-700 px-1 rounded">${post.category}</span></p>
                </div>
            </div>
            <div>${adminControls}</div>
        </div>
        
        <div id="post-body-${prefix}-${post.id}">
            ${post.text ? `<p class="text-sm text-gray-800 dark:text-gray-200 mb-1 whitespace-pre-wrap break-words leading-snug">${safePostText} ${post.edited ? '<span class="text-[10px] italic text-gray-400 ml-1 font-normal">(edited)</span>' : ''}</p>${window.generateEmbed(post.text)}` : ''}
            ${post.image ? `<img src="${post.image}" loading="lazy" class="w-full rounded-lg mb-2 object-cover max-h-80 border border-gray-100 dark:border-slate-700 shadow-sm mt-2 cursor-pointer hover:opacity-90 transition" onclick="window.viewImage('${post.image}')">` : ''}
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
                <button onclick="window.copyPostLink('${post.id}')" class="flex items-center text-gray-400 hover:text-blue-500 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition">
                    <i class="fa-solid fa-share"></i>
                </button>
                <button onclick="window.toggleComments('${post.id}', '${prefix}')" class="flex items-center space-x-1 text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 bg-gray-50 dark:bg-slate-900 px-2.5 py-1 rounded-full border border-gray-100 dark:border-slate-700/50 transition">
                    <i class="fa-regular fa-comment text-sm"></i> <span>${commentCount}</span>
                </button>
            </div>
        </div>
        
        <div id="comments-${prefix}-${post.id}" class="${isCommentsOpen ? '' : 'hidden'} mt-1 border-t border-gray-100 dark:border-slate-700 pt-1">
            ${commentsHtml}
            ${commentInputBox}
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
                    <p class="text-[10px] text-gray-500 mt-0.5"><span class="text-yellow-600 dark:text-yellow-500">⭐ ${u.points || 0}</span> • <span class="text-blue-500">👥 ${followerCount}</span></p>
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
    const post = window.allPosts.find(p => p.id === postId);
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