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

const POPULAR_FLAGS = [
    { code: 'us', name: 'United States' }, { code: 'gb', name: 'United Kingdom' }, { code: 'ca', name: 'Canada' },
    { code: 'au', name: 'Australia' }, { code: 'jp', name: 'Japan' }, { code: 'de', name: 'Germany' },
    { code: 'fr', name: 'France' }, { code: 'it', name: 'Italy' }, { code: 'es', name: 'Spain' },
    { code: 'br', name: 'Brazil' }, { code: 'mx', name: 'Mexico' }, { code: 'in', name: 'India' },
    { code: 'cn', name: 'China' }, { code: 'kr', name: 'South Korea' }, { code: 'ru', name: 'Russia' },
    { code: 'ph', name: 'Philippines' }, { code: 'sg', name: 'Singapore' }, { code: 'my', name: 'Malaysia' },
    { code: 'id', name: 'Indonesia' }, { code: 'th', name: 'Thailand' }
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
    document.getElementById('game-flag-name').value = '';
    document.getElementById('game-math-question').value = '';
    document.getElementById('game-math-answer').value = '';
    document.getElementById('game-jumbled-original').value = '';
    document.getElementById('game-jumbled-scrambled').value = '';
    document.getElementById('game-trivia-question').value = '';
    document.getElementById('game-trivia-answer').value = '';
    document.getElementById('game-bingo-letters').value = '5';
    document.getElementById('game-bingo-numbers').value = '3';
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

    // Populate Flag Datalist
    const flagDatalist = document.getElementById('game-flag-datalist');
    flagDatalist.innerHTML = POPULAR_FLAGS.map(f => `<option value="${f.name}" label="[${f.code.toUpperCase()}] ${f.name}"></option>`).join('');

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
    const flagContainer = document.getElementById('game-flag-container');
    const mathContainer = document.getElementById('game-math-container');
    const jumbledContainer = document.getElementById('game-jumbled-container');
    const triviaContainer = document.getElementById('game-trivia-container');
    const bingoContainer = document.getElementById('game-bingo-container');
    
    // Timer setting is shown for last_comment, challenge, quick_challenge, math, trivia, and bingo
    if (['last_comment', 'challenge', 'quick_challenge', 'math', 'trivia', 'bingo'].includes(type)) {
        settingsDiv.classList.remove('hidden');
        window.toggleTimerSettings();
    } else {
        settingsDiv.classList.add('hidden');
    }

    if (type === 'challenge' || type === 'quick_challenge') targetUserContainer.classList.remove('hidden');
    else targetUserContainer.classList.add('hidden');

    if (type === 'challenge') challengeTargets.classList.remove('hidden');
    else challengeTargets.classList.add('hidden');

    if (type === 'guess_emoji' || type === 'bring_me_emoji') emojiNameContainer.classList.remove('hidden');
    else emojiNameContainer.classList.add('hidden');

    if (type === 'flags') flagContainer.classList.remove('hidden');
    else flagContainer.classList.add('hidden');

    if (type === 'math') mathContainer.classList.remove('hidden');
    else mathContainer.classList.add('hidden');

    if (type === 'jumbled_words') jumbledContainer.classList.remove('hidden');
    else jumbledContainer.classList.add('hidden');

    if (type === 'trivia') triviaContainer.classList.remove('hidden');
    else triviaContainer.classList.add('hidden');

    if (type === 'bingo') bingoContainer.classList.remove('hidden');
    else bingoContainer.classList.add('hidden');
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

window.generateMathQuestion = () => {
    const ops = ['+', '-', '*'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a, b, answer;
    
    if (op === '+') {
        a = Math.floor(Math.random() * 50) + 10;
        b = Math.floor(Math.random() * 50) + 10;
        answer = a + b;
    } else if (op === '-') {
        a = Math.floor(Math.random() * 50) + 50;
        b = Math.floor(Math.random() * 40) + 10;
        answer = a - b;
    } else if (op === '*') {
        a = Math.floor(Math.random() * 12) + 2;
        b = Math.floor(Math.random() * 12) + 2;
        answer = a * b;
    }
    
    document.getElementById('game-math-question').value = `${a} ${op} ${b}`;
    document.getElementById('game-math-answer').value = answer.toString();
};

window.scrambleWord = () => {
    const orig = document.getElementById('game-jumbled-original').value.trim().toUpperCase();
    if (!orig) return window.showAlert("Please enter a word first.");
    
    let scrambled = orig;
    let attempts = 0;
    while (scrambled === orig && attempts < 10) {
        const arr = orig.split('');
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        scrambled = arr.join('');
        attempts++;
    }
    
    document.getElementById('game-jumbled-scrambled').value = scrambled;
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
    let flagName = null;
    let flagCode = null;
    let mathQuestion = null;
    let mathAnswer = null;
    let jumbledOriginal = null;
    let jumbledScrambled = null;
    let triviaQuestion = null;
    let triviaAnswer = null;
    let bingoLetterCount = 0;
    let bingoNumberCount = 0;
    let bingoMaxLetter = 'Z';
    let bingoMaxNumber = 10;

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

    if (type === 'flags') {
        const flagInput = document.getElementById('game-flag-name').value.trim();
        if (!flagInput) return window.showAlert("Please enter a Flag Name.");
        flagName = flagInput;
        // Try to match against the popular flags list to get the country code
        const matched = POPULAR_FLAGS.find(f => f.name.toLowerCase() === flagInput.toLowerCase());
        if (matched) {
            flagCode = matched.code;
            flagName = matched.name;
        } else {
            // Try to infer from input if it's already a 2-letter code
            if (flagInput.length === 2) flagCode = flagInput.toLowerCase();
        }
        if (!flagCode) return window.showAlert("Please select a flag from the suggestions.");
    }

    if (type === 'math') {
        mathQuestion = document.getElementById('game-math-question').value.trim();
        mathAnswer = document.getElementById('game-math-answer').value.trim();
        if (!mathQuestion || !mathAnswer) return window.showAlert("Please provide a Math Question and Answer.");
    }

    if (type === 'jumbled_words') {
        jumbledOriginal = document.getElementById('game-jumbled-original').value.trim().toUpperCase();
        jumbledScrambled = document.getElementById('game-jumbled-scrambled').value.trim().toUpperCase();
        if (!jumbledOriginal || !jumbledScrambled) return window.showAlert("Please enter a word and scramble it.");
    }

    if (type === 'trivia') {
        triviaQuestion = document.getElementById('game-trivia-question').value.trim();
        triviaAnswer = document.getElementById('game-trivia-answer').value.trim();
        if (!triviaQuestion || !triviaAnswer) return window.showAlert("Please provide a Trivia Question and Answer.");
    }

    if (type === 'bingo') {
        bingoLetterCount = parseInt(document.getElementById('game-bingo-letters').value) || 0;
        bingoNumberCount = parseInt(document.getElementById('game-bingo-numbers').value) || 0;
        bingoMaxLetter = document.getElementById('game-bingo-max-letter').value || 'Z';
        bingoMaxNumber = parseInt(document.getElementById('game-bingo-max-number').value) || 10;
        
        if (bingoLetterCount < 1 || bingoLetterCount > 26) return window.showAlert("Letter count must be between 1 and 26.");
        if (bingoNumberCount < 1 || bingoNumberCount > 100) return window.showAlert("Number count must be between 1 and 100.");
        
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const maxAvailableLetters = alphabet.indexOf(bingoMaxLetter.toUpperCase()) + 1;
        if (bingoLetterCount > maxAvailableLetters) {
            return window.showAlert(`You are asking players to pick ${bingoLetterCount} letters, but only ${maxAvailableLetters} letters (A-${bingoMaxLetter}) are available!`);
        }
        
        if (bingoNumberCount > bingoMaxNumber) {
            return window.showAlert(`You are asking players to pick ${bingoNumberCount} numbers, but only ${bingoMaxNumber} numbers (1-${bingoMaxNumber}) are available!`);
        }
    }

    if (['last_comment', 'challenge', 'quick_challenge', 'math', 'trivia', 'bingo'].includes(type)) {
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
    else if (type === 'bring_me_emoji') text = `Bring me the Emoji: ${emojiName}!`;
    else if (type === 'flags') text = `Guess the Flag! I'm thinking of a flag... 🌍`;
    else if (type === 'math') text = `Math Challenge! Solve this: ${mathQuestion}`;
    else if (type === 'jumbled_words') text = `Unscramble this word: ${jumbledScrambled}`;
    else if (type === 'trivia') text = `Trivia Time! 🤔 ${triviaQuestion}`;
    else if (type === 'bingo') text = `🎱 Bingo! Pick your entry — ${bingoLetterCount} letter(s) (A–${bingoMaxLetter}) + ${bingoNumberCount} number(s) (1–${bingoMaxNumber}). Submission open!`;

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
    if (flagName) postData.gameFlagName = flagName;
    if (flagCode) postData.gameFlagCode = flagCode;
    if (mathQuestion) postData.gameMathQuestion = mathQuestion;
    if (mathAnswer) postData.gameMathAnswer = mathAnswer;
    if (jumbledOriginal) postData.gameJumbledOriginal = jumbledOriginal;
    if (jumbledScrambled) postData.gameJumbledScrambled = jumbledScrambled;
    if (triviaQuestion) postData.gameTriviaQuestion = triviaQuestion;
    if (triviaAnswer) postData.gameTriviaAnswer = triviaAnswer;
    if (bingoLetterCount) {
        postData.bingoLetterCount = bingoLetterCount;
        postData.bingoNumberCount = bingoNumberCount;
        postData.bingoMaxLetter = bingoMaxLetter;
        postData.bingoMaxNumber = bingoMaxNumber;
        postData.bingoPhase = 'submission';
        postData.bingoCalledItems = [];
    }
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
        window.renderProfileData(false);
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
        // Flags: match flag name or char depending on how we handle it. (Usually players guess flag by name or char)
        const answerLower = answer.toLowerCase();

        let isCorrect = false;
        if (post.gameType === 'guess_emoji') {
            isCorrect = answerLower === (post.gameEmojiName || '').toLowerCase();
        } else if (post.gameType === 'bring_me_emoji') {
            const correctChar = (post.gameEmojiChar || '');
            isCorrect = correctChar ? answer === correctChar : answerLower === (post.gameEmojiName || '').toLowerCase();
        } else if (post.gameType === 'flags') {
            const correctName = (post.gameFlagName || '').toLowerCase();
            isCorrect = answerLower === correctName;
        } else if (post.gameType === 'math') {
            isCorrect = answerLower === (post.gameMathAnswer || '').toLowerCase();
        } else if (post.gameType === 'jumbled_words') {
            isCorrect = answerLower === (post.gameJumbledOriginal || '').toLowerCase();
        } else if (post.gameType === 'trivia') {
            isCorrect = answerLower === (post.gameTriviaAnswer || '').toLowerCase();
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

// ============================================================
// BINGO GAME FUNCTIONS
// ============================================================

// State for bingo entry selection (local, not Firebase)
window._bingoSelectedLetters = new Set();
window._bingoSelectedNumbers = new Set();
window._bingoEntryLetterCount = 0;
window._bingoEntryNumberCount = 0;

window.openBingoEntryModal = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    
    const snap = await get(ref(db, `community_posts/${postId}`));
    if (!snap.exists()) return;
    const post = snap.val();

    if (post.authorId === window.currentUser.uid) return window.showAlert("You cannot enter your own Bingo game.");
    if (post.bingoPhase !== 'submission') return window.showAlert("Submissions are now closed!");
    if (post.gameEndTime && Date.now() >= post.gameEndTime) return window.showAlert("Submission time is up!");

    // Check if already submitted
    const myEntry = await get(ref(db, `community_posts/${postId}/bingoEntries/${window.currentUser.uid}`));
    if (myEntry.exists()) {
        const e = myEntry.val();
        return window.showAlert(`You already submitted: ${e.letters.join(' ')} | ${e.numbers.join(' ')}`);
    }

    window._bingoSelectedLetters = new Set();
    window._bingoSelectedNumbers = new Set();
    window._bingoEntryLetterCount = post.bingoLetterCount;
    window._bingoEntryNumberCount = post.bingoNumberCount;

    const maxLetter = post.bingoMaxLetter || 'Z';
    const maxNumber = post.bingoMaxNumber || 10;

    document.getElementById('bingo-entry-postid').value = postId;
    document.getElementById('bingo-entry-info').textContent =
        `Pick ${post.bingoLetterCount} letter(s) from A–${maxLetter} and ${post.bingoNumberCount} number(s) from 1–${maxNumber}.`;

    // Build letter grid
    const letterGrid = document.getElementById('bingo-letter-grid');
    letterGrid.innerHTML = '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const letterIdx = alphabet.indexOf(maxLetter.toUpperCase());
    const validLetters = letterIdx !== -1 ? alphabet.substring(0, letterIdx + 1).split('') : alphabet.split('');
    validLetters.forEach(l => {
        const btn = document.createElement('button');
        btn.textContent = l;
        btn.className = 'w-8 h-8 rounded-lg text-sm font-bold border-2 border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-200 transition hover:border-purple-400 hover:text-purple-600';
        btn.onclick = () => window.toggleBingoItem(l, 'letter', btn);
        letterGrid.appendChild(btn);
    });

    // Build number grid
    const numberGrid = document.getElementById('bingo-number-grid');
    numberGrid.innerHTML = '';
    for (let i = 1; i <= maxNumber; i++) {
        const btn = document.createElement('button');
        btn.textContent = i;
        btn.className = 'w-9 h-9 rounded-lg text-sm font-bold border-2 border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-700 dark:text-gray-200 transition hover:border-blue-400 hover:text-blue-600';
        btn.onclick = () => window.toggleBingoItem(String(i), 'number', btn);
        numberGrid.appendChild(btn);
    }

    window.updateBingoSelectionCounters();
    document.getElementById('bingo-entry-modal').classList.remove('hidden');
};

window.toggleBingoItem = (item, type, btn) => {
    const isLetter = type === 'letter';
    const set = isLetter ? window._bingoSelectedLetters : window._bingoSelectedNumbers;
    const maxCount = isLetter ? window._bingoEntryLetterCount : window._bingoEntryNumberCount;

    if (set.has(item)) {
        set.delete(item);
        btn.className = btn.className.replace(/border-purple-500|border-blue-500|bg-purple-100|bg-blue-100|dark:bg-purple-900\/40|dark:bg-blue-900\/40|text-purple-700|text-blue-700/g, '');
        btn.classList.add('border-gray-200', 'dark:border-slate-600', 'bg-white', 'dark:bg-slate-700', 'text-gray-700', 'dark:text-gray-200');
    } else {
        if (set.size >= maxCount) return window.showAlert(`You can only pick ${maxCount} ${type}(s).`);
        set.add(item);
        if (isLetter) {
            btn.className = 'w-8 h-8 rounded-lg text-sm font-bold border-2 border-purple-500 bg-purple-100 dark:bg-purple-900/40 text-purple-700 transition';
        } else {
            btn.className = 'w-9 h-9 rounded-lg text-sm font-bold border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/40 text-blue-700 transition';
        }
    }
    window.updateBingoSelectionCounters();
};

window.updateBingoSelectionCounters = () => {
    document.getElementById('bingo-letter-counter').textContent =
        `(${window._bingoSelectedLetters.size}/${window._bingoEntryLetterCount})`;
    document.getElementById('bingo-number-counter').textContent =
        `(${window._bingoSelectedNumbers.size}/${window._bingoEntryNumberCount})`;

    const ready = window._bingoSelectedLetters.size === window._bingoEntryLetterCount
        && window._bingoSelectedNumbers.size === window._bingoEntryNumberCount;
    document.getElementById('bingo-submit-btn').disabled = !ready;
};

window.submitBingoEntry = async () => {
    const postId = document.getElementById('bingo-entry-postid').value;
    if (!window.currentUser || !postId) return;

    const letters = [...window._bingoSelectedLetters].sort();
    const numbers = [...window._bingoSelectedNumbers].map(Number).sort((a, b) => a - b).map(String);
    const entryKey = letters.join('') + '-' + numbers.join('');

    const postRef = ref(db, `community_posts/${postId}`);

    try {
        // Re-check phase and deadline
        const snap = await get(postRef);
        const post = snap.val();
        if (post.bingoPhase !== 'submission') return window.showAlert("Submissions are closed!");
        if (post.gameEndTime && Date.now() >= post.gameEndTime) return window.showAlert("Time's up!");

        // Check for duplicate entry key
        const dupSnap = await get(ref(db, `community_posts/${postId}/bingoEntryKeys/${entryKey}`));
        if (dupSnap.exists()) return window.showAlert("That combination is already taken! Try a different one.");

        // Check if already submitted
        const mySnap = await get(ref(db, `community_posts/${postId}/bingoEntries/${window.currentUser.uid}`));
        if (mySnap.exists()) return window.showAlert("You already submitted an entry!");

        // Write entry and key
        await update(ref(db, `community_posts/${postId}`), {
            [`bingoEntries/${window.currentUser.uid}`]: { letters, numbers, entryKey, timestamp: Date.now() },
            [`bingoEntryKeys/${entryKey}`]: window.currentUser.uid
        });

        document.getElementById('bingo-entry-modal').classList.add('hidden');
        window.showAlert(`✅ Entry submitted: ${letters.join(' ')} | ${numbers.join(' ')}`);
    } catch(e) {
        console.error("Bingo entry error:", e);
        window.showAlert("Error submitting entry: " + e.message);
    }
};

window.closeBingoSubmissions = async (postId) => {
    await update(ref(db, `community_posts/${postId}`), { bingoPhase: 'drawing' });
};

// ---- GLOBAL SPIN WHEEL & ANIMATIONS ----

const LETTER_COLORS = ['#8B5CF6', '#7C3AED', '#6D28D9', '#A78BFA'];
const NUMBER_COLORS = ['#F59E0B', '#D97706', '#B45309', '#FCD34D'];

window.drawBingoWheelCanvas = (canvas, items, angle) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!items.length) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6B7280';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No items left!', canvas.width / 2, canvas.height / 2);
        return;
    }

    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2, r = W / 2 - 4;
    const sliceAngle = (2 * Math.PI) / items.length;

    ctx.clearRect(0, 0, W, H);

    items.forEach((item, i) => {
        const startAngle = angle + i * sliceAngle;
        const endAngle = startAngle + sliceAngle;
        const isNumber = !isNaN(Number(item));
        const colors = isNumber ? NUMBER_COLORS : LETTER_COLORS;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = colors[i % colors.length];
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(startAngle + sliceAngle / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = 'white';
        const fontSize = items.length > 20 ? 9 : items.length > 15 ? 11 : 13;
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillText(item, r - 4, 4);
        ctx.restore();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, 2 * Math.PI);
    ctx.fillStyle = '#1E293B';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
};

window.getBingoPool = (post) => {
    const maxLetter = post.bingoMaxLetter || 'Z';
    const maxNumber = post.bingoMaxNumber || 10;
    
    // Generate letters from A up to maxLetter
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const letterIdx = alphabet.indexOf(maxLetter.toUpperCase());
    const letters = letterIdx !== -1 ? alphabet.substring(0, letterIdx + 1).split('') : alphabet.split('');
    
    // Generate numbers from 1 to maxNumber
    const numbers = Array.from({length: maxNumber}, (_, i) => String(i + 1));
    
    return [...letters, ...numbers];
};

window.spinBingoWheel = async (postId) => {
    const snap = await get(ref(db, `community_posts/${postId}`));
    if (!snap.exists()) return;
    const post = snap.val();

    const calledItems = Array.isArray(post.bingoCalledItems) ? post.bingoCalledItems : [];
    const allItems = window.getBingoPool(post);
    const pool = allItems.filter(i => !calledItems.includes(i));
    if (!pool.length) return;

    // Set disabled immediately so host can't double click
    const btn = document.getElementById(`bingo-spin-btn-${postId}`);
    if (btn) btn.disabled = true;

    // Pick a random winner index
    const winnerIndex = Math.floor(Math.random() * pool.length);
    const winner = pool[winnerIndex];
    
    // We update everything immediately!
    const newCalledItems = [...calledItems, winner];
    const updates = { 
        bingoCalledItems: newCalledItems,
        bingoLastSpin: {
            item: winner,
            startTime: Date.now()
        }
    };

    // Check for winner
    const winnerId = window.checkBingoWinner(post.bingoEntries || {}, newCalledItems);
    if (winnerId) {
        updates.gameStatus = 'ended';
        updates.gameWinner = winnerId;
        updates.bingoPhase = 'ended';
        updates.locked = true;
        
        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
        if (lbPoints > 0) update(ref(db, `users/${winnerId}`), { lbPoints: increment(lbPoints) });
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId) {
            update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
        }
    }

    await update(ref(db, `community_posts/${postId}`), updates);
};

window.processBingoAnimations = () => {
    if (!window._bingoRenderQueue) return;
    
    let isAnySpinning = false;

    window._bingoRenderQueue.forEach(q => {
        const post = q.postData;
        const canvas = document.getElementById(`bingo-wheel-${post.id}`);
        if (!canvas) return;

        // Note: post.bingoCalledItems ALREADY includes the winning item!
        const calledItems = Array.isArray(post.bingoCalledItems) ? post.bingoCalledItems : [];
        const allItems = window.getBingoPool(post);
        
        const spin = post.bingoLastSpin;
        const isSpinActive = spin && (Date.now() - spin.startTime < 4000);

        // If spinning, the "pool" of the wheel should be what it was BEFORE the spin.
        // So we add the winning item back to the pool by removing it from "called".
        const itemsToExclude = isSpinActive ? calledItems.filter(i => i !== spin.item) : calledItems;
        const pool = allItems.filter(i => !itemsToExclude.includes(i));

        if (isSpinActive) {
            isAnySpinning = true;
            // It's animating!
            const duration = 4000;
            const elapsed = Date.now() - spin.startTime;
            const winnerIndex = pool.indexOf(spin.item);
            
            if (winnerIndex !== -1) {
                const sliceAngle = (2 * Math.PI) / pool.length;
                const fullRotations = 6 * 2 * Math.PI; // Standardize rotations
                const targetAngle = -Math.PI / 2 - (winnerIndex * sliceAngle + sliceAngle / 2) + fullRotations;
                
                const t = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - t, 3);
                const currentAngle = targetAngle * eased;

                window.drawBingoWheelCanvas(canvas, pool, currentAngle);
            } else {
                window.drawBingoWheelCanvas(canvas, pool, 0);
            }
        } else {
            // Not spinning, draw statically on top (needle at 0 angle)
            window.drawBingoWheelCanvas(canvas, pool, 0);
        }
    });

    // Schedule next frame if anything is spinning
    if (isAnySpinning) {
        window._bingoGlobalSpinning = true;
        requestAnimationFrame(window.processBingoAnimations);
    } else {
        if (window._bingoGlobalSpinning) {
            window._bingoGlobalSpinning = false;
            // The animation just stopped. Feed will resume updating naturally
            setTimeout(() => {
                if (window.renderFeed) window.renderFeed(false);
                else if (window.renderProfileData) window.renderProfileData(false);
                if (window.processBingoAnimations) window.processBingoAnimations();
            }, 10);
        }
    }
    
    if (!window._bingoGlobalSpinning) {
        window._bingoRenderQueue = [];
    }
};

window.checkBingoWinner = (entries, calledItems) => {
    const calledSet = new Set(calledItems);
    for (const uid in entries) {
        const entry = entries[uid];
        const allCalled = [...entry.letters, ...entry.numbers].every(i => calledSet.has(i));
        if (allCalled) return uid;
    }
    return null;
};

window.endBingoGame = async (postId) => {
    if (!postId) return;
    await update(ref(db, `community_posts/${postId}`), {
        gameStatus: 'ended',
        gameWinner: 'none',
        bingoPhase: 'ended',
        locked: true
    });
    window.showAlert("Bingo game ended with no winner.");
};
