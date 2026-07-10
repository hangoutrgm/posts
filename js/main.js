// main.js
import { app, auth, db } from "./firebase-config.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, push, onValue, set, update, remove, serverTimestamp, increment, onDisconnect } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import "./globals.js";
import "./helpers.js";
import "./renderers.js";

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
        window.renderFeed(true);
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

// ==========================================
// V6.1 & V6.2 FEATURES: VISIBILITY & MENTIONS
// ==========================================
window.postVisibility = 'public';
window.currentMentionMatch = null;

// V6.2 OVERRIDE: Upgraded notification system with @everyone capability
window.notifyMentions = (text, postId) => {
    if(!window.currentUser) return;
    const myRole = window.getRole(window.currentUser.uid).level;
    
    // Check if user is Mod/Admin and triggered @everyone
    if (myRole >= 2 && text.toLowerCase().includes('@everyone')) {
        Object.keys(window.globalUsersCache).forEach(uid => {
            if (uid !== window.currentUser.uid) {
                push(ref(db, `users/${uid}/notifications`), {
                    type: 'mention', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false
                });
            }
        });
        return; // Prevent duplicate individual notifications
    }
    
    // Standard Individual Mentions
    const matches = text.match(/@(\w+)/g);
    if(matches) {
        matches.forEach(match => {
            const name = match.substring(1).toLowerCase();
            const targetUser = Object.values(window.globalUsersCache).find(u => u.name && u.name.toLowerCase() === name);
            if(targetUser && targetUser.uid !== window.currentUser.uid) {
                push(ref(db, `users/${targetUser.uid}/notifications`), {
                    type: 'mention', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false
                });
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
            eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 text-lg mr-1.5"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
            // V6.2 UI FIX: Added mr-3 margin and inserting BEFORE the submit button
            eyeBtn.className = 'mr-2 px-3 py-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-slate-700 transition flex items-center justify-center shrink-0 cursor-pointer';
            eyeBtn.title = "Public Post";
            
            eyeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.postVisibility === 'public') {
                    window.postVisibility = 'private';
                    // Update this line:
                    eyeBtn.innerHTML = '<i class="fas fa-eye-slash text-gray-500 text-lg mr-1.5"></i><span class="text-xs font-bold text-gray-500">Private</span>';
                    eyeBtn.title = "Private Post (Only you and mentioned users)";
                    if(window.showAlert) window.showAlert("Post set to Private");
                } else {
                    window.postVisibility = 'public';
                    // Update this line:
                    eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 text-lg mr-1.5"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
                    eyeBtn.title = "Public Post";
                    if(window.showAlert) window.showAlert("Post set to Public");
                }
            });
            
            // Insert exactly before the submit button
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
            suggestionBox.className = 'hidden absolute z-50 bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 shadow-lg rounded-md mt-1 overflow-y-auto max-h-48';
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
                
                // V6.2 FEATURE: @everyone suggestion for Mods and Admins
                if (myRole >= 2 && "everyone".includes(query)) {
                    matchedUsers.unshift({ name: "everyone", isEveryone: true });
                }
                
                if (matchedUsers.length > 0) {
                    suggestionBox.innerHTML = '';
                    matchedUsers.forEach(u => {
                        const item = document.createElement('div');
                        item.className = 'p-2 hover:bg-gray-100 dark:hover:bg-slate-700 cursor-pointer flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 transition';
                        
                        const iconHtml = u.isEveryone 
                            ? `<div class="w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center text-[10px] shadow-sm"><i class="fa-solid fa-bullhorn"></i></div>` 
                            : `<img src="${u.pic || window.generateAvatar(u.uid || 'guest')}" class="w-6 h-6 rounded-full object-cover">`;

                        item.innerHTML = `${iconHtml} <span class="${u.isEveryone ? 'font-bold text-red-500' : ''}">${u.name}</span>`;
                        
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
onValue(ref(db, '.info/connected'), (snap) => {
    if (snap.val() === true && auth.currentUser) {
        const myPresenceRef = ref(db, `presence/${auth.currentUser.uid}`);
        onDisconnect(myPresenceRef).remove();
        set(myPresenceRef, true);
    }
});

onValue(ref(db, 'presence'), (snap) => {
    window.onlineUsers = snap.val() || {};
    document.getElementById('online-count').innerText = snap.size || 0;
    if(!document.getElementById('members-modal').classList.contains('hidden')) window.renderMembers(false);
    if(window.activeProfileUid) window.renderProfileData(false);
});

onValue(ref(db, 'users'), (snap) => {
    window.globalUsersCache = snap.val() || {};
    if(window.activeProfileUid) window.renderProfileData(false); else window.renderFeed(false);
    if(!document.getElementById('members-modal').classList.contains('hidden')) window.renderMembers(false);
    
    if(window.currentUser && window.globalUsersCache[window.currentUser.uid]) {
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
    
    window.updateNotifBadge();
    window.handleDeepLinks();
});

onValue(ref(db, 'community_posts'), (snapshot) => {

    const newPosts = [];

    snapshot.forEach(child => {
        newPosts.push({
            id: child.key,
            ...child.val()
        });
    });

    // Don't redraw if nothing actually changed
    const oldData = JSON.stringify(window.allPosts);
    const newData = JSON.stringify(newPosts);

    if (oldData === newData) {
        return;
    }

    window.allPosts = newPosts;

// Don't redraw while the user is typing.
if (!window.isUserTyping) {

    if (window.activeProfileUid)
        window.renderProfileData(false);
    else
        window.renderFeed(false);

}

window.handleDeepLinks();
});

// ==========================================
// ACTIONS (POST/COMMENT/EDIT)
// ==========================================
document.getElementById('submit-post-btn').addEventListener('click', async () => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return; 
    
    const text = document.getElementById('post-text').value.trim();
    const fileInput = document.getElementById('post-image-file');
    const file = fileInput.files[0];
    let imgUrl = document.getElementById('post-image-url').value.trim();
    
    if (!text && !imgUrl && !file) return;
    
    const btn = document.getElementById('submit-post-btn');
    btn.innerText = "Processing...";
    btn.disabled = true;

    try {
        let finalImage = imgUrl; 
        if (file) {
            const today = new Date().toLocaleDateString('en-CA');
            const userData = window.globalUsersCache[window.currentUser.uid] || {};
            const uploadsToday = userData.uploadStats?.date === today ? userData.uploadStats.count : 0;
            
            if (uploadsToday >= 5) {
                window.showAlert("You have reached your daily limit of 5 image uploads.");
                btn.innerText = "Post"; btn.disabled = false; return;
            }
            
            btn.innerText = "Compressing...";
            finalImage = await window.compressImage(file); 
            update(ref(db, `users/${window.currentUser.uid}/uploadStats`), { date: today, count: increment(1) });
        }

        const postRef = push(ref(db, 'community_posts'));
        await set(postRef, {
            authorId: window.currentUser.uid, text: text, image: finalImage,
            category: document.getElementById('post-category').value,
            timestamp: serverTimestamp(), pinned: false, edited: false, locked: false, reactions: {},
            visibility: window.postVisibility || 'public' 
        });
        
        update(ref(db, `users/${window.currentUser.uid}`), { points: increment(10) });
        window.notifyMentions(text, postRef.key);
        
        document.getElementById('post-text').value = '';
        document.getElementById('post-image-url').value = '';
        fileInput.value = '';
        document.getElementById('file-name').innerText = '';
        window.clearIsolatedPost();

        window.postVisibility = 'public';
        const eyeBtn = document.getElementById('visibility-toggle-btn');
        if(eyeBtn) {
            // Update this line to include the span!
            eyeBtn.innerHTML = '<i class="fas fa-eye text-blue-500 text-lg mr-1.5"></i><span class="text-xs font-bold text-gray-600 dark:text-gray-300">Public</span>';
            eyeBtn.title = "Public Post";
        }
        
    } catch (err) { window.showAlert("Failed to post: " + err.message); }
    
    btn.innerText = "Post"; btn.disabled = false;
});

window.submitComment = async (postId, postAuthorId, prefix) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    
    const input = document.getElementById(`comment-input-${prefix}-${postId}`); 
    const text = input.value.trim(); 
    const fileInput = document.getElementById(`comment-image-${prefix}-${postId}`);
    const file = fileInput ? fileInput.files[0] : null;
    
    if (!text && !file) return;

    input.value = '';
    if (fileInput) { fileInput.value = ''; document.getElementById(`comment-img-name-${prefix}-${postId}`).innerText = ''; }
    
    const btn = document.getElementById(`comment-submit-btn-${prefix}-${postId}`);
    if(btn) { btn.innerText = "..."; btn.disabled = true; }

    let finalImage = null;
    if (file) {
        try { 
            finalImage = await window.compressImage(file, true);
        } catch(e) { 
            console.error("Compression failed", e); 
            if(btn) { btn.innerText = "Send"; btn.disabled = false; }
            return;
        }
    }

    await push(ref(db, `community_posts/${postId}/comments`), { 
        uid: window.currentUser.uid, 
        text: text, 
        image: finalImage,
        timestamp: Date.now(), 
        edited: false 
    });
    update(ref(db, `users/${window.currentUser.uid}`), { points: increment(1) });
    
    if(window.currentUser.uid !== postAuthorId && postAuthorId !== "undefined") {
        update(ref(db, `users/${postAuthorId}`), { points: increment(1) });
        push(ref(db, `users/${postAuthorId}/notifications`), { 
            type: 'comment', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
        });
    }

    window.notifyMentions(text, postId);
    if(btn) { btn.innerText = "Send"; btn.disabled = false; }
};

window.submitReply = (postId, commentId, prefix, commentAuthorId) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    const input = document.getElementById(`reply-input-${prefix}-${commentId}`); 
    const text = input.value.trim(); if (!text) return;
    
    input.value = '';
    
    push(ref(db, `community_posts/${postId}/comments/${commentId}/replies`), { uid: window.currentUser.uid, text: text, timestamp: Date.now(), edited: false });
    update(ref(db, `users/${window.currentUser.uid}`), { points: increment(1) });
    
    if(window.currentUser.uid !== commentAuthorId && commentAuthorId !== "undefined") {
        push(ref(db, `users/${commentAuthorId}/notifications`), { 
            type: 'reply', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
        });
    }

    window.notifyMentions(text, postId);
    window.openRepliesList.add(commentId);
    window.renderFeed(false); 
};

window.react = (postId, postAuthorId, type) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    let post = window.allPosts.find(p => p.id === postId); if(!post) return;
    const hasReacted = post.reactions && post.reactions[type] && post.reactions[type][window.currentUser.uid];
    if(hasReacted) {
        remove(ref(db, `community_posts/${postId}/reactions/${type}/${window.currentUser.uid}`));
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") update(ref(db, `users/${postAuthorId}`), { points: increment(-1) });
    } else {
        set(ref(db, `community_posts/${postId}/reactions/${type}/${window.currentUser.uid}`), true);
        if(postAuthorId !== window.currentUser.uid && postAuthorId !== "undefined") {
            update(ref(db, `users/${postAuthorId}`), { points: increment(1) });
            push(ref(db, `users/${postAuthorId}/notifications`), { 
                type: 'react_post', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
            });
        }
    }
};

window.reactComment = (postId, commentId, commentAuthorId, type) => {
    if (!window.currentUser) return document.getElementById('auth-modal').classList.remove('hidden');
    if (window.checkBan()) return;
    let post = window.allPosts.find(p => p.id === postId); if(!post) return;
    let comment = post.comments && post.comments[commentId]; if(!comment) return;
    const hasReacted = comment.reactions && comment.reactions[type] && comment.reactions[type][window.currentUser.uid];
    if(hasReacted) {
        remove(ref(db, `community_posts/${postId}/comments/${commentId}/reactions/${type}/${window.currentUser.uid}`));
        if(commentAuthorId !== window.currentUser.uid && commentAuthorId !== "undefined") update(ref(db, `users/${commentAuthorId}`), { points: increment(-1) });
    } else {
        set(ref(db, `community_posts/${postId}/comments/${commentId}/reactions/${type}/${window.currentUser.uid}`), true);
        if(commentAuthorId !== window.currentUser.uid && commentAuthorId !== "undefined") {
            update(ref(db, `users/${commentAuthorId}`), { points: increment(1) });
            push(ref(db, `users/${commentAuthorId}/notifications`), { 
                type: 'react_comment', sourceUid: window.currentUser.uid, postId: postId, timestamp: Date.now(), read: false 
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
        update(ref(db, window.activeEditTarget.path), { text: newText, edited: true });
        window.notifyMentions(newText, window.activeEditTarget.postId);
    }
    document.getElementById('edit-modal').classList.add('hidden');
    window.activeEditTarget = null;
});

window.editPost = (postId) => {
    const post = window.allPosts.find(p => p.id === postId);
    if (!post || post.authorId !== window.currentUser.uid) return;
    window.openEditModal({ path: `community_posts/${postId}`, postId: postId }, post.text);
};

window.editComment = (postId, cId) => {
    const post = window.allPosts.find(p => p.id === postId);
    if (!post || !post.comments || !post.comments[cId]) return;
    const c = post.comments[cId];
    if (c.uid !== window.currentUser.uid) return;
    window.openEditModal({ path: `community_posts/${postId}/comments/${cId}`, postId: postId }, c.text);
};

window.editReply = (postId, cId, rId) => {
    const post = window.allPosts.find(p => p.id === postId);
    if (!post || !post.comments || !post.comments[cId] || !post.comments[cId].replies || !post.comments[cId].replies[rId]) return;
    const r = post.comments[cId].replies[rId];
    if (r.uid !== window.currentUser.uid) return;
    window.openEditModal({ path: `community_posts/${postId}/comments/${cId}/replies/${rId}`, postId: postId }, r.text);
};

window.togglePostVisibility = (postId, currentVis) => {
    const newVis = currentVis === 'private' ? 'public' : 'private';
    update(ref(db, `community_posts/${postId}`), { visibility: newVis });
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
    if(!['In a relationship', 'Engaged', 'Married', 'Complicated'].includes(relationship)) partner = '';

    let newPicUrl = document.getElementById('profile-pic-url').value.trim();
    const fileInput = document.getElementById('profile-pic-file');
    const file = fileInput.files[0];
    
    const btn = document.getElementById('save-profile-btn');
    btn.innerText = "Saving..."; btn.disabled = true;

    let finalPic = newPicUrl;
    try {
        if(file) finalPic = await window.compressImage(file);
    } catch(e) { console.error("Compression failed", e); }
    
    if(!finalPic) finalPic = cache.pic || window.currentUser.photoURL || window.generateAvatar(window.currentUser.uid);

    if(window.currentUser) {
        try {
            await update(ref(db, `users/${window.currentUser.uid}`), { name: finalName, pic: finalPic, gender, relationship, partner });
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
    try {
        if (window.isSignUpMode) {
            const cred = await createUserWithEmailAndPassword(auth, email, pass);
            const newName = `User_${Math.floor(Math.random()*999)}`;
            const newPic = window.generateAvatar(cred.user.uid);
            await updateProfile(cred.user, { displayName: newName, photoURL: newPic });
            
            update(ref(db, `users/${cred.user.uid}`), { name: newName, pic: newPic });
            document.getElementById('nav-avatar').src = newPic;
        } else await signInWithEmailAndPassword(auth, email, pass);
        document.getElementById('auth-modal').classList.add('hidden');
    } catch (error) { showError(error.message.replace('Firebase:', '')); }
});

document.getElementById('guest-login-btn').addEventListener('click', async () => {
    const guestEmail = `guest_${window.deviceId}@hangout.local`, guestPass = window.deviceId + "_secret";
    try { await signInWithEmailAndPassword(auth, guestEmail, guestPass); document.getElementById('auth-modal').classList.add('hidden'); } 
    catch {
        try {
            const cred = await createUserWithEmailAndPassword(auth, guestEmail, guestPass);
            const newName = `Guest_${Math.floor(Math.random()*999)}`;
            const newPic = window.generateAvatar(cred.user.uid);
            await updateProfile(cred.user, { displayName: newName, photoURL: newPic });
            
            update(ref(db, `users/${cred.user.uid}`), { name: newName, pic: newPic });
            document.getElementById('nav-avatar').src = newPic;
            document.getElementById('auth-modal').classList.add('hidden');
        } catch(e) { showError("Failed to create guest account."); }
    }
});

document.getElementById('logout-btn').addEventListener('click', () => { 
    if(window.currentUser) remove(ref(db, `presence/${window.currentUser.uid}`)); 
    signOut(auth); 
});

onAuthStateChanged(auth, (user) => {
    window.currentUser = user;
    if (user) {
        update(ref(db, `users/${user.uid}`), { lastSeen: serverTimestamp() });
        
        const myPresenceRef = ref(db, `presence/${user.uid}`);
        onDisconnect(myPresenceRef).remove(); set(myPresenceRef, true);
        
        document.getElementById('open-login-btn').classList.add('hidden');
        document.getElementById('user-info').classList.remove('hidden');
        
        if(!window.globalUsersCache[user.uid]?.isBanned) document.getElementById('create-post-box').classList.remove('hidden');
        
        if (window.globalUsersCache[user.uid]?.pic || user.photoURL) {
            document.getElementById('nav-avatar').src = window.globalUsersCache[user.uid]?.pic || user.photoURL;
        }

        window.updateNotifBadge();

    } else {
        document.getElementById('open-login-btn').classList.remove('hidden');
        document.getElementById('user-info').classList.add('hidden');
        document.getElementById('create-post-box').classList.add('hidden');
    }
    if(!window.activeProfileUid) window.renderFeed(false);
});