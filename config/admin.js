// admin.js
import { app, auth, db, fsdb, fsdb2 } from "../js/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, onValue, set, update, push, get, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import "../js/globals.js";
import "../js/helpers.js";

const loadingScreen = document.getElementById('loading-screen');
const adminContent = document.getElementById('admin-content');
let globalUsers = {};
let allPostsCount = 0;

const ADMIN_UID = 'IrcAY3gUELNjiRUhMkr7muxNIpm2';

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '../';
        return;
    }

    try {
        // Check if admin by UID or isAdmin flag
        const isHardcodedAdmin = user.uid === ADMIN_UID;
        let isDbAdmin = false;

        if (!isHardcodedAdmin) {
            const userRef = ref(db, `users/${user.uid}`);
            const snap = await get(userRef);
            isDbAdmin = snap.exists() && snap.val().isAdmin === true;
        }

        if (!isHardcodedAdmin && !isDbAdmin) {
            window.location.href = '../';
            return;
        }

        // Is Admin
        loadingScreen.classList.add('hidden');
        adminContent.classList.remove('hidden');
        initAdminDashboard();

    } catch (err) {
        console.error('Admin check failed:', err);
        loadingScreen.innerHTML = `<p class="text-red-400">Error verifying access: ${err.message}</p><a href="../" class="text-blue-400 underline mt-2 block">Go back</a>`;
    }
});

