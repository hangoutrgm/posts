// globals.js

// State Variables attached to window to preserve inline HTML function functionality
window.currentUser = null;
window.currentFilter = "All";
window.currentMemberFilter = "All";
window.allPosts = [];
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