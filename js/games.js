import { db } from "./firebase-config.js";
import { ref, update, set, push, get, runTransaction, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

window.openPostGameModal = () => {
    if (!window.currentUser) return window.showAlert("Please sign in to host a game.");
    document.getElementById('game-modal').classList.remove('hidden');
    
    // Reset form
    document.getElementById('game-prize').value = '';
    document.getElementById('game-type').value = 'first_to_mine';
    window.toggleGameSettings();
};

window.closePostGameModal = () => {
    document.getElementById('game-modal').classList.add('hidden');
};

window.toggleGameSettings = () => {
    const type = document.getElementById('game-type').value;
    const settingsDiv = document.getElementById('last-comment-settings');
    if (type === 'last_comment') {
        settingsDiv.classList.remove('hidden');
        window.toggleTimerSettings();
    } else {
        settingsDiv.classList.add('hidden');
    }
};

window.toggleTimerSettings = () => {
    const isAuto = document.getElementById('game-timer-auto').checked;
    const durationDiv = document.getElementById('game-duration-container');
    if (isAuto) {
        durationDiv.classList.remove('hidden');
    } else {
        durationDiv.classList.add('hidden');
    }
};

window.submitGame = async () => {
    if (!window.currentUser) return;
    
    const prize = document.getElementById('game-prize').value.trim();
    if (!prize) return window.showAlert("Please enter a prize amount.");
    
    if (!isNaN(prize)) {
        const maxPrize = window.siteSettings.maxLbPointsPrize ?? 100;
        if (Number(prize) > maxPrize) {
            return window.showAlert(`Maximum prize allowed is ${maxPrize}.`);
        }
    }

    const type = document.getElementById('game-type').value;
    let endTime = null;
    
    if (type === 'last_comment') {
        const isAuto = document.getElementById('game-timer-auto').checked;
        if (isAuto) {
            const minutes = parseInt(document.getElementById('game-duration').value);
            if (isNaN(minutes) || minutes < 1) return window.showAlert("Please enter a valid duration in minutes.");
            endTime = Date.now() + (minutes * 60000);
        }
    }
    
    let text = type === 'first_to_mine' ? "First person to mine wins!" : "Last person to comment wins!";
    
    const postData = {
        authorId: window.currentUser.uid,
        text: text,
        category: 'Games',
        timestamp: Date.now(),
        visibility: 'public',
        isGame: true,
        gameType: type,
        gamePrize: prize,
        gameStatus: 'active',
        gameWinner: null
    };
    
    if (endTime) postData.gameEndTime = endTime;

    try {
        const newPostRef = push(ref(db, 'community_posts'));
        await set(newPostRef, postData);
        window.closePostGameModal();
        window.showAlert("Game posted successfully!");
    } catch(e) {
        console.error("Error posting game:", e);
        window.showAlert("Failed to post game.");
    }
};

window.mineGame = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const postRef = ref(db, `community_posts/${postId}`);
    
    try {
        const result = await runTransaction(postRef, (post) => {
            if (post) {
                if (post.gameStatus === 'active') {
                    post.gameStatus = 'ended';
                    post.gameWinner = window.currentUser.uid;
                    return post;
                }
            }
            return post;
        });
        
        if (result.committed && result.snapshot.val().gameWinner === window.currentUser.uid) {
            // Reward LB points
            const lbPoints = window.siteSettings.lbPointsPerWin ?? 5;
            update(ref(db, `users/${window.currentUser.uid}`), { lbPoints: increment(lbPoints) });
            window.showAlert(`You mined it first! You win ${lbPoints} LB points!`);
        } else {
            window.showAlert("Too late! Someone else already mined it.");
        }
    } catch(e) {
        console.error("Mine error:", e);
        window.showAlert("Error playing game.");
    }
};

window.endLastCommentGame = async (postId) => {
    if (!window.currentUser) return;
    
    try {
        const snap = await get(ref(db, `community_posts/${postId}`));
        const post = snap.val();
        if (!post || post.gameStatus !== 'active') return;
        
        let lastCommenterId = null;
        let lastCommentTime = 0;
        
        if (post.comments) {
            for (const key in post.comments) {
                const c = post.comments[key];
                if (c.timestamp > lastCommentTime && !c.isDeleted) {
                    if (!post.gameEndTime || c.timestamp <= post.gameEndTime) {
                        lastCommentTime = c.timestamp;
                        lastCommenterId = c.uid;
                    }
                }
            }
        }
        
        await update(ref(db, `community_posts/${postId}`), {
            gameStatus: 'ended',
            gameWinner: lastCommenterId || "none",
            locked: true
        });
        
        if (lastCommenterId) {
            update(ref(db, `users/${lastCommenterId}`), { lbPoints: increment(5) });
        }
        
        window.showAlert("Game ended!");
    } catch(e) {
        console.error("Error ending game:", e);
    }
};

window.checkGameTimers = (postsData) => {
    if(!postsData) return;
    const now = Date.now();
    for(const key in postsData) {
        const p = postsData[key];
        if (p.isGame && p.gameType === 'last_comment' && p.gameStatus === 'active' && p.gameEndTime && now >= p.gameEndTime) {
            window.endLastCommentGame(key);
        }
    }
};

// UI Timer updater
setInterval(() => {
    const timers = document.querySelectorAll('.game-timer');
    const now = Date.now();
    timers.forEach(el => {
        const endTime = parseInt(el.getAttribute('data-endtime'));
        const diff = endTime - now;
        if (diff <= 0) {
            el.innerText = "ENDED";
            el.classList.replace("text-purple-600", "text-red-500");
            el.classList.replace("dark:text-purple-400", "dark:text-red-400");
        } else {
            const m = Math.floor(diff / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            el.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
    });
}, 1000);