function initAdminDashboard() {
    // Theme toggle
    const themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            if (document.documentElement.classList.contains('dark')) {
                document.documentElement.classList.remove('dark');
                localStorage.theme = 'light';
            } else {
                document.documentElement.classList.add('dark');
                localStorage.theme = 'dark';
            }
        });
    }

    // 0. Listen for Activity Log
    let cachedActivities = [];

    function renderActivityList() {
        const listEl = document.getElementById('admin-activity-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        if (cachedActivities.length > 0) {
            cachedActivities.forEach(act => {
                let displayUser = act.user || 'Unknown User';
                let displayAction = act.action || '';

                // Try resolving Unknown User or raw UID in act.user / act.userId
                if (globalUsers) {
                    if (act.userId && globalUsers[act.userId]?.name) {
                        displayUser = globalUsers[act.userId].name;
                    } else if (globalUsers[displayUser]?.name) {
                        displayUser = globalUsers[displayUser].name;
                    }
                }

                // Try resolving raw UIDs inside displayAction
                if (globalUsers && displayAction) {
                    Object.entries(globalUsers).forEach(([uid, uData]) => {
                        if (uid && uData.name && displayAction.includes(uid)) {
                            displayAction = displayAction.replaceAll(uid, uData.name);
                        }
                    });
                }

                const div = document.createElement('div');
                div.className = "flex flex-col bg-slate-50 dark:bg-slate-900/50 p-2.5 rounded-lg border border-slate-200 dark:border-slate-700/50";
                const time = new Date(act.timestamp).toLocaleString();
                div.innerHTML = `
                    <div class="text-[11px] text-slate-700 dark:text-slate-300">
                        <span class="font-bold text-indigo-600 dark:text-indigo-400">${displayUser}</span> ${displayAction}
                    </div>
                    <span class="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-0.5 flex items-center">
                        <i class="fa-regular fa-clock mr-1"></i> ${time}
                    </span>
                `;
                listEl.appendChild(div);
            });
        } else {
            listEl.innerHTML = '<p class="text-sm text-gray-500">No recent activity.</p>';
        }
    }

    const activityQuery = query(ref(db, 'activity_log'), limitToLast(50));
    onValue(activityQuery, (snap) => {
        cachedActivities = [];
        if (snap.exists()) {
            snap.forEach(child => { cachedActivities.push(child.val()); });
            cachedActivities.reverse();
        }
        renderActivityList();
    });

    // 1. Listen for Online Users
    onValue(ref(db, 'presence'), (snap) => {
        document.getElementById('metric-online').innerText = snap.size || 0;
    });

    // 2. Listen for Users
    onValue(ref(db, 'users'), (snap) => {
        if (snap.exists()) {
            globalUsers = snap.val();
            document.getElementById('metric-users').innerText = Object.keys(globalUsers).length;
            renderUsersList();
            renderActivityList();
        }
    });

    // 3. Get Posts count from Firestore
    async function fetchPostsCount() {
        try {
            const [snap1, snap2] = await Promise.allSettled([
                getCountFromServer(collection(fsdb, 'community_posts')),
                getCountFromServer(collection(fsdb2, 'community_posts'))
            ]);
            const count1 = snap1.status === 'fulfilled' ? (snap1.value.data().count || 0) : 0;
            const count2 = snap2.status === 'fulfilled' ? (snap2.value.data().count || 0) : 0;
            allPostsCount = count1 + count2;
            document.getElementById('metric-posts').innerText = allPostsCount;
        } catch (e) {
            console.error("Error fetching post count", e);
        }
    }
    fetchPostsCount();

    // 4. Listen to Settings
    onValue(ref(db, 'settings'), (snap) => {
        if (snap.exists()) {
            const settings = snap.val();
            document.getElementById('set-starsPerPost').value = settings.starsPerPost ?? '';
            document.getElementById('set-postCooldownSec').value = settings.postCooldownSec ?? window.siteSettings.postCooldownSec ?? '';
            document.getElementById('set-commentCooldownSec').value = settings.commentCooldownSec ?? window.siteSettings.commentCooldownSec ?? '';
            document.getElementById('set-chatCooldownSec').value = settings.chatCooldownSec ?? window.siteSettings.chatCooldownSec ?? '';
            document.getElementById('set-starsPerComment').value = settings.starsPerComment ?? '';
            document.getElementById('set-starsPerPoked').value = settings.starsPerPoked ?? '';
            document.getElementById('set-pokeLimit').value = settings.pokeLimit ?? window.siteSettings.pokeLimit ?? '';
            document.getElementById('set-starsPerFollow').value = settings.starsPerFollow ?? '';
            document.getElementById('set-maxStarsPrize').value = settings.maxStarsPrize ?? '';
            document.getElementById('set-maxLbPointsPrize').value = settings.maxLbPointsPrize ?? '';
            document.getElementById('set-gameHostLbReward').value = settings.gameHostLbReward ?? '';
            document.getElementById('set-imageUploadLimit').value = settings.imageUploadLimit ?? '';
            document.getElementById('set-videoUploadLimit').value = settings.videoUploadLimit ?? '';
            document.getElementById('set-videoSizeLimitMB').value = settings.videoSizeLimitMB ?? '';
            document.getElementById('set-chatImageLimit').value = settings.chatImageLimit ?? '';
            document.getElementById('set-chatVideoLimit').value = settings.chatVideoLimit ?? '';
            document.getElementById('set-chatVoiceLimit').value = settings.chatVoiceLimit ?? '';
            document.getElementById('set-chatVideoSizeLimitMB').value = settings.chatVideoSizeLimitMB ?? '';
            renderGameLimitInputs(settings.gameLimits || {});
            renderSiteControl(settings.pausePosts === true, settings.pauseChat === true);
        } else {
            document.getElementById('set-starsPerPost').value = '';
            document.getElementById('set-postCooldownSec').value = '';
            document.getElementById('set-commentCooldownSec').value = '';
            document.getElementById('set-chatCooldownSec').value = '';
            document.getElementById('set-starsPerComment').value = '';
            document.getElementById('set-starsPerPoked').value = '';
            document.getElementById('set-pokeLimit').value = '';
            document.getElementById('set-starsPerFollow').value = '';
            document.getElementById('set-maxStarsPrize').value = '';
            document.getElementById('set-maxLbPointsPrize').value = '';
            document.getElementById('set-gameHostLbReward').value = '';
            document.getElementById('set-imageUploadLimit').value = '';
            document.getElementById('set-videoUploadLimit').value = '';
            document.getElementById('set-videoSizeLimitMB').value = '';
            document.getElementById('set-chatImageLimit').value = '';
            document.getElementById('set-chatVideoLimit').value = '';
            document.getElementById('set-chatVoiceLimit').value = '';
            document.getElementById('set-chatVideoSizeLimitMB').value = '';
            renderGameLimitInputs({});
            renderSiteControl(false, false);
        }

        // Set placeholders
        document.getElementById('set-starsPerPost').placeholder = window.siteSettings.starsPerPost;
        document.getElementById('set-postCooldownSec').placeholder = window.siteSettings.postCooldownSec ?? 60;
        document.getElementById('set-commentCooldownSec').placeholder = window.siteSettings.commentCooldownSec ?? 60;
        document.getElementById('set-chatCooldownSec').placeholder = window.siteSettings.chatCooldownSec ?? 60;
        document.getElementById('set-starsPerComment').placeholder = window.siteSettings.starsPerComment;
        document.getElementById('set-starsPerPoked').placeholder = window.siteSettings.starsPerPoked;
        document.getElementById('set-pokeLimit').placeholder = window.siteSettings.pokeLimit ?? 3;
        document.getElementById('set-starsPerFollow').placeholder = window.siteSettings.starsPerFollow ?? '5';
        document.getElementById('set-maxStarsPrize').placeholder = window.siteSettings.maxStarsPrize || '100';
        document.getElementById('set-maxLbPointsPrize').placeholder = window.siteSettings.maxLbPointsPrize;
        document.getElementById('set-gameHostLbReward').placeholder = window.siteSettings.gameHostLbReward || '0';
        document.getElementById('set-imageUploadLimit').placeholder = window.siteSettings.imageUploadLimit;
        document.getElementById('set-videoUploadLimit').placeholder = window.siteSettings.videoUploadLimit;
        document.getElementById('set-videoSizeLimitMB').placeholder = window.siteSettings.videoSizeLimitMB;
    });

    // 5. Handle Form Submit
    document.getElementById('settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newSettings = {
            // Preserve Site Control switches — they are managed by their own buttons
            pausePosts: currentPauseState.pausePosts === true,
            pauseChat: currentPauseState.pauseChat === true,
            starsPerPost: parseInt(document.getElementById('set-starsPerPost').value) || 0,
            postCooldownSec: parseInt(document.getElementById('set-postCooldownSec').value) || 0,
            commentCooldownSec: parseInt(document.getElementById('set-commentCooldownSec').value) || 0,
            chatCooldownSec: parseInt(document.getElementById('set-chatCooldownSec').value) || 0,
            starsPerComment: parseInt(document.getElementById('set-starsPerComment').value) || 0,
            starsPerPoked: parseInt(document.getElementById('set-starsPerPoked').value) || 0,
            pokeLimit: parseInt(document.getElementById('set-pokeLimit').value) || 0,
            starsPerFollow: parseInt(document.getElementById('set-starsPerFollow').value) || 0,
            maxStarsPrize: parseInt(document.getElementById('set-maxStarsPrize').value) || 0,
            maxLbPointsPrize: parseInt(document.getElementById('set-maxLbPointsPrize').value) || 0,
            gameHostLbReward: parseInt(document.getElementById('set-gameHostLbReward').value) || 0,
            imageUploadLimit: parseInt(document.getElementById('set-imageUploadLimit').value) || 0,
            videoUploadLimit: parseInt(document.getElementById('set-videoUploadLimit').value) || 0,
            videoSizeLimitMB: parseInt(document.getElementById('set-videoSizeLimitMB').value) || 0,
            chatImageLimit: parseInt(document.getElementById('set-chatImageLimit').value) || 10,
            chatVideoLimit: parseInt(document.getElementById('set-chatVideoLimit').value) || 3,
            chatVoiceLimit: parseInt(document.getElementById('set-chatVoiceLimit').value) || 10,
            chatVideoSizeLimitMB: parseInt(document.getElementById('set-chatVideoSizeLimitMB').value) || 20,
            gameLimits: collectGameLimits(),
        };

        try {
            await set(ref(db, 'settings'), newSettings);
            alert("Settings saved successfully!");
        } catch (error) {
            console.error(error);
            alert("Error saving settings: " + error.message);
        }
    });

    // 5b. Site Control — Pause Posts / Pause Chat switches.
    // When paused, non-admin users cannot post/comment/react or send chat messages. Admins bypass both.
    function renderSiteControl(postsPaused, chatPaused) {
        const ppIcon = document.getElementById('pause-posts-icon');
        const pcIcon = document.getElementById('pause-chat-icon');
        const ppLabel = document.getElementById('pause-posts-label');
        const pcLabel = document.getElementById('pause-chat-label');
        if (!ppIcon || !pcIcon) return;
        ppIcon.className = postsPaused ? 'fa-solid fa-pause-circle text-red-500 text-lg' : 'fa-solid fa-play-circle text-emerald-500 text-lg';
        pcIcon.className = chatPaused ? 'fa-solid fa-pause-circle text-red-500 text-lg' : 'fa-solid fa-play-circle text-emerald-500 text-lg';
        if (ppLabel) {
            ppLabel.textContent = postsPaused ? 'PAUSED — only you can post/comment/react' : 'Active — everyone can post';
            ppLabel.classList.toggle('text-red-500', postsPaused);
        }
        if (pcLabel) {
            pcLabel.textContent = chatPaused ? 'PAUSED — only you can send messages' : 'Active — everyone can chat';
            pcLabel.classList.toggle('text-red-500', chatPaused);
        }
        const ppBtn = document.getElementById('toggle-pause-posts');
        const pcBtn = document.getElementById('toggle-pause-chat');
        if (ppBtn) { ppBtn.disabled = false; ppBtn.classList.remove('opacity-50'); }
        if (pcBtn) { pcBtn.disabled = false; pcBtn.classList.remove('opacity-50'); }
    }

    async function togglePauseFlag(flag, currentlyPaused) {
        try {
            await update(ref(db, 'settings'), { [flag]: !currentlyPaused });
        } catch (error) {
            console.error(`Error toggling ${flag}:`, error);
            alert("Error updating pause state: " + error.message);
        }
    }

    const pausePostsBtn = document.getElementById('toggle-pause-posts');
    const pauseChatBtn = document.getElementById('toggle-pause-chat');
    let currentPauseState = { pausePosts: false, pauseChat: false };
    if (pausePostsBtn) {
        pausePostsBtn.addEventListener('click', () => {
            const msg = currentPauseState.pausePosts
                ? "Resume posting for all users?"
                : "Pause ALL posting, commenting and reactions for users? You will still be able to do everything.";
            confirm(msg) && togglePauseFlag('pausePosts', currentPauseState.pausePosts);
        });
    }
    if (pauseChatBtn) {
        pauseChatBtn.addEventListener('click', () => {
            const msg = currentPauseState.pauseChat
                ? "Resume chat for all users?"
                : "Pause ALL chat messages for users? You will still be able to send messages.";
            confirm(msg) && togglePauseFlag('pauseChat', currentPauseState.pauseChat);
        });
    }
    // Keep latest known state for the confirm dialogs
    onValue(ref(db, 'settings/pausePosts'), (snap) => { currentPauseState.pausePosts = snap.val() === true; });
    onValue(ref(db, 'settings/pauseChat'), (snap) => { currentPauseState.pauseChat = snap.val() === true; });

    // 5c. Game Posting Limits — inputs & save
    function renderGameLimitInputs(values = {}) {
        const grid = document.getElementById('game-limits-grid');
        if (!grid) return;
        grid.innerHTML = '';
        (window.gameTypesList || []).forEach(g => {
            const cell = document.createElement('div');
            cell.className = "flex items-center gap-2 min-w-0";
            const val = values[g.type];
            cell.innerHTML = `
                <label for="gl-${g.type}" class="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 flex-1 truncate" title="${g.label}">${g.label}</label>
                <input type="number" id="gl-${g.type}" min="0" step="1" placeholder="∞" class="w-16 shrink-0 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2 py-1.5 text-xs outline-none transition text-center">
            `;
            const input = cell.querySelector('input');
            input.value = (val !== undefined && val !== null) ? Number(val) : '';
            grid.appendChild(cell);
        });
    }

    function collectGameLimits() {
        const limits = {};
        (window.gameTypesList || []).forEach(g => {
            const input = document.getElementById(`gl-${g.type}`);
            if (!input) return;
            const val = parseInt(input.value, 10);
            if (!isNaN(val) && val > 0) limits[g.type] = val;
        });
        return limits;
    }

    // Render the limit grid immediately (settings listener refreshes it)
    renderGameLimitInputs({});

    document.getElementById('game-limits-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Saving...';
        try {
            await set(ref(db, 'settings/gameLimits'), collectGameLimits());
            alert("Game posting limits saved successfully!");
        } catch (error) {
            console.error(error);
            alert("Error saving game limits: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    });

    // 6. Handle Search
    document.getElementById('admin-user-search').addEventListener('input', renderUsersList);

    // 7. Danger Zone: Reset Leaderboard Points
    const confirmLbInput = document.getElementById('confirm-reset-lb');
    const btnResetLb = document.getElementById('btn-reset-lb');
    
    confirmLbInput.addEventListener('input', (e) => {
        if (e.target.value === 'wipe out leaderboard points') {
            btnResetLb.removeAttribute('disabled');
        } else {
            btnResetLb.setAttribute('disabled', 'true');
        }
    });

    btnResetLb.addEventListener('click', async () => {
        if (confirm("Are you absolutely sure you want to reset all Leaderboard points to 0? This cannot be undone.")) {
            btnResetLb.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Resetting...';
            btnResetLb.setAttribute('disabled', 'true');
            
            try {
                const updates = {};
                for (const uid in globalUsers) {
                    updates[`users/${uid}/lbPoints`] = null;
                }
                
                await update(ref(db), updates);
                
                // Log activity
                await push(ref(db, 'activity_log'), {
                    user: 'Admin',
                    action: 'wiped out all leaderboard points',
                    timestamp: Date.now()
                });
                
                alert('Leaderboard points successfully reset to 0 for all users.');
                confirmLbInput.value = '';
                btnResetLb.innerHTML = '<i class="fa-solid fa-trash-can mr-2"></i> Reset Leaderboard Points';
            } catch (err) {
                console.error(err);
                alert('Error resetting leaderboard points: ' + err.message);
                btnResetLb.innerHTML = '<i class="fa-solid fa-trash-can mr-2"></i> Reset Leaderboard Points';
                btnResetLb.removeAttribute('disabled');
            }
        }
    });

    // 8. Danger Zone: Reset Earnings & Wins
    const confirmEarningsInput = document.getElementById('confirm-reset-earnings');
    const btnResetEarnings = document.getElementById('btn-reset-earnings');
    
    confirmEarningsInput.addEventListener('input', (e) => {
        if (e.target.value === 'reset prizes, reset wins') {
            btnResetEarnings.removeAttribute('disabled');
        } else {
            btnResetEarnings.setAttribute('disabled', 'true');
        }
    });

    btnResetEarnings.addEventListener('click', async () => {
        if (confirm("Are you absolutely sure you want to delete all earnings, prizes, and wins data? This cannot be undone.")) {
            btnResetEarnings.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Resetting...';
            btnResetEarnings.setAttribute('disabled', 'true');
            
            try {
                const updates = {};
                for (const uid in globalUsers) {
                    updates[`earnings/${uid}`] = null;
                    updates[`hostedGames/${uid}`] = null;
                    updates[`users/${uid}/earnings`] = null;
                    updates[`users/${uid}/wins`] = null;
                    updates[`users/${uid}/hostedGames`] = null;
                }
                
                await update(ref(db), updates);
                
                // Log activity
                await push(ref(db, 'activity_log'), {
                    user: 'Admin',
                    action: 'reset all earnings, prizes, and wins',
                    timestamp: Date.now()
                });
                
                alert('Earnings, prizes, and wins successfully deleted for all users.');
                confirmEarningsInput.value = '';
                btnResetEarnings.innerHTML = '<i class="fa-solid fa-trash-can mr-2"></i> Reset Earnings & Wins';
            } catch (err) {
                console.error(err);
                alert('Error resetting earnings: ' + err.message);
                btnResetEarnings.innerHTML = '<i class="fa-solid fa-trash-can mr-2"></i> Reset Earnings & Wins';
                btnResetEarnings.removeAttribute('disabled');
            }
        }
    });
}

function renderUsersList() {
    const listEl = document.getElementById('admin-users-list');
    const query = document.getElementById('admin-user-search').value.toLowerCase();
    
    listEl.innerHTML = '';
    
    let usersArray = Object.entries(globalUsers).map(([uid, data]) => ({ uid, ...data }));
    
    if (query) {
        usersArray = usersArray.filter(u => u.name && u.name.toLowerCase().includes(query));
    }

    usersArray.sort((a, b) => (b.points || 0) - (a.points || 0));

    usersArray.forEach(u => {
        // use window.getRole for badge
        // temporarily put it in globalUsersCache so getRole works if it needs it
        window.globalUsersCache[u.uid] = u;
        const role = window.getRole(u.uid);

        const div = document.createElement('div');
        div.className = "flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700/50 hover:bg-white dark:hover:bg-slate-800 transition-colors group";
        div.innerHTML = `
            <div class="flex items-center space-x-2.5 truncate">
                <div class="relative">
                    <img src="${u.pic || window.generateAvatar(u.uid)}" class="w-8 h-8 rounded-full object-cover border border-slate-200 dark:border-slate-700 shadow-sm">
                    ${role.badgeHtml ? `<div class="absolute -bottom-1 -right-1 bg-white dark:bg-slate-800 rounded-full p-0.5 shadow-sm scale-[0.6]">${role.badgeHtml}</div>` : ''}
                </div>
                <div class="truncate">
                    <p class="font-bold text-[11px] text-slate-800 dark:text-slate-100 truncate">${u.name || 'Unknown'}</p>
                    <div class="flex items-center space-x-1.5 mt-0.5">
                        <span class="text-[10px] font-semibold text-amber-500 bg-amber-50 dark:bg-amber-500/10 px-1 py-0.5 rounded flex items-center"><i class="fa-solid fa-star mr-1 text-[8px]"></i> ${u.points || 0}</span>
                        <span class="text-[10px] font-semibold text-blue-500 bg-blue-50 dark:bg-blue-500/10 px-1 py-0.5 rounded flex items-center"><i class="fa-solid fa-trophy mr-1 text-[8px]"></i> ${u.lbPoints || 0}</span>
                    </div>
                </div>
            </div>
            <div class="flex items-center">
                <div class="text-[9px] font-mono text-slate-400 dark:text-slate-500 bg-slate-200/50 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                    ${u.uid.substring(0, 8)}...
                </div>
                <button onclick="navigator.clipboard.writeText('${u.uid}'); alert('Copied UID: ${u.uid}');" class="ml-1 w-5 h-5 rounded text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 flex items-center justify-center transition opacity-0 group-hover:opacity-100" title="Copy UID">
                    <i class="fa-solid fa-copy text-[10px]"></i>
                </button>
            </div>
        `;
        listEl.appendChild(div);
    });
}
