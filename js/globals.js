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
window.isolatedPostData = null;

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

// Leaderboard periods (v1.4)
window.lbScope = 'weekly'; // 'overall' | 'weekly' | 'monthly' (weekly is default)
window.lbPeriodKey = '';    // selected period key for weekly/monthly (history)

// ==========================================
// V6.1 NEW STATES
// ==========================================
window.postVisibility = 'public'; // Can be 'public' or 'private'
window.currentMentionMatch = null;

// Typing protection (v6.3)
window.isUserTyping = false;
window.typingTimer = null;

// Dynamic Settings (loaded from Firebase /settings)
// pausePosts / pauseChat: Site Control switches in /config — when true, non-admin
// users cannot post/comment/react (posts) or send messages (chat). Admins bypass.
window.siteSettings = {
    pausePosts: false,
    pauseChat: false,
    starsPerPost: 10,
    starsPerComment: 1,
    starsPerReply: 1,
    starsPerLike: 1,
    starsPerPoked: 5,
    pokeLimit: 3,
    gameHostLbReward: 0,
    maxLbPointsPrize: 100,
    imageUploadLimit: 10,
    videoUploadLimit: 3,
    videoSizeLimitMB: 20,
    chatImageLimit: 10,
    chatVideoLimit: 3,
    chatVoiceLimit: 10,
    chatVideoSizeLimitMB: 20,
    postCooldownSec: 60,
    commentCooldownSec: 60,
    gameLimits: {}
};