import { db } from "./firebase-config.js";
import { ref, update, set, push, get, runTransaction, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

const POPULAR_EMOJIS = [
    "😀 Grinning Face", "😂 Face with Tears of Joy", "🤣 Rolling on the Floor Laughing", 
    "😍 Smiling Face with Heart-Eyes", "🥰 Smiling Face with Hearts", "😎 Smiling Face with Sunglasses",
    "🤔 Thinking Face", "🙄 Face with Rolling Eyes", "😴 Sleeping Face", "🤮 Face Vomiting",
    "🤡 Clown Face", "👻 Ghost", "👽 Alien", "🤖 Robot", "💩 Pile of Poo",
    "🔥 Fire", "✨ Sparkles", "🌟 Glowing Star", "💯 Hundred Points", "❤️ Red Heart",
    "🍎 Red Apple", "🍔 Hamburger", "🍕 Pizza", "🍺 Beer Mug", "🚗 Automobile",
    "⚽ Soccer Ball", "🏀 Basketball", "🎮 Video Game", "📱 Mobile Phone", "💻 Laptop"
];

window.openPostGameModal = () => {
    if (!window.currentUser) return window.showAlert("Please sign in to host a game.");
    document.getElementById('game-modal').classList.remove('hidden');
    
    // Reset form
    document.getElementById('game-prize').value = '';
    document.getElementById('game-target-user').value = '';
    document.getElementById('game-emoji-name').value = '';
    document.getElementById('game-target-reacts').value = '';
    document.getElementById('game-target-comments').value = '';
    document.getElementById('game-lb-points').value = '';
    document.getElementById('game-type').value = 'first_to_mine';
    
    const maxLb = window.siteSettings.maxLbPointsPrize ?? 5;
    document.getElementById('game-lb-points').max = maxLb;
    document.getElementById('game-lb-points-label').innerText = `LB Points (Max ${maxLb})`;

    const prizeLabel = document.getElementById('game-prize-label');
    if(prizeLabel) prizeLabel.innerText = `Prize`;

    // Populate Users Datalist
    const userDatalist = document.getElementById('game-users-datalist');
    userDatalist.innerHTML = '';
    if (window.globalUsersCache) {
        for (const uid in window.globalUsersCache) {
            const user = window.globalUsersCache[uid];
            if (uid !== window.currentUser.uid) {
                userDatalist.innerHTML += `<option value="${user.name}"></option>`;
            }
        }
    }

    // Populate Emoji Datalist
    const emojiDatalist = document.getElementById('game-emoji-datalist');
    emojiDatalist.innerHTML = POPULAR_EMOJIS.map(e => `<option value="${e}"></option>`).join('');

    window.toggleGameSettings();
};

window.closePostGameModal = () => {
    document.getElementById('game-modal').classList.add('hidden');
};

window.toggleGameSettings = () => {
    const type = document.getElementById('game-type').value;
    const settingsDiv = document.getElementById('last-comment-settings');
    const targetUserContainer = document.getElementById('game-target-user-container');
    const emojiNameContainer = document.getElementById('game-emoji-name-container');
    const challengeTargets = document.getElementById('game-challenge-targets');
    
    // Timer setting is shown for last_comment, challenge, and quick_challenge
    if (type === 'last_comment' || type === 'challenge' || type === 'quick_challenge') {
        settingsDiv.classList.remove('hidden');
        window.toggleTimerSettings();
    } else {
        settingsDiv.classList.add('hidden');
    }

    if (type === 'challenge' || type === 'quick_challenge') {
        targetUserContainer.classList.remove('hidden');
    } else {
        targetUserContainer.classList.add('hidden');
    }

    if (type === 'challenge') {
        challengeTargets.classList.remove('hidden');
    } else {
        challengeTargets.classList.add('hidden');
    }

    if (type === 'guess_emoji' || type === 'bring_me_emoji') {
        emojiNameContainer.classList.remove('hidden');
    } else {
        emojiNameContainer.classList.add('hidden');
    }
};

window.toggleTimerSettings = () => {
    const isAuto = document.getElementById('game-timer-auto').checked;
    const isDate = document.getElementById('game-timer-date').checked;
    const durationDiv = document.getElementById('game-duration-container');
    const dateDiv = document.getElementById('game-date-container');
    
    if (isAuto) {
        durationDiv.classList.remove('hidden');
    } else {
        durationDiv.classList.add('hidden');
    }

    if (isDate) {
        dateDiv.classList.remove('hidden');
    } else {
        dateDiv.classList.add('hidden');
    }
};

window.submitGame = async () => {
    if (!window.currentUser) return;
    
    const prize = document.getElementById('game-prize').value.trim();
    if (!prize) return window.showAlert("Please enter a prize amount.");

    const maxLbAllowed = window.siteSettings.maxLbPointsPrize ?? 5;
    const lbPointsReward = parseInt(document.getElementById('game-lb-points').value) || 0;
    if (lbPointsReward < 0 || lbPointsReward > maxLbAllowed) {
        return window.showAlert(`LB Points reward must be between 0 and ${maxLbAllowed}.`);
    }

    const type = document.getElementById('game-type').value;
    let endTime = null;
    let targetUserUid = null;
    let targetReacts = 0;
    let targetComments = 0;
    let emojiName = null;
    let emojiChar = null;

    if (type === 'challenge' || type === 'quick_challenge') {
        const targetNameInput = document.getElementById('game-target-user').value.trim();
        if (!targetNameInput) return window.showAlert("Please search and select a target user.");
        // Resolve name -> UID
        if (window.globalUsersCache) {
            for (const uid in window.globalUsersCache) {
                if (window.globalUsersCache[uid].name === targetNameInput) {
                    targetUserUid = uid;
                    break;
                }
            }
        }
        if (!targetUserUid) return window.showAlert(`User "${targetNameInput}" not found. Please select from the suggestions.`);
    }

    if (type === 'challenge') {
        targetReacts = parseInt(document.getElementById('game-target-reacts').value) || 0;
        targetComments = parseInt(document.getElementById('game-target-comments').value) || 0;
        if (targetReacts === 0 && targetComments === 0) return window.showAlert("Please set a target for reacts or comments.");
    }

    if (type === 'guess_emoji' || type === 'bring_me_emoji') {
        const emojiInput = document.getElementById('game-emoji-name').value.trim();
        if (!emojiInput) return window.showAlert("Please enter an Emoji Name.");
        // Check if host picked from datalist (format: "emoji name")
        const match = emojiInput.match(/^(\S+(?:\uFE0F)?)\s+(.+)$/);
        if (match) {
            emojiChar = match[1];
            emojiName = match[2];
        } else {
            emojiName = emojiInput;
        }
    }

    if (type === 'last_comment' || type === 'challenge' || type === 'quick_challenge') {
        const timerMode = document.querySelector('input[name="game-timer"]:checked').value;
        if (timerMode === 'auto') {
            const secs = parseInt(document.getElementById('game-duration').value);
            if (isNaN(secs) || secs < 1) return window.showAlert("Please enter a valid duration in seconds.");
            endTime = Date.now() + (secs * 1000);
        } else if (timerMode === 'date') {
            const dateVal = document.getElementById('game-date').value;
            if (!dateVal) return window.showAlert("Please select a date and time.");
            endTime = new Date(dateVal).getTime();
            if (isNaN(endTime) || endTime <= Date.now()) return window.showAlert("Please select a future date and time.");
        }
    }

    const targetUserName = targetUserUid ? (window.globalUsersCache[targetUserUid]?.name || targetUserUid) : null;

    let text = "Game Time!";
    if (type === 'first_to_mine') text = "First person to mine wins!";
    else if (type === 'last_comment') text = "Last person to comment wins!";
    else if (type === 'quick_challenge') text = `Quick Challenge for @${targetUserName}! 🔥`;
    else if (type === 'challenge') text = `Challenge for @${targetUserName}! Reach ${targetReacts} reacts and ${targetComments} comments!`;
    else if (type === 'guess_emoji') text = `Guess the Emoji! I'm thinking of an emoji... 🤔`;
    else if (type === 'bring_me_emoji') text = `Bring me the Emoji: ${emojiName}! ${emojiChar || ''}`.trim();

    const postData = {
        authorId: window.currentUser.uid,
        text: text,
        category: 'Games',
        timestamp: Date.now(),
        visibility: 'public',
        isGame: true,
        gameType: type,
        gamePrize: prize,
        gameLbPoints: lbPointsReward,
        gameStatus: 'active',
        gameWinner: null
    };

    if (targetUserUid) postData.gameTargetUser = targetUserUid;
    if (type === 'challenge') {
        postData.gameTargetReacts = targetReacts;
        postData.gameTargetComments = targetComments;
    }
    if (emojiName) postData.gameEmojiName = emojiName;
    if (emojiChar) postData.gameEmojiChar = emojiChar;
    if (endTime) postData.gameEndTime = endTime;

    try {
        const newPostRef = push(ref(db, 'community_posts'));
        await set(newPostRef, postData);
        // Send a notification to the target user
        if (targetUserUid) {
            const notifRef = push(ref(db, `users/${targetUserUid}/notifications`));
            await set(notifRef, {
                type: 'game_challenge',
                sourceUid: window.currentUser.uid,
                postId: newPostRef.key,
                timestamp: Date.now(),
                read: false
            });
        }
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
        const snap = await get(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.val();

        if (post.gameStatus !== 'active') {
            return window.showAlert("Too late! This game has already ended.");
        }

        if (post.gameEndTime && Date.now() >= post.gameEndTime) {
            return window.showAlert("Time's up! You failed to complete the challenge in time.");
        }

        if (post.authorId === window.currentUser.uid) {
            return window.showAlert("You cannot win your own game!");
        }

        if (post.gameType === 'quick_challenge' && post.gameTargetUser !== window.currentUser.uid) {
            return window.showAlert("This Quick Challenge is not for you!");
        }

        await update(postRef, {
            gameStatus: 'ended',
            gameWinner: window.currentUser.uid
        });

        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
        if (lbPoints > 0) update(ref(db, `users/${window.currentUser.uid}`), { lbPoints: increment(lbPoints) });
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId && post.authorId !== window.currentUser.uid) {
            update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
        }
        window.showAlert(`You won! +${lbPoints} LB points!`);
    } catch(e) {
        console.error("Mine error:", e);
        window.showAlert("Error playing game: " + e.message);
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
        
        if (lastCommenterId === post.authorId) {
            // Forfeit the game if the host was the last commenter
            lastCommenterId = null;
        }

        await update(ref(db, `community_posts/${postId}`), {
            gameStatus: 'ended',
            gameWinner: lastCommenterId || "none",
            locked: true
        });

        if (lastCommenterId) {
            const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
            if (lbPoints > 0) update(ref(db, `users/${lastCommenterId}`), { lbPoints: increment(lbPoints) });
            // Reward host only if someone actually won
            const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId) {
                update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
            }
        }
    } catch(e) {
        console.error("Error ending game:", e);
    }
};

