// admin.js
import { app, auth, db } from "../js/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, onValue, set, update, get, query, limitToLast } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import "../js/globals.js";
import "../js/helpers.js";

const loadingScreen = document.getElementById('loading-screen');
const adminContent = document.getElementById('admin-content');
let globalUsers = {};
let allPostsCount = 0;

const ADMIN_UID = 'IYNhNTCcCsZQSGad3hu9rar0ILC3';

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
    const activityQuery = query(ref(db, 'activity_log'), limitToLast(50));
    onValue(activityQuery, (snap) => {
        const listEl = document.getElementById('admin-activity-list');
        listEl.innerHTML = '';
        if (snap.exists()) {
            const activities = [];
            snap.forEach(child => { activities.push(child.val()); });
            activities.reverse().forEach(act => {
                const div = document.createElement('div');
                div.className = "text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-slate-900 p-2 rounded border border-gray-100 dark:border-slate-800";
                const time = new Date(act.timestamp).toLocaleString();
                div.innerHTML = `<span class="text-blue-500 font-bold">${act.user}</span> ${act.action} <span class="text-xs text-gray-500 block mt-1">${time}</span>`;
                listEl.appendChild(div);
            });
        } else {
            listEl.innerHTML = '<p class="text-sm text-gray-500">No recent activity.</p>';
        }
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
        }
    });

    // 3. Listen for Posts (to get count)
    onValue(ref(db, 'community_posts'), (snap) => {
        if (snap.exists()) {
            allPostsCount = Object.keys(snap.val()).length;
            document.getElementById('metric-posts').innerText = allPostsCount;
        }
    });

    // 4. Listen to Settings
    onValue(ref(db, 'settings'), (snap) => {
        if (snap.exists()) {
            const settings = snap.val();
            document.getElementById('set-starsPerPost').value = settings.starsPerPost ?? '';
            document.getElementById('set-starsPerComment').value = settings.starsPerComment ?? '';
            document.getElementById('set-starsPerPoked').value = settings.starsPerPoked ?? '';
            document.getElementById('set-starsPerFollow').value = settings.starsPerFollow ?? '';
            document.getElementById('set-lbPointsPerWin').value = settings.lbPointsPerWin ?? '';
            document.getElementById('set-maxStarsPrize').value = settings.maxStarsPrize ?? '';
            document.getElementById('set-maxLbPointsPrize').value = settings.maxLbPointsPrize ?? '';
            document.getElementById('set-gameHostLbReward').value = settings.gameHostLbReward ?? '';
            document.getElementById('set-imageUploadLimit').value = settings.imageUploadLimit ?? '';
            document.getElementById('set-videoUploadLimit').value = settings.videoUploadLimit ?? '';
            document.getElementById('set-videoSizeLimitMB').value = settings.videoSizeLimitMB ?? '';
        } else {
            document.getElementById('set-starsPerPost').value = '';
            document.getElementById('set-starsPerComment').value = '';
            document.getElementById('set-starsPerPoked').value = '';
            document.getElementById('set-starsPerFollow').value = '';
            document.getElementById('set-lbPointsPerWin').value = '';
            document.getElementById('set-maxStarsPrize').value = '';
            document.getElementById('set-maxLbPointsPrize').value = '';
            document.getElementById('set-gameHostLbReward').value = '';
            document.getElementById('set-imageUploadLimit').value = '';
            document.getElementById('set-videoUploadLimit').value = '';
            document.getElementById('set-videoSizeLimitMB').value = '';
        }

        // Set placeholders
        document.getElementById('set-starsPerPost').placeholder = window.siteSettings.starsPerPost;
        document.getElementById('set-starsPerComment').placeholder = window.siteSettings.starsPerComment;
        document.getElementById('set-starsPerPoked').placeholder = window.siteSettings.starsPerPoked;
        document.getElementById('set-starsPerFollow').placeholder = window.siteSettings.starsPerFollow ?? '5';
        document.getElementById('set-lbPointsPerWin').placeholder = window.siteSettings.lbPointsPerWin;
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
            starsPerPost: parseInt(document.getElementById('set-starsPerPost').value) || 0,
            starsPerComment: parseInt(document.getElementById('set-starsPerComment').value) || 0,
            starsPerPoked: parseInt(document.getElementById('set-starsPerPoked').value) || 0,
            starsPerFollow: parseInt(document.getElementById('set-starsPerFollow').value) || 0,
            lbPointsPerWin: parseInt(document.getElementById('set-lbPointsPerWin').value) || 0,
            maxStarsPrize: parseInt(document.getElementById('set-maxStarsPrize').value) || 0,
            maxLbPointsPrize: parseInt(document.getElementById('set-maxLbPointsPrize').value) || 0,
            gameHostLbReward: parseInt(document.getElementById('set-gameHostLbReward').value) || 0,
            imageUploadLimit: parseInt(document.getElementById('set-imageUploadLimit').value) || 0,
            videoUploadLimit: parseInt(document.getElementById('set-videoUploadLimit').value) || 0,
            videoSizeLimitMB: parseInt(document.getElementById('set-videoSizeLimitMB').value) || 0,
        };

        try {
            await set(ref(db, 'settings'), newSettings);
            alert("Settings saved successfully!");
        } catch (error) {
            console.error(error);
            alert("Error saving settings: " + error.message);
        }
    });

    // 6. Handle Search
    document.getElementById('admin-user-search').addEventListener('input', renderUsersList);
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
        div.className = "flex items-center justify-between p-3 bg-gray-50 dark:bg-slate-900 rounded-lg border border-gray-100 dark:border-slate-800";
        div.innerHTML = `
            <div class="flex items-center space-x-3 truncate">
                <img src="${u.pic || window.generateAvatar(u.uid)}" class="w-10 h-10 rounded-full object-cover">
                <div class="truncate">
                    <p class="font-bold text-sm truncate flex items-center">${u.name || 'Unknown'} ${role.badgeHtml}</p>
                    <p class="text-xs text-gray-500">⭐ ${u.points || 0} | 🏆 ${u.lbPoints || 0}</p>
                </div>
            </div>
            <div class="text-xs text-gray-400 flex items-center">
                ${u.uid.substring(0, 8)}...
                <button onclick="navigator.clipboard.writeText('${u.uid}'); alert('Copied UID: ${u.uid}');" class="ml-2 text-gray-500 hover:text-blue-500 transition" title="Copy UID">
                    <i class="fa-solid fa-copy"></i>
                </button>
            </div>
        `;
        listEl.appendChild(div);
    });
}
