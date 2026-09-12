// admin.js
import { app, auth, db, fsdb, fsdb2 } from "../js/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, onValue, set, update, push, get, query, limitToLast, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, getCountFromServer, doc, query as fsQuery, orderBy, limit, getDocs, getDoc, deleteDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import "../js/globals.js?v=2";
import "../js/helpers.js";

const loadingScreen = document.getElementById('loading-screen');
const adminContent = document.getElementById('admin-content');
let globalUsers = {};
let allPostsCount = 0;
let globalIps = {}; // uid -> { ip, at } (anti-abuse)

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
                const time = new Date(act.timestamp).toLocaleString([], { hour12: true });
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
            populateMigrateDatalist();
        }
        renderMultiAccounts();
    });

    // Anti-abuse: watch /user_ips so the users list can flag accounts sharing an IP.
    onValue(ref(db, 'user_ips'), (snap) => {
        globalIps = snap.exists() ? snap.val() : {};
        renderUsersList();
        renderMultiAccounts();
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
            document.getElementById('set-chatGameCooldownSec').value = settings.chatGameCooldownSec ?? window.siteSettings.chatGameCooldownSec ?? '';
            document.getElementById('set-chatGameRaceTo').value = settings.chatGameRaceTo ?? settings.chatGameRounds ?? window.siteSettings.chatGameRaceTo ?? window.siteSettings.chatGameRounds ?? '';
            document.getElementById('set-boardGameMoveTimerSec').value = settings.boardGameMoveTimerSec ?? '';
            document.getElementById('set-presenceSweepSec').value = settings.presenceSweepSec ?? '';
            document.getElementById('set-minGamePlayers').value = settings.minGamePlayers ?? '';
            document.getElementById('set-starsPerComment').value = settings.starsPerComment ?? '';
            document.getElementById('set-starsPerLike').value = settings.starsPerLike ?? '';
            document.getElementById('set-starsPerPoked').value = settings.starsPerPoked ?? '';
            document.getElementById('set-pokeLimit').value = settings.pokeLimit ?? window.siteSettings.pokeLimit ?? '';
            document.getElementById('set-starsPerFollow').value = settings.starsPerFollow ?? '';
            document.getElementById('set-maxStarsPrize').value = settings.maxStarsPrize ?? '';
            document.getElementById('set-maxLbPointsPrize').value = settings.maxLbPointsPrize ?? '';
            document.getElementById('set-gameHostLbReward').value = settings.gameHostLbReward ?? '';
            document.getElementById('set-chatGameLbReward').value = settings.chatGameLbReward ?? window.siteSettings.chatGameLbReward ?? '';
            document.getElementById('set-chatGameHostLbReward').value = settings.chatGameHostLbReward ?? window.siteSettings.chatGameHostLbReward ?? '';
            document.getElementById('set-lbBoostMultiplier').value = settings.lbBoostMultiplier ?? '';
            document.getElementById('set-lbBoostStart').value = settings.lbBoostStart ?? '';
            document.getElementById('set-lbBoostEnd').value = settings.lbBoostEnd ?? '';
            document.getElementById('set-imageUploadLimit').value = settings.imageUploadLimit ?? '';
            document.getElementById('set-videoUploadLimit').value = settings.videoUploadLimit ?? '';
            document.getElementById('set-videoSizeLimitMB').value = settings.videoSizeLimitMB ?? '';
            document.getElementById('set-chatImageLimit').value = settings.chatImageLimit ?? '';
            document.getElementById('set-chatVideoLimit').value = settings.chatVideoLimit ?? '';
            document.getElementById('set-chatVoiceLimit').value = settings.chatVoiceLimit ?? '';
            document.getElementById('set-chatVideoSizeLimitMB').value = settings.chatVideoSizeLimitMB ?? '';
            renderGameLimitInputs(settings.gameLimits || {}, settings.gameLbRewards || {});
            renderSiteControl(settings.pausePosts === true, settings.pauseChat === true);
        } else {
            document.getElementById('set-starsPerPost').value = '';
            document.getElementById('set-postCooldownSec').value = '';
            document.getElementById('set-commentCooldownSec').value = '';
            document.getElementById('set-chatCooldownSec').value = '';
            document.getElementById('set-chatGameCooldownSec').value = '';
            document.getElementById('set-chatGameRaceTo').value = '';
            document.getElementById('set-boardGameMoveTimerSec').value = '';
            document.getElementById('set-presenceSweepSec').value = '';
            document.getElementById('set-minGamePlayers').value = '';
            document.getElementById('set-starsPerComment').value = '';
            document.getElementById('set-starsPerLike').value = '';
            document.getElementById('set-starsPerPoked').value = '';
            document.getElementById('set-pokeLimit').value = '';
            document.getElementById('set-starsPerFollow').value = '';
            document.getElementById('set-maxStarsPrize').value = '';
            document.getElementById('set-maxLbPointsPrize').value = '';
            document.getElementById('set-gameHostLbReward').value = '';
            document.getElementById('set-chatGameLbReward').value = '';
            document.getElementById('set-chatGameHostLbReward').value = '';
            document.getElementById('set-lbBoostMultiplier').value = '';
            document.getElementById('set-lbBoostStart').value = '';
            document.getElementById('set-lbBoostEnd').value = '';
            document.getElementById('set-imageUploadLimit').value = '';
            document.getElementById('set-videoUploadLimit').value = '';
            document.getElementById('set-videoSizeLimitMB').value = '';
            document.getElementById('set-chatImageLimit').value = '';
            document.getElementById('set-chatVideoLimit').value = '';
            document.getElementById('set-chatVoiceLimit').value = '';
            document.getElementById('set-chatVideoSizeLimitMB').value = '';
            renderGameLimitInputs({}, {});
            renderSiteControl(false, false);
        }

        // Set placeholders
        document.getElementById('set-starsPerPost').placeholder = window.siteSettings.starsPerPost;
        document.getElementById('set-postCooldownSec').placeholder = window.siteSettings.postCooldownSec ?? 60;
        document.getElementById('set-commentCooldownSec').placeholder = window.siteSettings.commentCooldownSec ?? 60;
        document.getElementById('set-chatCooldownSec').placeholder = window.siteSettings.chatCooldownSec ?? 60;
        document.getElementById('set-chatGameCooldownSec').placeholder = window.siteSettings.chatGameCooldownSec ?? 60;
        document.getElementById('set-chatGameRaceTo').placeholder = window.siteSettings.chatGameRaceTo ?? window.siteSettings.chatGameRounds ?? 5;
        document.getElementById('set-boardGameMoveTimerSec').placeholder = window.siteSettings.boardGameMoveTimerSec ?? 60;
        document.getElementById('set-presenceSweepSec').placeholder = window.siteSettings.presenceSweepSec ?? 0;
        document.getElementById('set-minGamePlayers').placeholder = window.siteSettings.minGamePlayers ?? 5;
        document.getElementById('set-starsPerComment').placeholder = window.siteSettings.starsPerComment;
        document.getElementById('set-starsPerLike').placeholder = window.siteSettings.starsPerLike ?? 1;
        document.getElementById('set-starsPerPoked').placeholder = window.siteSettings.starsPerPoked;
        document.getElementById('set-pokeLimit').placeholder = window.siteSettings.pokeLimit ?? 3;
        document.getElementById('set-starsPerFollow').placeholder = window.siteSettings.starsPerFollow ?? '5';
        document.getElementById('set-maxStarsPrize').placeholder = window.siteSettings.maxStarsPrize || '100';
        document.getElementById('set-maxLbPointsPrize').placeholder = window.siteSettings.maxLbPointsPrize;
        document.getElementById('set-gameHostLbReward').placeholder = window.siteSettings.gameHostLbReward || '0';
        document.getElementById('set-chatGameLbReward').placeholder = window.siteSettings.chatGameLbReward ?? '5';
        document.getElementById('set-chatGameHostLbReward').placeholder = window.siteSettings.chatGameHostLbReward ?? '0';
        document.getElementById('set-lbBoostMultiplier').placeholder = window.siteSettings.lbBoostMultiplier ?? '1';
        document.getElementById('set-lbBoostStart').placeholder = window.siteSettings.lbBoostStart ?? '22:00';
        document.getElementById('set-lbBoostEnd').placeholder = window.siteSettings.lbBoostEnd ?? '00:00';
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
            chatGameCooldownSec: parseInt(document.getElementById('set-chatGameCooldownSec').value) || 0,
            chatGameRaceTo: parseInt(document.getElementById('set-chatGameRaceTo').value) || 5,
            boardGameMoveTimerSec: parseInt(document.getElementById('set-boardGameMoveTimerSec').value) || 60,
            presenceSweepSec: parseInt(document.getElementById('set-presenceSweepSec').value) || 0,
            minGamePlayers: parseInt(document.getElementById('set-minGamePlayers').value) || 5,
            starsPerComment: parseInt(document.getElementById('set-starsPerComment').value) || 0,
            starsPerLike: parseInt(document.getElementById('set-starsPerLike').value) || 0,
            starsPerPoked: parseInt(document.getElementById('set-starsPerPoked').value) || 0,
            pokeLimit: parseInt(document.getElementById('set-pokeLimit').value) || 0,
            starsPerFollow: parseInt(document.getElementById('set-starsPerFollow').value) || 0,
            maxStarsPrize: parseInt(document.getElementById('set-maxStarsPrize').value) || 0,
            maxLbPointsPrize: parseInt(document.getElementById('set-maxLbPointsPrize').value) || 0,
            gameHostLbReward: parseInt(document.getElementById('set-gameHostLbReward').value) || 0,
            chatGameLbReward: parseInt(document.getElementById('set-chatGameLbReward').value) || 0,
            chatGameHostLbReward: parseInt(document.getElementById('set-chatGameHostLbReward').value) || 0,
            lbBoostMultiplier: parseFloat(document.getElementById('set-lbBoostMultiplier').value) || 1,
            lbBoostStart: document.getElementById('set-lbBoostStart').value || '22:00',
            lbBoostEnd: document.getElementById('set-lbBoostEnd').value || '00:00',
            imageUploadLimit: parseInt(document.getElementById('set-imageUploadLimit').value) || 0,
            videoUploadLimit: parseInt(document.getElementById('set-videoUploadLimit').value) || 0,
            videoSizeLimitMB: parseInt(document.getElementById('set-videoSizeLimitMB').value) || 0,
            chatImageLimit: parseInt(document.getElementById('set-chatImageLimit').value) || 10,
            chatVideoLimit: parseInt(document.getElementById('set-chatVideoLimit').value) || 3,
            chatVoiceLimit: parseInt(document.getElementById('set-chatVoiceLimit').value) || 10,
            chatVideoSizeLimitMB: parseInt(document.getElementById('set-chatVideoSizeLimitMB').value) || 20,
            hideHostGameAnswers: currentHostAnswersState === true,
            zeroLbForFlaggedPair: currentZeroLbState === true,
            gameLbRewards: collectGameLbRewards(),
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

    // 5d. Site Control — Hide Host Game Answers switch.
    // When ON, hosts can no longer see the answer while their game is live
    // (Hangman word, Gibberish / Emoji Riddle / Flags / Jumbled / Periodic answer, Count-the-Dots, etc).
    let currentHostAnswersState = false;
    function renderHostAnswersControl() {
        const btn = document.getElementById('toggle-hide-host-answers');
        const label = document.getElementById('hide-host-answers-label');
        const icon = document.getElementById('hide-host-answers-icon');
        if (!btn || !label || !icon) return;
        if (currentHostAnswersState) {
            label.textContent = "ON — hosts can\u2019t see answers while a game is live";
            label.classList.remove('text-slate-400');
            label.classList.add('text-amber-500');
            icon.className = 'fa-solid fa-eye-slash text-amber-500';
            btn.classList.add('border-amber-400', 'bg-amber-50', 'dark:bg-amber-500/10');
        } else {
            label.textContent = "OFF — hosts see answers while a game is live";
            label.classList.add('text-slate-400');
            label.classList.remove('text-amber-500');
            icon.className = 'fa-solid fa-eye text-slate-400';
            btn.classList.remove('border-amber-400', 'bg-amber-50', 'dark:bg-amber-500/10');
        }
    }
    async function toggleHostAnswersFlag(isCurrentlyHidden) {
        try {
            await update(ref(db, 'settings'), { hideHostGameAnswers: !isCurrentlyHidden });
        } catch (error) {
            console.error('Error toggling hideHostGameAnswers:', error);
            alert("Error updating setting: " + error.message);
        }
    }
    const hideHostBtn = document.getElementById('toggle-hide-host-answers');
    if (hideHostBtn) {
        hideHostBtn.addEventListener('click', () => {
            const msg = currentHostAnswersState
                ? "Allow hosts to see game answers again while a game is live?"
                : "Hide game answers from HOSTS while a game is live? (Guessing players are never affected — they can't see the answer either way.)";
            if (confirm(msg)) toggleHostAnswersFlag(currentHostAnswersState);
        });
    }
    onValue(ref(db, 'settings/hideHostGameAnswers'), (snap) => {
        currentHostAnswersState = snap.val() === true;
        renderHostAnswersControl();
    });

    // 5f. Site Control — Zero LB for Same-IP (flagged) host+winner pairs.
    // Soft anti-fixed-match shield: when a host & winner appear to be the same
    // person (same flagged IP group), neither receives LB for that game.
    let currentZeroLbState = false;
    function renderZeroLbControl() {
        const btn = document.getElementById('toggle-zero-lb');
        const label = document.getElementById('zero-lb-label');
        const icon = document.getElementById('zero-lb-icon');
        if (!btn || !label || !icon) return;
        if (currentZeroLbState) {
            label.textContent = "ON — same-IP host+winner games award 0 LB";
            label.classList.remove('text-slate-400');
            label.classList.add('text-amber-500');
            icon.className = 'fa-solid fa-shield-halved text-amber-500';
            btn.classList.add('border-amber-400', 'bg-amber-50', 'dark:bg-amber-500/10');
        } else {
            label.textContent = "OFF — LB rewards are awarded normally";
            label.classList.add('text-slate-400');
            label.classList.remove('text-amber-500');
            icon.className = 'fa-solid fa-shield text-slate-400';
            btn.classList.remove('border-amber-400', 'bg-amber-50', 'dark:bg-amber-500/10');
        }
    }
    async function toggleZeroLbFlag(isCurrentlyOn) {
        try {
            await update(ref(db, 'settings'), { zeroLbForFlaggedPair: !isCurrentlyOn });
        } catch (error) {
            console.error('Error toggling zeroLbForFlaggedPair:', error);
            alert("Error updating setting: " + error.message);
        }
    }
    const zeroLbBtn = document.getElementById('toggle-zero-lb');
    if (zeroLbBtn) {
        zeroLbBtn.addEventListener('click', () => {
            const msg = currentZeroLbState
                ? "Turn OFF the same-IP LB shield? LB rewards go back to normal for everyone."
                : "Turn ON the same-IP shield? When a game host and the winner appear (by IP) to be the same person, NEITHER receives LB points for that game. Soft, fair-play safeguard — nobody is blocked or banned.";
            if (confirm(msg)) toggleZeroLbFlag(currentZeroLbState);
        });
    }
    onValue(ref(db, 'settings/zeroLbForFlaggedPair'), (snap) => {
        currentZeroLbState = snap.val() === true;
        renderZeroLbControl();
    });

    // 5b. Maintenance — heal users with missing / "undefined" name or pic.
    // Only fills gaps; never overwrites valid values.
    const healBtn = document.getElementById('heal-names-btn');
    if (healBtn) {
        healBtn.addEventListener('click', async () => {
            const isBad = (v) => !v || v === 'undefined' || v === 'null';
            if (!confirm('Scan ALL users and fix missing/broken names & pics?\n\nValid profiles are never touched.')) return;
            const originalHtml = healBtn.innerHTML;
            healBtn.disabled = true;
            healBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i><span class="text-xs font-bold">Scanning…</span>';
            try {
                const snap = await get(ref(db, 'users'));
                const users = snap.val() || {};
                const updates = [];
                Object.entries(users).forEach(([uid, u]) => {
                    u = u || {};
                    const patch = {};
                    if (isBad(u.name)) {
                        let healedName;
                        if (u.isGuest) healedName = `Guest_${String(uid).slice(-4)}`;
                        else {
                            const em = typeof u.email === 'string' ? u.email.split('@')[0] : '';
                            healedName = /^[a-zA-Z0-9._-]{3,18}$/.test(em) && em.toLowerCase() !== 'undefined' ? em : `User_${String(uid).slice(-4)}`;
                        }
                        patch.name = healedName;
                    }
                    if (isBad(u.pic)) patch.pic = window.generateAvatar ? window.generateAvatar(uid) : `https://api.dicebear.com/7.x/bottts/svg?seed=${uid}&backgroundColor=transparent`;
                    if (Object.keys(patch).length) updates.push(update(ref(db, `users/${uid}`), patch));
                });
                await Promise.allSettled(updates);
                alert(`Cleanup complete!\n\nScanned: ${Object.keys(users).length} user(s)\nFixed: ${updates.length} profile(s)`);
            } catch (e) {
                console.error('Heal failed:', e);
                alert('Cleanup failed: ' + e.message);
            } finally {
                healBtn.disabled = false;
                healBtn.innerHTML = originalHtml;
            }
        });
    }

    // 5c. Game Posting Limits + per-game LB reward caps — inputs & save
    // Each game gets TWO inputs: "📦 Posts/Day" (daily post limit) and "🏆 Max LB" (max LB reward a
    // host may set for this game). Blank/0 on Max LB = fall back to the global LB max (settings.maxLbPointsPrize).
    function renderGameLimitInputs(values = {}, lbRewards = {}) {
        const grid = document.getElementById('game-limits-grid');
        if (!grid) return;
        grid.innerHTML = '';
        (window.gameTypesList || []).forEach(g => {
            const cell = document.createElement('div');
            cell.className = "flex flex-col gap-1.5 min-w-0 rounded-lg border border-slate-100 dark:border-slate-700/60 p-2 bg-slate-50/50 dark:bg-slate-900/40";
            const val = values[g.type];
            const lbVal = lbRewards[g.type];
            cell.innerHTML = `
                <label for="gl-${g.type}" class="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 truncate" title="${g.label}">${g.label}</label>
                <div class="flex items-center gap-1.5">
                    <span class="text-[9px] font-bold text-indigo-500 shrink-0" title="Max game posts per day">📦</span>
                    <input type="number" id="gl-${g.type}" min="0" step="1" placeholder="∞" class="w-full min-w-0 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2 py-1.5 text-xs outline-none transition text-center">
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="text-[9px] font-bold text-amber-500 shrink-0" title="Max LB reward a host can set for this game">🏆</span>
                    <input type="number" id="gllb-${g.type}" min="0" step="1" placeholder="auto" class="w-full min-w-0 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-amber-500 focus:ring-1 focus:ring-amber-500 rounded-lg px-2 py-1.5 text-xs outline-none transition text-center">
                </div>`;
            const limitInput = cell.querySelector(`#gl-${g.type}`);
            limitInput.value = (val !== undefined && val !== null) ? Number(val) : '';
            const lbInput = cell.querySelector(`#gllb-${g.type}`);
            lbInput.value = (lbVal !== undefined && lbVal !== null && Number(lbVal) > 0) ? Number(lbVal) : '';
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

    function collectGameLbRewards() {
        const rewards = {};
        (window.gameTypesList || []).forEach(g => {
            const input = document.getElementById(`gllb-${g.type}`);
            if (!input) return;
            const val = parseInt(input.value, 10);
            if (!isNaN(val) && val > 0) rewards[g.type] = val;
        });
        return rewards;
    }

    // Render the limit grid immediately (settings listener refreshes it)
    renderGameLimitInputs({}, {});

    document.getElementById('game-limits-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Saving...';
        try {
            await Promise.all([
                set(ref(db, 'settings/gameLimits'), collectGameLimits()),
                set(ref(db, 'settings/gameLbRewards'), collectGameLbRewards())
            ]);
            alert("Game limits saved successfully!");
        } catch (error) {
            console.error(error);
            alert("Error saving game limits: " + error.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    });

    // ★ Migrate User Points (Stars ★ & LB 🏆 from one account into another)
    // Only ADDITIVE — the receiving user's points are incremented, never replaced.
    const migrateFromInput = document.getElementById('migrate-from-user');
    const migrateToInput = document.getElementById('migrate-to-user');
    const migrateBtn = document.getElementById('btn-migrate-points');

    migrateFromInput.addEventListener('input', refreshMigratePreview);
    migrateToInput.addEventListener('input', refreshMigratePreview);

    migrateBtn.addEventListener('click', async () => {
        if (!migrateFromUser || !migrateToUser || migrateFromUser.ambiguous || migrateToUser.ambiguous || migrateFromUser.uid === migrateToUser.uid) return;
        const pts = Number(migrateFromUser.points) || 0;
        const lb = Number(migrateFromUser.lbPoints) || 0;
        if (pts <= 0 && lb <= 0) return;

        const toPts = (Number(migrateToUser.points) || 0) + pts;
        const toLb = (Number(migrateToUser.lbPoints) || 0) + lb;
        const weeks = Array.isArray(migratePeriodData.weeks) ? migratePeriodData.weeks : [];
        const months = Array.isArray(migratePeriodData.months) ? migratePeriodData.months : [];
        const wkTotal = weeks.reduce((s, x) => s + x.pts, 0);
        const moTotal = months.reduce((s, x) => s + x.pts, 0);
        const periodBlurb = (weeks.length || months.length)
            ? `\nIt will also merge ${weeks.length} week${weeks.length === 1 ? '' : 's'} (${fmtNum(wkTotal)} 🏆) and ${months.length} month${months.length === 1 ? '' : 's'} (${fmtNum(moTotal)} 🏆) of weekly/monthly history into the matching periods.`
            : '';

        if (!confirm(
            `Add ${fmtNum(pts)} ★ and ${fmtNum(lb)} 🏆 from "${migrateFromUser.name}" to "${migrateToUser.name}"?\n\n` +
            `"${migrateToUser.name}" will have ${fmtNum(toPts)} ★ and ${fmtNum(toLb)} 🏆 after this.` +
            periodBlurb +
            `\nThe source account is left as-is.`
        )) return;

        const original = migrateBtn.innerHTML;
        migrateBtn.disabled = true;
        migrateBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Migrating...';
        const statusEl = document.getElementById('migrate-status');
        if (statusEl) statusEl.textContent = '';

        try {
            const updates = {};
            if (pts > 0) updates[`users/${migrateToUser.uid}/points`] = increment(pts);
            if (lb > 0) updates[`users/${migrateToUser.uid}/lbPoints`] = increment(lb);
            // Merge weekly + monthly history: target gets the same amounts in the same buckets.
            weeks.forEach(({ period, pts: p }) => { updates[`lbWeekly/${period}/${migrateToUser.uid}`] = increment(p); });
            months.forEach(({ period, pts: p }) => { updates[`lbMonthly/${period}/${migrateToUser.uid}`] = increment(p); });
            await update(ref(db), updates);

            // Log activity (admin names + amounts resolve nicely in the Activity Log)
            await push(ref(db, 'activity_log'), {
                user: 'Admin',
                userId: ADMIN_UID,
                action: `migrated ${fmtNum(pts)} ★ and ${fmtNum(lb)} 🏆 (overall) + ${weeks.length} weekly buckets (${fmtNum(wkTotal)} 🏆) + ${months.length} monthly buckets (${fmtNum(moTotal)} 🏆) from ${migrateFromUser.name} to ${migrateToUser.name}`,
                timestamp: Date.now()
            });

            const periodMsg = (weeks.length || months.length) ? ` Plus ${weeks.length} weekly & ${months.length} monthly history buckets were merged.` : '';
            alert(`Done! Added ${fmtNum(pts)} ★ and ${fmtNum(lb)} 🏆 from ${migrateFromUser.name} to ${migrateToUser.name}.${periodMsg}`);
            migrateFromInput.value = '';
            migrateToInput.value = '';
            refreshMigratePreview();
        } catch (err) {
            console.error(err);
            alert('Error migrating points: ' + err.message);
        } finally {
            migrateBtn.disabled = false;
            migrateBtn.innerHTML = original;
        }
    });

    refreshMigratePreview();

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

    // 9. Danger Zone: Delete 1,000 Oldest Game Posts
    const confirmGamesInput = document.getElementById('confirm-delete-games');
    const btnDeleteGames = document.getElementById('btn-delete-games');
    const statusGames = document.getElementById('delete-games-status');
    if (confirmGamesInput && btnDeleteGames) {
        confirmGamesInput.addEventListener('input', (e) => {
            if (e.target.value === 'delete 1k game posts') btnDeleteGames.removeAttribute('disabled');
            else btnDeleteGames.setAttribute('disabled', 'true');
        });
        btnDeleteGames.addEventListener('click', async () => {
            if (!confirm('PERMANENTLY delete the 1,000 oldest game posts? This cannot be undone.')) return;
            btnDeleteGames.setAttribute('disabled', 'true');
            const origHtml = btnDeleteGames.innerHTML;
            btnDeleteGames.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Scanning...';
            if (statusGames) statusGames.textContent = '';
            try {
                const candidates = [];
                for (const fsInst of [fsdb, fsdb2]) {
                    try {
                        const snap = await getDocs(fsQuery(collection(fsInst, 'community_posts'), orderBy('timestamp', 'asc'), limit(2000)));
                        snap.forEach(d => {
                            const data = d.data() || {};
                            if (data.isGame !== true && data.category !== 'Games') return;
                            const ts = data.timestamp && typeof data.timestamp.toMillis === 'function' ? data.timestamp.toMillis() : (typeof data.timestamp === 'number' ? data.timestamp : 0);
                            candidates.push({ ref: d.ref, id: d.id, ts });
                        });
                    } catch (e) { console.warn('Old-game scan failed on a database:', e); }
                }
                candidates.sort((a, b) => (a.ts || 0) - (b.ts || 0));
                const targets = candidates.slice(0, 1000);
                if (!targets.length) {
                    if (statusGames) statusGames.textContent = 'No game posts found.';
                    alert('No game posts to delete.');
                    return;
                }
                // Snapshot pinned ids -> clean up any deleted pins at the end.
                const pinnedRef = doc(fsdb, 'settings', 'pinned');
                let pinnedPatch = null;
                try {
                    const pinnedSnap = await getDoc(pinnedRef);
                    if (pinnedSnap.exists()) {
                        const pd = pinnedSnap.data() || {};
                        const targetIds = new Set(targets.map(t => t.id));
                        const feed = (pd.feedPinnedIds || []).filter(id => !targetIds.has(id));
                        const prof = (pd.profilePinnedIds || []).filter(id => !targetIds.has(id));
                        if (feed.length !== (pd.feedPinnedIds || []).length || prof.length !== (pd.profilePinnedIds || []).length) {
                            pinnedPatch = {};
                            if (feed.length !== (pd.feedPinnedIds || []).length) pinnedPatch.feedPinnedIds = feed;
                            if (prof.length !== (pd.profilePinnedIds || []).length) pinnedPatch.profilePinnedIds = prof;
                        }
                    }
                } catch (e) { /* ignore pinned read errors */ }

                // Slow, safe pacing: 10 deletes every 10s (~1 delete/sec average).
                // Well under Firestore's write limits, and avoids any burst "spam".
                // Tweak DELETE_BATCH / DELETE_GAP_MS to change the pace.
                const DELETE_BATCH = 10;       // docs deleted per burst
                const DELETE_GAP_MS = 10000;   // pause between bursts (10s)
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

                btnDeleteGames.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Deleting...';
                let deleted = 0;
                for (let i = 0; i < targets.length; i += DELETE_BATCH) {
                    const slice = targets.slice(i, i + DELETE_BATCH);
                    await Promise.all(slice.map(t => deleteDoc(t.ref).catch(() => {})));
                    deleted += slice.length;
                    const leftSecs = Math.max(0, Math.ceil(((targets.length - deleted) / DELETE_BATCH) * (DELETE_GAP_MS / 1000)));
                    if (statusGames) statusGames.textContent = `Deleted ${deleted}/${targets.length} · next batch in 10s · ~${leftSecs}s left`;
                    if (deleted < targets.length) await sleep(DELETE_GAP_MS);
                }
                if (pinnedPatch && Object.keys(pinnedPatch).length) await updateDoc(pinnedRef, pinnedPatch).catch(() => {});
                await fetchPostsCount();
                await push(ref(db, 'activity_log'), { user: 'Admin', action: `deleted ${deleted} oldest game posts`, timestamp: Date.now() });
                confirmGamesInput.value = '';
                if (statusGames) statusGames.textContent = `Done — deleted ${deleted} oldest game posts.`;
                alert(`Successfully deleted ${deleted} oldest game posts.`);
            } catch (err) {
                console.error(err);
                if (statusGames) statusGames.textContent = `Error: ${err.message}`;
                alert('Error deleting game posts: ' + err.message);
            } finally {
                btnDeleteGames.innerHTML = origHtml;
            }
        });
    }
}

// Resolve every captured IP for a user — supports both the legacy { ip, at }
// shape and the new { ips: { ip: lastSeen } } multi-IP map (up to 5 IPs).
// Stored keys swap "." for "_" (RTDB can't use dotted keys) — reverse for display.
function uidIps(uid) {
    const d = globalIps[uid];
    if (!d) return [];
    const decode = k => String(k).replace(/_/g, '.');
    if (d.ips && typeof d.ips === 'object') return Object.keys(d.ips).map(decode);
    if (d.ip) return [decode(d.ip)];
    return [];
}

function renderUsersList() {
    const listEl = document.getElementById('admin-users-list');
    const query = document.getElementById('admin-user-search').value.toLowerCase();
    
    listEl.innerHTML = '';
    
    // Build a map of ip -> [uids] so we can flag accounts sharing the same IP.
    // A user may have multiple IPs (WiFi + mobile), so every captured IP counts.
    const ipGroups = {};
    Object.entries(globalIps).forEach(([uid]) => {
        uidIps(uid).forEach(ip => {
            (ipGroups[ip] = ipGroups[ip] || []).push(uid);
        });
    });
    const sharedIps = Object.entries(ipGroups).filter(([, uids]) => uids.length > 1);
    
    if (sharedIps.length > 0) {
        const warn = document.createElement('div');
        warn.className = "mb-2 px-2.5 py-2 rounded-lg text-[10px] font-semibold bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400 flex items-center gap-2";
        warn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${sharedIps.length} IP group${sharedIps.length > 1 ? 's' : ''} share${sharedIps.length > 1 ? '' : 's'} one address — possible dummy/multi accounts. Review flagged rows below.`;
        listEl.appendChild(warn);
    }
    
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
        const isInactive = u.isInactive === true;

        const myIps = uidIps(u.uid);
        const ipChip = myIps.length
            ? `<span class="flex flex-col items-end gap-0.5">${myIps.map(ipx => {
                const group = ipGroups[ipx] || [];
                const ipShared = group.length > 1;
                return `<span class="text-[9px] font-mono px-1.5 py-0.5 rounded flex items-center ${ipShared ? 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/40' : 'bg-slate-200/50 dark:bg-slate-800 text-emerald-600 dark:text-emerald-400'}" title="${ipx}${ipShared ? ` — shared by ${group.length} accounts` : ''}"><i class="fa-solid fa-network-wired mr-1 text-[8px]"></i>${ipx}${ipShared ? ` ⚠×${group.length}` : ''}</span>`;
              }).join('')}</span>`
            : `<span class="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-200/50 dark:bg-slate-800 text-slate-400 dark:text-slate-500" title="No IP captured yet (user hasn't logged in again since this feature shipped)"><i class="fa-solid fa-circle-question mr-1 text-[8px]"></i>no IP</span>`;

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
                <div class="flex flex-col items-end gap-1 mr-1">
                    ${ipChip}
                    <div class="text-[9px] font-mono text-slate-400 dark:text-slate-500 bg-slate-200/50 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                        ${u.uid.substring(0, 8)}...
                    </div>
                </div>
                <button onclick="navigator.clipboard.writeText('${u.uid}'); alert('Copied UID: ${u.uid}');" class="ml-1 w-5 h-5 rounded text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 flex items-center justify-center transition opacity-0 group-hover:opacity-100" title="Copy UID">
                    <i class="fa-solid fa-copy text-[10px]"></i>
                </button>
                <button onclick="window.toggleInactive('${u.uid}')" class="ml-1 px-2 py-1 rounded text-[9px] font-bold transition ${isInactive ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-amber-500 hover:text-white'}" title="${isInactive ? 'Mark as active (show in leaderboards & stars again)' : 'Mark as inactive (hidden from leaderboards & stars, data kept)'}">
                    <i class="fa-solid ${isInactive ? 'fa-user-check' : 'fa-user-slash'} mr-1 text-[8px]"></i>${isInactive ? 'Active' : 'Inactive'}
                </button>
            </div>
        `;
        listEl.appendChild(div);
    });
}

// Mirror flagged groups (uids ONLY — no IPs) to a public node so the game
// award code can detect same-IP host+winner pairs without exposing IP addresses.
let _lastFlaggedSig = '';
function writeFlaggedGroups(groups) {
    const mapped = {};
    groups.forEach(([, uids], i) => {
        mapped[`g${i}`] = { at: Date.now(), uids: [...uids] };
    });
    const sig = JSON.stringify(Object.values(mapped).map(g => g.uids.sort().join(',')));
    if (sig === _lastFlaggedSig) return; // unchanged — skip write churn
    _lastFlaggedSig = sig;
    try {
        if (groups.length === 0) set(ref(db, 'flaggedGroups'), null).catch(() => {});
        else set(ref(db, 'flaggedGroups'), mapped).catch(() => {});
    } catch (e) { /* best-effort */ }
}

// Possible Multi-Accounts — group the anti-abuse /user_ips data by shared IP and
// list each account so admins can review suspected dummy accounts at a glance.
function renderMultiAccounts() {
    const listEl = document.getElementById('admin-multiacc-list');
    const countEl = document.getElementById('admin-multiacc-count');
    if (!listEl) return;

    // uid -> { ips: { ip: lastSeen } }; group uids that share an IP (any of a user's IPs).
    const ipGroups = {};
    Object.entries(globalIps).forEach(([uid]) => {
        uidIps(uid).forEach(ip => {
            (ipGroups[ip] = ipGroups[ip] || []).push(uid);
        });
    });

    const groups = Object.entries(ipGroups)
        .filter(([, uids]) => uids.length > 1)
        .sort((a, b) => b[1].length - a[1].length);

    if (countEl) countEl.textContent = `${groups.length} group${groups.length === 1 ? '' : 's'}`;

    if (groups.length === 0) {
        listEl.innerHTML = '<div class="text-[11px] text-slate-400 dark:text-slate-500 text-center py-5"><i class="fa-solid fa-shield-halved mr-1"></i> No shared IPs detected.</div>';
        return;
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
    listEl.innerHTML = '';

    groups.forEach(([ip, uids]) => {
        const group = document.createElement('div');
        group.className = 'rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-900/10 overflow-hidden';

        const head = document.createElement('div');
        head.className = 'flex items-center justify-between px-2.5 py-1.5 bg-amber-100/60 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-900/40';
        head.innerHTML = `
            <div class="flex items-center gap-1.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 truncate">
                <i class="fa-solid fa-network-wired text-[9px] shrink-0"></i> <span class="truncate">${esc(ip)}</span>
            </div>
            <span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500 text-white shrink-0 ml-2">${uids.length} accounts</span>
        `;
        group.appendChild(head);

        uids.forEach(uid => {
            const u = globalUsers[uid] || {};
            const isInactive = u.isInactive === true;
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between px-2.5 py-2 hover:bg-white dark:hover:bg-slate-800/60 transition-colors';
            row.innerHTML = `
                <div class="flex items-center space-x-2 min-w-0">
                    <img src="${esc(u.pic || window.generateAvatar(uid))}" class="w-7 h-7 rounded-full object-cover border border-slate-200 dark:border-slate-700 shadow-sm shrink-0">
                    <div class="min-w-0">
                        <p class="font-bold text-[11px] text-slate-800 dark:text-slate-100 truncate">${esc(u.name || 'Unknown')}</p>
                        <div class="flex items-center space-x-1.5 mt-0.5">
                            <span class="text-[9px] font-semibold text-amber-500 bg-amber-50 dark:bg-amber-500/10 px-1 py-0.5 rounded">★ ${u.points || 0}</span>
                            <span class="text-[9px] font-semibold text-blue-500 bg-blue-50 dark:bg-blue-500/10 px-1 py-0.5 rounded">🏆 ${u.lbPoints || 0}</span>
                            <span class="text-[8px] font-mono text-slate-400 dark:text-slate-500">${esc(uid.substring(0, 8))}…</span>
                        </div>
                        <div class="text-[8px] font-mono text-slate-400 dark:text-slate-500 mt-0.5 truncate"><i class="fa-solid fa-network-wired mr-0.5 text-[7px]"></i>${esc(uidIps(uid).join(' · ') || 'no IP')}</div>
                    </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button onclick="navigator.clipboard.writeText('${esc(uid)}'); alert('Copied UID: ${esc(uid)}');" class="w-6 h-6 rounded text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 flex items-center justify-center transition" title="Copy UID">
                        <i class="fa-solid fa-copy text-[9px]"></i>
                    </button>
                    <button onclick="window.toggleInactive('${esc(uid)}')" class="px-2 py-1 rounded text-[9px] font-bold transition ${isInactive ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-amber-500 hover:text-white'}" title="${isInactive ? 'Mark as active' : 'Mark as inactive (hidden from leaderboards & stars)'}">
                        <i class="fa-solid ${isInactive ? 'fa-user-check' : 'fa-user-slash'} mr-1 text-[8px]"></i>${isInactive ? 'Active' : 'Inactive'}
                    </button>
                </div>
            `;
            group.appendChild(row);
        });

        listEl.appendChild(group);
    });

    // Keep the public shield mirror in sync with what's rendered here.
    writeFlaggedGroups(groups);
}

// Mark a user inactive/active — hidden from leaderboards & stars (their points,
// leaderboard, and earnings data stays intact on their profile).
function toggleInactive(uid) {
    const isInactive = globalUsers[uid]?.isInactive === true;
    if (!confirm(isInactive
        ? "Mark this user as Active? They will appear in leaderboards and stars again."
        : "Mark this user as Inactive? They will be hidden from leaderboards and stars (all their data is kept).")) return;
    const name = globalUsers[uid]?.name || uid;
    update(ref(db, `users/${uid}`), { isInactive: !isInactive })
        .then(() => {
            push(ref(db, 'activity_log'), {
                user: 'Admin',
                userId: ADMIN_UID,
                action: `marked ${name} as ${isInactive ? 'active' : 'inactive'}`,
                timestamp: Date.now()
            });
        })
        .catch(err => alert('Error updating status: ' + err.message));
}
window.toggleInactive = toggleInactive;

// ============================================================
// MIGRATE USER POINTS — Stars ★ & Leaderboard 🏆 from one
// account into another. ADDITIVE ONLY: the receiving user's
// `points` and `lbPoints` are incremented, never replaced.
// The source account is left untouched (admin judgement call
// before/after) and the action is logged to /activity_log.
// ============================================================
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const fmtNum = (n) => (Number(n) || 0).toLocaleString();

// Selected users for the migration card (resolved from the search inputs).
let migrateFromUser = null;
let migrateToUser = null;

// Resolve what the admin typed into a user record: a pasted full UID wins,
// otherwise the exact display name (datalist picks resolve cleanly).
function resolveMigrateUser(raw) {
    raw = (raw || '').trim();
    if (!raw) return null;
    if (globalUsers[raw]) return { uid: raw, ...globalUsers[raw] };
    const hits = Object.entries(globalUsers).filter(([, u]) => (u.name || '') === raw);
    if (hits.length === 1) return { uid: hits[0][0], ...hits[0][1] };
    if (hits.length > 1) return { ambiguous: true, count: hits.length };
    return null;
}

// Fill the shared <datalist> behind both search inputs (sorted by stars desc).
function populateMigrateDatalist() {
    const dl = document.getElementById('migrate-users-datalist');
    if (!dl) return;
    const users = Object.entries(globalUsers)
        .filter(([, u]) => u && (u.name || '').trim())
        .sort((a, b) => (b[1].points || 0) - (a[1].points || 0));
    dl.innerHTML = users.map(([, u]) => `<option value="${escHtml(u.name)}"></option>`).join('');
    refreshMigratePreview();
}

// Weekly/monthly LB cache for the currently-selected source user.
// weeks/months are [{ period, pts }]; failed=true means the read errored.
let migratePeriodData = { fromUid: null, weeks: [], months: [], loading: false, failed: false };

// Load the source user's entries from /lbWeekly & /lbMonthly so they can be
// merged into the target's matching buckets. Cached per source UID (a rare
// admin action, so a full read of the two parent nodes is acceptable).
async function loadMigratePeriodData() {
    const fromUid = migrateFromUser && !migrateFromUser.ambiguous ? migrateFromUser.uid : null;
    if (!fromUid) {
        migratePeriodData = { fromUid: null, weeks: [], months: [], loading: false, failed: false };
        return;
    }
    if (migratePeriodData.fromUid === fromUid) return; // already loading or cached for this source

    migratePeriodData = { fromUid, weeks: [], months: [], loading: true, failed: false };
    refreshMigratePreview(); // show "checking…" immediately
    try {
        const [w, m] = await Promise.all([get(ref(db, 'lbWeekly')), get(ref(db, 'lbMonthly'))]);
        const weeks = [], months = [];
        if (w.exists()) w.forEach(ws => { const p = Number(ws.child(fromUid).val()) || 0; if (p > 0) weeks.push({ period: ws.key, pts: p }); });
        if (m.exists()) m.forEach(ms => { const p = Number(ms.child(fromUid).val()) || 0; if (p > 0) months.push({ period: ms.key, pts: p }); });
        migratePeriodData = { fromUid, weeks, months, loading: false, failed: false };
    } catch (err) {
        console.error('loadMigratePeriodData failed:', err);
        migratePeriodData = { fromUid, weeks: [], months: [], loading: false, failed: true };
    }
    refreshMigratePreview();
}

// Re-render the before/after preview + enable/disable the Migrate button.
function refreshMigratePreview() {
    const fromInput = document.getElementById('migrate-from-user');
    const toInput = document.getElementById('migrate-to-user');
    const preview = document.getElementById('migrate-preview');
    const btn = document.getElementById('btn-migrate-points');
    const status = document.getElementById('migrate-status');
    if (!fromInput || !toInput || !preview || !btn) return;

    migrateFromUser = fromInput.value.trim() ? resolveMigrateUser(fromInput.value) : null;
    migrateToUser = toInput.value.trim() ? resolveMigrateUser(toInput.value) : null;
    btn.disabled = true;

    const warn = (text) => {
        preview.innerHTML = `<div class="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-[11px] font-semibold text-amber-700 dark:text-amber-400"><i class="fa-solid fa-triangle-exclamation mt-0.5 shrink-0"></i><span>${escHtml(text)}</span></div>`;
        if (status) status.textContent = '';
    };

    if (!fromInput.value.trim() && !toInput.value.trim()) {
        preview.innerHTML = `<p class="text-[11px] text-slate-400 dark:text-slate-500 px-1">Pick the source and target users above to preview the transfer.</p>`;
        if (status) status.textContent = '';
        return;
    }
    if (migrateFromUser && migrateFromUser.ambiguous) return warn(`Multiple users are named "${fromInput.value.trim()}" — type a more specific name or paste the UID.`);
    if (migrateToUser && migrateToUser.ambiguous) return warn(`Multiple users are named "${toInput.value.trim()}" — type a more specific name or paste the UID.`);
    if (fromInput.value.trim() && !migrateFromUser) return warn(`Source user "${fromInput.value.trim()}" was not found.`);
    if (toInput.value.trim() && !migrateToUser) return warn(`Target user "${toInput.value.trim()}" was not found.`);
    if (!migrateFromUser || !migrateToUser) {
        migratePeriodData = { fromUid: null, weeks: [], months: [], loading: false, failed: false };
        preview.innerHTML = `<p class="text-[11px] text-slate-400 dark:text-slate-500 px-1">Select both the source and the target user to preview the transfer.</p>`;
        if (status) status.textContent = '';
        return;
    }

    if (migrateFromUser.uid === migrateToUser.uid) return warn('Source and target are the same user.');

    // Ensure the weekly/monthly scan is running (or cached) for this source.
    loadMigratePeriodData();

    const pts = Number(migrateFromUser.points) || 0;
    const lb = Number(migrateFromUser.lbPoints) || 0;
    const toPts = Number(migrateToUser.points) || 0;
    const toLb = Number(migrateToUser.lbPoints) || 0;
    if (pts <= 0 && lb <= 0 && !migratePeriodData.weeks.length && !migratePeriodData.months.length && !migratePeriodData.loading) {
        if (migratePeriodData.failed) return warn(`Could not read the weekly/monthly leaderboards and ${migrateFromUser.name} has no overall points — nothing to migrate.`);
        return warn(`${migrateFromUser.name} has no Stars, LB, or weekly/monthly points to migrate.`);
    }

    const row = (tag, name, shortUid, ptsChip, lbChip) => `
        <div class="flex items-center justify-between gap-2 text-[11px]">
            <span class="w-10 shrink-0 font-bold uppercase tracking-wider text-[9px] text-slate-500 dark:text-slate-400">${tag}</span>
            <span class="flex-1 min-w-0 font-bold text-slate-800 dark:text-slate-100 truncate">${escHtml(name)} <span class="text-[9px] font-mono text-slate-400">${escHtml(shortUid)}…</span></span>
            ${ptsChip}
            ${lbChip}
        </div>`;

    const chip = (value, cls) => `<span class="shrink-0 text-[10px] font-semibold ${cls}">${value}</span>`;

    // Weekly/monthly history line
    let periodLine = '';
    if (migratePeriodData.loading) {
        periodLine = `<p class="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500 px-1"><i class="fa-solid fa-circle-notch fa-spin text-violet-400"></i> Scanning weekly &amp; monthly LB history for ${escHtml(migrateFromUser.name)}…</p>`;
    } else if (migratePeriodData.failed) {
        periodLine = `<p class="flex items-center gap-1.5 text-[10px] text-amber-500 dark:text-amber-400 px-1"><i class="fa-solid fa-triangle-exclamation"></i> Couldn't read the weekly/monthly leaderboards — only overall points will be migrated. You can try again.</p>`;
    } else if (migratePeriodData.weeks.length || migratePeriodData.months.length) {
        const wkTotal = migratePeriodData.weeks.reduce((s, x) => s + x.pts, 0);
        const moTotal = migratePeriodData.months.reduce((s, x) => s + x.pts, 0);
        periodLine = `
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1.5 border-t border-slate-200 dark:border-slate-700 text-[10px] font-semibold text-slate-500 dark:text-slate-400">
                <span><i class="fa-solid fa-calendar-week text-violet-500 mr-1"></i>Weekly history: <span class="text-blue-500">${migratePeriodData.weeks.length} bucket${migratePeriodData.weeks.length === 1 ? '' : 's'}</span> (${fmtNum(wkTotal)} 🏆)</span>
                <span><i class="fa-solid fa-calendar text-violet-500 mr-1"></i>Monthly history: <span class="text-blue-500">${migratePeriodData.months.length} bucket${migratePeriodData.months.length === 1 ? '' : 's'}</span> (${fmtNum(moTotal)} 🏆)</span>
                <span class="text-emerald-600 dark:text-emerald-400">→ merged into the same periods</span>
            </div>`;
    }

    preview.innerHTML = `
        <div class="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 p-3 space-y-1.5">
            ${row('From', migrateFromUser.name, migrateFromUser.uid.substring(0, 6), chip(`★ ${fmtNum(pts)}`, 'text-amber-500'), chip(`🏆 ${fmtNum(lb)}`, 'text-blue-500'))}
            ${row('To', migrateToUser.name, migrateToUser.uid.substring(0, 6), chip(`★ ${fmtNum(toPts)}`, 'text-amber-500'), chip(`🏆 ${fmtNum(toLb)}`, 'text-blue-500'))}
            <div class="flex items-center justify-between gap-2 pt-1.5 border-t border-slate-200 dark:border-slate-700 text-[11px]">
                <span class="w-10 shrink-0 font-bold uppercase tracking-wider text-[9px] text-emerald-600 dark:text-emerald-400">After</span>
                <span class="flex-1 min-w-0 font-bold text-slate-800 dark:text-slate-100 truncate">${escHtml(migrateToUser.name)}</span>
                <span class="shrink-0 text-[10px] font-bold text-amber-500">★ ${fmtNum(toPts + pts)}</span>
                <span class="shrink-0 text-[10px] font-bold text-blue-500">🏆 ${fmtNum(toLb + lb)}</span>
            </div>
            ${periodLine}
        </div>`;
    if (status) {
        const extra = (!migratePeriodData.loading && (migratePeriodData.weeks.length || migratePeriodData.months.length))
            ? ' Weekly/monthly history will be merged too.'
            : '';
        status.textContent = `${fmtNum(pts)} ★ + ${fmtNum(lb)} 🏆 will be added to ${migrateToUser.name}. Source stays as-is.${extra}`;
    }
    if (migratePeriodData.loading) return; // keep the button disabled until the scan finishes
    btn.disabled = false;
}