window.checkGameTimers = (postsData) => {
    if(!postsData) return;
    const now = Date.now();
    for(const key in postsData) {
        const p = postsData[key];
        if (p.isGame && p.gameStatus === 'active' && p.gameEndTime && now >= p.gameEndTime) {
            if (p.gameType === 'last_comment') {
                window.endLastCommentGame(key);
            } else {
                // For quick_challenge, challenge, guess_emoji, bring_me_emoji
                // If time expires without a winner, the game ends with no winner
                update(ref(db, `community_posts/${key}`), {
                    gameStatus: 'ended',
                    gameWinner: "none",
                    locked: true
                }).catch(e => console.error("Error failing game on timeout:", e));
            }
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

window.checkChallenge = async (postId) => {
    if (!window.currentUser) return;
    const postRef = ref(db, `community_posts/${postId}`);
    const snap = await get(postRef);
    if (!snap.exists()) return;
    const post = snap.val();

    if (post.gameStatus !== 'active' || post.gameType !== 'challenge') return;

    const currentReacts = Object.keys(post.reactions || {}).reduce((sum, type) => sum + Object.keys(post.reactions[type] || {}).length, 0);
    const currentComments = Object.keys(post.comments || {}).length;

    if (currentReacts >= post.gameTargetReacts && currentComments >= post.gameTargetComments) {
        await runTransaction(postRef, (p) => {
            if (p && p.gameStatus === 'active') {
                p.gameStatus = 'ended';
                p.gameWinner = p.gameTargetUser;
                return p;
            }
            return p;
        }).then(result => {
            if (result.committed && result.snapshot.val().gameWinner === post.gameTargetUser) {
                const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
                if (lbPoints > 0) update(ref(db, `users/${post.gameTargetUser}`), { lbPoints: increment(lbPoints) });
                // Reward host
                const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
                if (hostLbReward > 0 && post.authorId) {
                    update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
                }
                const winnerName = window.globalUsersCache[post.gameTargetUser]?.name || post.gameTargetUser;
                window.showAlert(`Challenge completed! @${winnerName} won!`);
            }
        });
    } else {
        window.showAlert(`Progress: Reacts (${currentReacts}/${post.gameTargetReacts}), Comments (${currentComments}/${post.gameTargetComments})`);
    }
};

window.openAnswerModal = (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to answer.");
    document.getElementById('game-answer-postid').value = postId;
    document.getElementById('game-answer-input').value = '';
    document.getElementById('game-answer-modal').classList.remove('hidden');
};

window.submitGameAnswer = async () => {
    if (!window.currentUser) return;
    const postId = document.getElementById('game-answer-postid').value;
    const answer = document.getElementById('game-answer-input').value.trim();
    if (!answer) return window.showAlert("Please enter an answer.");

    const postRef = ref(db, `community_posts/${postId}`);

    try {
        const snap = await get(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.val();

        if (post.gameStatus !== 'active') {
            return window.showAlert("This game has already ended.");
        }

        if (post.gameEndTime && Date.now() >= post.gameEndTime) {
            return window.showAlert("Time's up! The game is over.");
        }

        if (post.authorId === window.currentUser.uid) {
            return window.showAlert("You cannot answer your own game!");
        }

        // For guess_emoji: player types the name → match against gameEmojiName
        // For bring_me_emoji: player types/pastes the emoji char → match against gameEmojiChar
        const correctName = (post.gameEmojiName || '').toLowerCase();
        const correctChar = (post.gameEmojiChar || '');
        const answerLower = answer.toLowerCase();

        let isCorrect = false;
        if (post.gameType === 'guess_emoji') {
            isCorrect = answerLower === correctName;
        } else if (post.gameType === 'bring_me_emoji') {
            // Accept exact emoji char match (or name as fallback if no char stored)
            isCorrect = correctChar ? answer === correctChar : answerLower === correctName;
        }

        if (!isCorrect) {
            return window.showAlert("Incorrect! Try again.");
        }

        // Write winner
        await update(postRef, {
            gameStatus: 'ended',
            gameWinner: window.currentUser.uid
        });

        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
        if (lbPoints > 0) update(ref(db, `users/${window.currentUser.uid}`), { lbPoints: increment(lbPoints) });
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId && post.authorId !== window.currentUser.uid) {
            update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
        }
        document.getElementById('game-answer-modal').classList.add('hidden');
        window.showAlert(`Correct! 🎉 You won ${lbPoints} LB points!`);
    } catch(e) {
        console.error("Answer error:", e);
        window.showAlert("Error submitting answer: " + e.message);
    }
};
