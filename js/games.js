import { db, fsdb } from "./firebase-config.js";
import { ref, update, set, push, get, increment } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, doc, addDoc, getDoc, updateDoc, deleteField, serverTimestamp as fsServerTimestamp, runTransaction as fsRunTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

window.logEarnings = (uid, postId, title, prize, lbPoints) => {
    push(ref(db, `users/${uid}/earnings`), {
        postId: postId || '',
        title: title || 'Game Reward',
        prize: prize || '',
        lbPoints: lbPoints || 0,
        timestamp: Date.now()
    });
};

window.logHostedGame = (hostUid, postId, title, prize, winnerUid, winnerName) => {
    push(ref(db, `users/${hostUid}/hostedGames`), {
        postId: postId || '',
        title: title || 'Game',
        prize: prize || '',
        winnerUid: winnerUid || '',
        winnerName: winnerName || '',
        paymentStatus: 'pending',
        timestamp: Date.now()
    });
};

window.gameTypeLabel = (type) => {
    const labels = {
        'math': 'Math Challenge',
        'trivia': 'Trivia Game',
        'jumbled_words': 'Jumbled Words',
        'flags': 'Guess the Flag',
        'guess_emoji': 'Guess the Emoji',
        'bring_me_emoji': 'Bring Me the Emoji',
        'first_to_mine': 'First to Mine',
        'last_comment': 'Last Comment',
        'challenge': 'Challenge',
        'quick_challenge': 'Quick Challenge',
        'bingo': 'Bingo',
        'spin_names': 'Spin the Names',
        'ncl': 'NCL Reward'
    };
    return labels[type] || type;
};

const POPULAR_EMOJIS = [
    "😀 Grinning Face", "😂 Face with Tears of Joy", "🤣 Rolling on the Floor Laughing", 
    "😍 Smiling Face with Heart-Eyes", "🥰 Smiling Face with Hearts", "😎 Smiling Face with Sunglasses",
    "🤔 Thinking Face", "🙄 Face with Rolling Eyes", "😴 Sleeping Face", "🤮 Face Vomiting",
    "🤡 Clown Face", "👻 Ghost", "👽 Alien", "🤖 Robot", "💩 Pile of Poo",
    "🔥 Fire", "✨ Sparkles", "🌟 Glowing Star", "💯 Hundred Points", "❤️ Red Heart",
    "🍎 Red Apple", "🍔 Hamburger", "🍕 Pizza", "🍺 Beer Mug", "🚗 Automobile",
    "⚽ Soccer Ball", "🏀 Basketball", "🎮 Video Game", "📱 Mobile Phone", "💻 Laptop",
    "🥺 Pleading Face", "😭 Loudly Crying Face", "😜 Winking Face with Tongue", "😇 Smiling Face with Halo",
    "🤬 Face with Symbols on Mouth", "🤯 Exploding Head", "🥶 Cold Face", "🥵 Hot Face",
    "😈 Smiling Face with Horns", "💀 Skull", "👺 Goblin", "👹 Ogre", "👾 Alien Monster",
    "🎃 Jack-O-Lantern", "🐱 Cat Face", "🐶 Dog Face", "🦊 Fox", "🦄 Unicorn",
    "🦋 Butterfly", "🦖 T-Rex", "🐙 Octopus", "🍉 Watermelon", "🍓 Strawberry",
    "🥑 Avocado", "🍩 Doughnut", "🍟 French Fries", "🌮 Taco", "🍣 Sushi",
    "🍦 Ice Cream", "☕ Hot Beverage", "🍷 Wine Glass", "🚀 Rocket", "✈️ Airplane",
    "🚁 Helicopter", "🚢 Ship", "🎡 Ferris Wheel", "⛺ Tent", "⛰️ Mountain",
    "🏖️ Beach with Umbrella", "🗺️ World Map", "⌚ Watch", "💎 Gem Stone", "💡 Light Bulb",
    "📚 Books", "🎉 Party Popper", "🎈 Balloon", "🎁 Wrapped Gift", "🧸 Teddy Bear",
    "🎵 Musical Note", "🎸 Guitar", "📸 Camera", "🎬 Clapper Board", "🎨 Palette",
    "🏆 Trophy", "🥇 1st Place Medal", "🎲 Game Die", "🧩 Puzzle Piece", "🥊 Martial Arts Uniform",
    "✅ Check Mark Button", "❌ Cross Mark", "⚠️ Warning", "🛑 Stop Sign", "⏳ Hourglass"
];

const POPULAR_FLAGS = [
    { code: 'us', name: 'United States' }, { code: 'gb', name: 'United Kingdom' }, { code: 'ca', name: 'Canada' },
    { code: 'au', name: 'Australia' }, { code: 'jp', name: 'Japan' }, { code: 'de', name: 'Germany' },
    { code: 'fr', name: 'France' }, { code: 'it', name: 'Italy' }, { code: 'es', name: 'Spain' },
    { code: 'br', name: 'Brazil' }, { code: 'mx', name: 'Mexico' }, { code: 'in', name: 'India' },
    { code: 'cn', name: 'China' }, { code: 'kr', name: 'South Korea' }, { code: 'ru', name: 'Russia' },
    { code: 'ph', name: 'Philippines' }, { code: 'sg', name: 'Singapore' }, { code: 'my', name: 'Malaysia' },
    { code: 'id', name: 'Indonesia' }, { code: 'th', name: 'Thailand' }, { code: 'vn', name: 'Vietnam' },
    { code: 'ar', name: 'Argentina' }, { code: 'za', name: 'South Africa' }, { code: 'ng', name: 'Nigeria' },
    { code: 'eg', name: 'Egypt' }, { code: 'ke', name: 'Kenya' }, { code: 'nz', name: 'New Zealand' },
    { code: 'nl', name: 'Netherlands' }, { code: 'se', name: 'Sweden' }, { code: 'no', name: 'Norway' },
    { code: 'dk', name: 'Denmark' }, { code: 'fi', name: 'Finland' }, { code: 'ch', name: 'Switzerland' },
    { code: 'at', name: 'Austria' }, { code: 'be', name: 'Belgium' }, { code: 'pt', name: 'Portugal' },
    { code: 'gr', name: 'Greece' }, { code: 'tr', name: 'Turkey' }, { code: 'sa', name: 'Saudi Arabia' },
    { code: 'ae', name: 'United Arab Emirates' }, { code: 'il', name: 'Israel' }, { code: 'pl', name: 'Poland' },
    { code: 'ua', name: 'Ukraine' }, { code: 'ie', name: 'Ireland' }, { code: 'cz', name: 'Czechia' },
    { code: 'hu', name: 'Hungary' }, { code: 'ro', name: 'Romania' }, { code: 'cl', name: 'Chile' },
    { code: 'co', name: 'Colombia' }, { code: 'pe', name: 'Peru' }, { code: 've', name: 'Venezuela' },
    { code: 'pk', name: 'Pakistan' }, { code: 'bd', name: 'Bangladesh' }, { code: 'lk', name: 'Sri Lanka' },
    { code: 'np', name: 'Nepal' }, { code: 'mm', name: 'Myanmar' }, { code: 'kh', name: 'Cambodia' },
    { code: 'tw', name: 'Taiwan' }, { code: 'hk', name: 'Hong Kong' }, { code: 'ma', name: 'Morocco' },
    { code: 'dz', name: 'Algeria' }, { code: 'gh', name: 'Ghana' }, { code: 'tz', name: 'Tanzania' },
    { code: 'et', name: 'Ethiopia' }, { code: 'ug', name: 'Uganda' }, { code: 'iq', name: 'Iraq' },
    { code: 'ir', name: 'Iran' }, { code: 'sy', name: 'Syria' }, { code: 'lb', name: 'Lebanon' },
    { code: 'jo', name: 'Jordan' }, { code: 'kw', name: 'Kuwait' }, { code: 'qa', name: 'Qatar' },
    { code: 'cu', name: 'Cuba' }, { code: 'jm', name: 'Jamaica' }, { code: 'do', name: 'Dominican Republic' },
    { code: 'ht', name: 'Haiti' }, { code: 'pa', name: 'Panama' }, { code: 'cr', name: 'Costa Rica' },
    { code: 'gt', name: 'Guatemala' }, { code: 'hn', name: 'Honduras' }, { code: 'sv', name: 'El Salvador' }
];

window.generateRandomMath = () => {
    const isAlgebra = Math.random() > 0.5;
    let question, answer;

    if (isAlgebra) {
        // Simple algebra like ax + b = c, find x
        const a = Math.floor(Math.random() * 5) + 1; // 1 to 5
        const x = Math.floor(Math.random() * 10) + 1; // 1 to 10
        const b = Math.floor(Math.random() * 20) + 1; // 1 to 20
        const isPlus = Math.random() > 0.5;
        
        if (isPlus) {
            const c = (a * x) + b;
            question = a === 1 ? `x + ${b} = ${c}, x = ?` : `${a}x + ${b} = ${c}, x = ?`;
        } else {
            const c = (a * x) - b;
            question = a === 1 ? `x - ${b} = ${c}, x = ?` : `${a}x - ${b} = ${c}, x = ?`;
        }
        answer = x.toString();
    } else {
        // Basic arithmetic
        const ops = ['+', '-', '*'];
        const op = ops[Math.floor(Math.random() * ops.length)];
        let num1, num2;
        
        if (op === '*') {
            num1 = Math.floor(Math.random() * 12) + 2;
            num2 = Math.floor(Math.random() * 12) + 2;
        } else {
            num1 = Math.floor(Math.random() * 50) + 10;
            num2 = Math.floor(Math.random() * 50) + 10;
            if (op === '-' && num2 > num1) {
                // Ensure positive answer for subtraction
                const temp = num1;
                num1 = num2;
                num2 = temp;
            }
        }
        
        question = `${num1} ${op} ${num2}`;
        answer = eval(question).toString();
    }

    document.getElementById('game-math-question').value = question;
    document.getElementById('game-math-answer').value = answer;
};

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
    const spinNamesContainer = document.getElementById('game-spin-names-container');
    const nclContainer = document.getElementById('game-ncl-container');
    
    // Timer setting is shown for last_comment, challenge, quick_challenge, math, trivia, bingo, and spin_names
    if (['last_comment', 'challenge', 'quick_challenge', 'math', 'trivia', 'bingo', 'spin_names'].includes(type)) {
        settingsDiv.classList.remove('hidden');
        window.toggleTimerSettings();
    } else {
        settingsDiv.classList.add('hidden');
    }

    if (type === 'challenge' || type === 'quick_challenge' || type === 'ncl') targetUserContainer.classList.remove('hidden');
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

    if (type === 'spin_names') spinNamesContainer.classList.remove('hidden');
    else spinNamesContainer.classList.add('hidden');

    if (type === 'ncl') nclContainer.classList.remove('hidden');
    else nclContainer.classList.add('hidden');

    // Hide LB Points field for NCL (disabled for now)
    const lbPointsLabel = document.getElementById('game-lb-points-label');
    const lbPointsInput = document.getElementById('game-lb-points');
    if (type === 'ncl') {
        if (lbPointsLabel) lbPointsLabel.closest('div').classList.add('hidden');
        if (lbPointsInput) lbPointsInput.value = '0';
    } else {
        if (lbPointsLabel) lbPointsLabel.closest('div').classList.remove('hidden');
    }
};

window.toggleSpinNamesWinners = () => {
    const count = parseInt(document.getElementById('game-spin-names-count').value);
    document.getElementById('spin-winner-2').classList.toggle('hidden', count < 2);
    document.getElementById('spin-winner-3').classList.toggle('hidden', count < 3);
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
    
    const words = orig.split(/\s+/);
    const scrambledWords = words.map(word => {
        if (word.length <= 1) return word; // Don't scramble single letters
        
        let scrambled = word;
        let attempts = 0;
        while (scrambled === word && attempts < 15) {
            const arr = word.split('');
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            scrambled = arr.join('');
            attempts++;
        }
        return scrambled;
    });
    
    document.getElementById('game-jumbled-scrambled').value = scrambledWords.join(' ');
};

window.submitGame = async () => {
    if (!window.currentUser) return;
    
    const type = document.getElementById('game-type').value;
    const prize = document.getElementById('game-prize').value.trim();
    // spin_names uses per-winner prizes; ncl prize is set in the global field
    if (!prize && type !== 'spin_names') return window.showAlert("Please enter a prize amount.");

    const maxLbAllowed = window.siteSettings.maxLbPointsPrize ?? 5;
    const lbPointsReward = parseInt(document.getElementById('game-lb-points').value) || 0;
    if (lbPointsReward < 0 || lbPointsReward > maxLbAllowed) {
        return window.showAlert(`LB Points reward must be between 0 and ${maxLbAllowed}.`);
    }

    // type already read above
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
    let spinNamesWinnersCount = 0;
    let spinNamesPrizes = [];

    if (type === 'challenge' || type === 'quick_challenge' || type === 'ncl') {
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

    if (type === 'spin_names') {
        spinNamesWinnersCount = parseInt(document.getElementById('game-spin-names-count').value) || 1;
        for (let i = 1; i <= spinNamesWinnersCount; i++) {
            const spinTarget = parseInt(document.getElementById(`spin-target-${i}`).value);
            const spinPrize = document.getElementById(`spin-prize-${i}`).value.trim();
            if (!spinTarget || !spinPrize) return window.showAlert(`Please fill out the Spin # and Prize for Winner ${i}.`);
            spinNamesPrizes.push({ target: spinTarget, prize: spinPrize, wonBy: null });
        }
    }

    if (['last_comment', 'challenge', 'quick_challenge', 'math', 'trivia', 'bingo', 'spin_names'].includes(type)) {
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
    else if (type === 'spin_names') {
        // Build caption with spin numbers and prizes
        const prizeLines = spinNamesPrizes.map(p => `Spin #${p.target}: ${p.prize}`).join(' | ');
        text = `🎡 Spin the Names! Join for a chance to win! — ${prizeLines}`;
    }
    else if (type === 'ncl') text = `ncl - ${prize} - @${targetUserName}. Congrats!! 🎉`;

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
        gameStatus: type === 'ncl' ? 'completed' : 'active',
        gameWinner: type === 'ncl' ? targetUserUid : null
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
    if (spinNamesWinnersCount > 0) {
        postData.spinNamesWinnersCount = spinNamesWinnersCount;
        postData.spinNamesPrizes = spinNamesPrizes;
        postData.spinNamesPhase = 'submission';
    }
    if (endTime) postData.gameEndTime = endTime;

    try {
        const newPostRef = await addDoc(collection(fsdb, 'community_posts'), postData);

        // For NCL: log the earning immediately since it's awarded on post creation
        if (type === 'ncl' && targetUserUid) {
            window.logEarnings(targetUserUid, newPostRef.id, 'NCL Reward', prize, lbPointsReward);
            const nclWinnerName = window.globalUsersCache?.[targetUserUid]?.name || targetUserUid;
            window.logHostedGame(window.currentUser.uid, newPostRef.id, 'NCL Reward', prize, targetUserUid, nclWinnerName);
        }

        // Close modal first — post was created successfully
        window.closePostGameModal();

        // Send notification separately so failures here don't show a fake error
        if (targetUserUid) {
            try {
                const notifRef = push(ref(db, `users/${targetUserUid}/notifications`));
                await set(notifRef, {
                    type: 'game_challenge',
                    fromUid: window.currentUser.uid,
                    fromName: window.currentUser.name,
                    postId: newPostRef.key,
                    timestamp: Date.now(),
                    read: false,
                    message: type === 'ncl' ? `awarded you ${prize} via ncl!` : `challenged you to a game!`
                });
            } catch(notifErr) {
                console.warn('Notification write failed (non-critical):', notifErr);
            }
        }
    } catch(e) {
        console.error("Error posting game:", e);
        window.showAlert("Failed to post game.");
    }
    // Always attempt re-render after modal closes (outside try so errors above don't block)
    if (typeof window.renderProfileData === 'function') window.renderProfileData(false);
};

window.mineGame = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const postRef = doc(fsdb, 'community_posts', postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

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

        await updateDoc(postRef, {
            gameStatus: 'ended',
            gameWinner: window.currentUser.uid
        });

        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
        if (lbPoints > 0) update(ref(db, `users/${window.currentUser.uid}`), { lbPoints: increment(lbPoints) });
        window.logEarnings(window.currentUser.uid, postId, window.gameTypeLabel(post.gameType), post.gamePrize, lbPoints);
        if (post.authorId && post.authorId !== window.currentUser.uid) {
            const myName = window.globalUsersCache?.[window.currentUser.uid]?.name || 'Someone';
            window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, window.currentUser.uid, myName);
        }
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
        let snap = await getDoc(doc(fsdb, 'community_posts', postId));
        let post = snap.data();
        if (post.gameStatus !== 'active') return; 
        
        // Update gameStatus to ending to lock out others
        await updateDoc(doc(fsdb, 'community_posts', postId), {
            gameStatus: 'evaluating',
            locked: true
        });

        // Wait 2 seconds for any last-millisecond comments to arrive
        await new Promise(resolve => setTimeout(resolve, 2000));

        // One more check in case of race conditions
        snap = await getDoc(doc(fsdb, 'community_posts', postId));
        post = snap.data();
        if (!post) return;

        let lastCommenterId = null;
        let lastCommentTime = 0;
        
        if (post.comments) {
            for (const key in post.comments) {
                const c = post.comments[key];
                if (c.timestamp > lastCommentTime && !c.isDeleted) {
                    if (c.uid !== post.authorId) { // Owner cannot be the winner
                        lastCommentTime = c.timestamp;
                        lastCommenterId = c.uid;
                    }
                }
            }
        }

        await updateDoc(doc(fsdb, 'community_posts', postId), {
            gameStatus: 'ended',
            gameWinner: lastCommenterId || "none"
        });

        if (lastCommenterId) {
            const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
            if (lbPoints > 0) update(ref(db, `users/${lastCommenterId}`), { lbPoints: increment(lbPoints) });
            window.logEarnings(lastCommenterId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, lbPoints);
            if (post.authorId) {
                const lcWinnerName = window.globalUsersCache?.[lastCommenterId]?.name || 'Someone';
                window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, lastCommenterId, lcWinnerName);
            }
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
                if (p.gameEndTime && p.gameStatus === 'active' && Date.now() > p.gameEndTime) {
                    updateDoc(doc(fsdb, 'community_posts', key), {
                        gameStatus: 'ended',
                        gameWinner: "none",
                        locked: true
                    }).catch(e => console.error("Error failing game on timeout:", e));
                }
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
    const postRef = doc(fsdb, 'community_posts', postId);
    const snap = await getDoc(postRef);
    if (!snap.exists()) return;
    const post = snap.data();

    if (post.gameStatus !== 'active' || post.gameType !== 'challenge') return;

    const currentReacts = Object.keys(post.reactions || {}).reduce((sum, type) => sum + Object.keys(post.reactions[type] || {}).length, 0);
    const currentComments = Object.keys(post.comments || {}).length;

    if (currentReacts >= post.gameTargetReacts && currentComments >= post.gameTargetComments) {
        let isWinner = false;
        try {
            await fsRunTransaction(fsdb, async (transaction) => {
                const tSnap = await transaction.get(postRef);
                if (!tSnap.exists()) return;
                const p = tSnap.data();
                if (p.gameStatus === 'active') {
                    transaction.update(postRef, {
                        gameStatus: 'ended',
                        gameWinner: p.gameTargetUser
                    });
                    isWinner = true;
                }
            });
            if (isWinner) {
                const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
                if (lbPoints > 0) update(ref(db, `users/${post.gameTargetUser}`), { lbPoints: increment(lbPoints) });
                window.logEarnings(post.gameTargetUser, postId, window.gameTypeLabel(post.gameType), post.gamePrize, lbPoints);
                const winnerName = window.globalUsersCache[post.gameTargetUser]?.name || post.gameTargetUser;
                if (post.authorId) {
                    window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, post.gameTargetUser, winnerName);
                }
                const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
                if (hostLbReward > 0 && post.authorId) {
                    update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
                }
                window.showAlert(`Challenge completed! @${winnerName} won!`);
            }
        } catch(e) {
            console.error(e);
        }
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

window.answerGame = async (postId, answer) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    if (!answer) return window.showAlert("Please enter an answer.");

    const postRef = doc(fsdb, 'community_posts', postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

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
        await updateDoc(postRef, {
            gameStatus: 'ended',
            gameWinner: window.currentUser.uid
        });

        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : (window.siteSettings.lbPointsPerWin ?? 5);
        if (lbPoints > 0) update(ref(db, `users/${window.currentUser.uid}`), { lbPoints: increment(lbPoints) });
        window.logEarnings(window.currentUser.uid, postId, window.gameTypeLabel(post.gameType), post.gamePrize, lbPoints);
        if (post.authorId && post.authorId !== window.currentUser.uid) {
            const myAnswerName = window.globalUsersCache?.[window.currentUser.uid]?.name || 'Someone';
            window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, window.currentUser.uid, myAnswerName);
        }
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
    
    const snap = await getDoc(doc(fsdb, 'community_posts', postId));
    if (!snap.exists()) return;
    const post = snap.data();

    if (post.authorId === window.currentUser.uid) return window.showAlert("You cannot enter your own Bingo game.");
    if (post.bingoPhase !== 'submission') return window.showAlert("Submissions are now closed!");
    if (post.gameEndTime && Date.now() >= post.gameEndTime) return window.showAlert("Submission time is up!");

    // Check if already submitted
    const myEntry = post.bingoEntries && post.bingoEntries[window.currentUser.uid];
    if (myEntry) {
        return window.showAlert(`You already submitted: ${myEntry.letters.join(' ')} | ${myEntry.numbers.join(' ')}`);
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

    const postRef = doc(fsdb, 'community_posts', postId);

    try {
        // Re-check phase and deadline
        const snap = await getDoc(postRef);
        const post = snap.data();
        if (post.bingoPhase !== 'submission') return window.showAlert("Submissions are closed!");
        if (post.gameEndTime && Date.now() >= post.gameEndTime) return window.showAlert("Time's up!");

        // Check for duplicate entry key
        const dupEntry = post.bingoEntryKeys && post.bingoEntryKeys[entryKey];
        if (dupEntry) return window.showAlert("That combination is already taken! Try a different one.");

        // Check if already submitted
        const myEntry = post.bingoEntries && post.bingoEntries[window.currentUser.uid];
        if (myEntry) return window.showAlert("You already submitted an entry!");

        // Write entry and key using dot notation for map fields
        await updateDoc(postRef, {
            [`bingoEntries.${window.currentUser.uid}`]: { letters, numbers, entryKey, timestamp: Date.now() },
            [`bingoEntryKeys.${entryKey}`]: window.currentUser.uid
        });

        document.getElementById('bingo-entry-modal').classList.add('hidden');
        window.showAlert(`✅ Entry submitted: ${letters.join(' ')} | ${numbers.join(' ')}`);
    } catch(e) {
        console.error("Bingo entry error:", e);
        window.showAlert("Error submitting entry: " + e.message);
    }
};

window.closeBingoSubmissions = async (postId) => {
    await updateDoc(doc(fsdb, 'community_posts', postId), { bingoPhase: 'drawing' });
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
    const postRef = doc(fsdb, 'community_posts', postId);
    const snap = await getDoc(postRef);
    if (!snap.exists()) return;
    const post = snap.data();

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
        window.logEarnings(winnerId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, lbPoints);
        if (post.authorId) {
            const bingoWinnerName = window.globalUsersCache?.[winnerId]?.name || 'Someone';
            window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), post.gamePrize, winnerId, bingoWinnerName);
        }
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId) {
            update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
        }
    }

    await updateDoc(postRef, updates);
    window.processBingoAnimations();
};

window.processBingoAnimations = () => {
    if (!window._bingoRenderQueue) return;
    
    let isAnySpinning = false;

    window._bingoRenderQueue.forEach(q => {
        const post = q.postData;

        if (post.gameType === 'spin_names') {
            const canvas = document.getElementById(`spin-names-wheel-${post.id}`);
            if (!canvas) return;
            const joined = post.spinNamesJoined ? Object.values(post.spinNamesJoined) : [];
            const existingWinners = Array.isArray(post.spinNamesWinners) ? post.spinNamesWinners : [];
            const winnerUids = existingWinners.map(w => w.uid);
            const remaining = joined.filter(u => !winnerUids.includes(u.uid));

            const spin = post.spinNamesLastSpin;
            const isSpinActive = spin && (Date.now() - spin.startTime < 4000);

            if (isSpinActive) {
                isAnySpinning = true;
                const duration = 4000;
                const elapsed = Date.now() - spin.startTime;
                const poolBeforeSpin = [...remaining];
                const spinnerIdx = poolBeforeSpin.findIndex(p => p.name === spin.item);
                if (spinnerIdx === -1 && !remaining.some(p => p.name === spin.item)) {
                    const winnerEntry = joined.find(p => p.name === spin.item);
                    if (winnerEntry) poolBeforeSpin.push(winnerEntry);
                }
                const winnerIndex = poolBeforeSpin.findIndex(p => p.name === spin.item);
                if (winnerIndex !== -1 && poolBeforeSpin.length > 0) {
                    const sliceAngle = (2 * Math.PI) / poolBeforeSpin.length;
                    const fullRotations = 6 * 2 * Math.PI;
                    const targetAngle = -Math.PI / 2 - (winnerIndex * sliceAngle + sliceAngle / 2) + fullRotations;
                    const t = Math.min(elapsed / duration, 1);
                    const eased = 1 - Math.pow(1 - t, 3);
                    window.drawSpinNamesWheelCanvas(canvas, poolBeforeSpin, targetAngle * eased);
                } else {
                    window.drawSpinNamesWheelCanvas(canvas, remaining.length ? remaining : joined, 0);
                }
            } else {
                window.drawSpinNamesWheelCanvas(canvas, remaining.length ? remaining : joined, 0);
            }
            return;
        }

        const canvas = document.getElementById(`bingo-wheel-${post.id}`);
        if (!canvas) return;

        const calledItems = Array.isArray(post.bingoCalledItems) ? post.bingoCalledItems : [];
        const allItems = window.getBingoPool(post);
        
        const spin = post.bingoLastSpin;
        const isSpinActive = spin && (Date.now() - spin.startTime < 4000);

        const itemsToExclude = isSpinActive ? calledItems.filter(i => i !== spin.item) : calledItems;
        const pool = allItems.filter(i => !itemsToExclude.includes(i));

        if (isSpinActive) {
            isAnySpinning = true;
            const duration = 4000;
            const elapsed = Date.now() - spin.startTime;
            const winnerIndex = pool.indexOf(spin.item);
            
            if (winnerIndex !== -1) {
                const sliceAngle = (2 * Math.PI) / pool.length;
                const fullRotations = 6 * 2 * Math.PI;
                const targetAngle = -Math.PI / 2 - (winnerIndex * sliceAngle + sliceAngle / 2) + fullRotations;
                
                const t = Math.min(elapsed / duration, 1);
                const eased = 1 - Math.pow(1 - t, 3);
                const currentAngle = targetAngle * eased;

                window.drawBingoWheelCanvas(canvas, pool, currentAngle);
            } else {
                window.drawBingoWheelCanvas(canvas, pool, 0);
            }
        } else {
            window.drawBingoWheelCanvas(canvas, pool, 0);
        }
    });

    if (isAnySpinning) {
        window._bingoGlobalSpinning = true;
        requestAnimationFrame(window.processBingoAnimations);
    } else {
        if (window._bingoGlobalSpinning) {
            window._bingoGlobalSpinning = false;
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

window.resetBingoGame = async (postId) => {
    if (!postId) return;
    await updateDoc(doc(fsdb, 'community_posts', postId), {
        gameStatus: 'ended',
        gameWinner: 'none',
        bingoPhase: 'ended',
        locked: true
    });
    window.showAlert("Bingo game ended with no winner.");
};
// ===================== SPIN THE NAMES LOGIC =====================

window.joinSpinNames = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to join.");
    
    const snap = await getDoc(doc(fsdb, 'community_posts', postId));
    if (!snap.exists()) return;
    const post = snap.data();
    
    if (post.spinNamesPhase !== 'submission') return window.showAlert("Submissions are closed.");
    if (post.gameEndTime && Date.now() >= post.gameEndTime) return window.showAlert("Time's up!");

    const existingEntry = post.spinNamesJoined && post.spinNamesJoined[window.currentUser.uid];
    if (existingEntry) return window.showAlert("You have already joined this wheel!");

    await updateDoc(doc(fsdb, 'community_posts', postId), {
        [`spinNamesJoined.${window.currentUser.uid}`]: { 
            uid: window.currentUser.uid,
            name: window.globalUsersCache[window.currentUser.uid]?.name || window.currentUser.uid,
            timestamp: Date.now()
        }
    });
    window.showAlert("You have joined the wheel!");
};

window.closeSpinNames = async (postId) => {
    if (!window.currentUser) return;
    const snap = await getDoc(doc(fsdb, 'community_posts', postId));
    if (!snap.exists()) return;
    const post = snap.data();
    if (post.authorId !== window.currentUser.uid) return;
    const joined = post.spinNamesJoined ? Object.values(post.spinNamesJoined) : [];
    if (joined.length < 2) return window.showAlert('Need at least 2 players to start the draw.');
    await updateDoc(doc(fsdb, 'community_posts', postId), { spinNamesPhase: 'drawing', spinNamesWinners: [] });
};

window.startSpinNamesWheel = async (postId) => {
    if (!window.currentUser) return;
    const snap = await getDoc(doc(fsdb, 'community_posts', postId));
    if (!snap.exists()) return;
    const post = snap.data();
    
    if (!post.spinNamesJoined || Object.keys(post.spinNamesJoined).length === 0) return window.showAlert("No players have joined yet.");

    await updateDoc(doc(fsdb, 'community_posts', postId), { spinNamesPhase: 'drawing', spinNamesWinners: [] });
};

window.drawSpinNamesItem = async (postId) => {
    if (!window.currentUser) return;
    const snap = await getDoc(doc(fsdb, 'community_posts', postId));
    if (!snap.exists()) return;
    const post = snap.data();
    if (post.authorId !== window.currentUser.uid) return;
    if (post.spinNamesPhase !== 'drawing') return;

    const btn = document.getElementById(`spin-names-btn-${postId}`);
    if (btn) btn.disabled = true;

    const joined = post.spinNamesJoined 
        ? Object.entries(post.spinNamesJoined).map(([uid, data]) => ({ ...data, uid: data.uid || uid }))
        : [];
    const existingWinners = Array.isArray(post.spinNamesWinners) ? post.spinNamesWinners : [];
    const winnerUids = existingWinners.map(w => w.uid);

    // Players still in the wheel (remove previous winners)
    const remaining = joined.filter(u => !winnerUids.includes(u.uid));
    if (!remaining.length) return window.showAlert('No remaining players.');

    // Pick a random player from remaining
    const winner = remaining[Math.floor(Math.random() * remaining.length)];

    // Which spin is this?
    const prizes = Array.isArray(post.spinNamesPrizes) ? post.spinNamesPrizes : [];
    const currentSpinNumber = existingWinners.length + 1;
    const matchingPrize = prizes.find(p => p.target === currentSpinNumber);

    const updates = {
        spinNamesLastSpin: { item: winner.name, startTime: Date.now() }
    };

    // If this spin number is a winning spin, record the winner
    if (matchingPrize) {
        const newWinners = [...existingWinners, {
            uid: winner.uid,
            name: winner.name,
            prize: matchingPrize.prize,
            target: currentSpinNumber
        }];
        updates.spinNamesWinners = newWinners;

        // Award LB points if any (split from post gameLbPoints across winners, or just award per win)
        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 0;
        if (lbPoints > 0) {
            update(ref(db, `users/${winner.uid}`), { lbPoints: increment(lbPoints) });
        }
        window.logEarnings(winner.uid, postId, `Spin the Names (#${currentSpinNumber})`, matchingPrize.prize, lbPoints);
        if (post.authorId) {
            window.logHostedGame(post.authorId, postId, `Spin the Names (#${currentSpinNumber})`, matchingPrize.prize, winner.uid, winner.name);
        }


        // Check if all prizes have been awarded
        if (newWinners.length >= prizes.length) {
            updates.spinNamesPhase = 'ended';
            updates.gameStatus = 'ended';
            updates.gameWinner = winner.uid;
            updates.locked = true;
            const hostLbReward = window.siteSettings?.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId) {
                update(ref(db, `users/${post.authorId}`), { lbPoints: increment(hostLbReward) });
            }
        }
    }

    await updateDoc(doc(fsdb, 'community_posts', postId), updates);
};

// ===================== SPIN NAMES CANVAS DRAWING =====================

window.drawSpinNamesWheelCanvas = (canvas, players, angle) => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!players.length) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#6B7280';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No players!', canvas.width / 2, canvas.height / 2);
        return;
    }

    const SPIN_COLORS = [
        '#6366F1','#8B5CF6','#EC4899','#06B6D4','#10B981',
        '#F59E0B','#EF4444','#3B82F6','#14B8A6','#F97316'
    ];

    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2, r = W / 2 - 4;
    const sliceAngle = (2 * Math.PI) / players.length;

    ctx.clearRect(0, 0, W, H);

    players.forEach((player, i) => {
        const startAngle = angle + i * sliceAngle;
        const endAngle = startAngle + sliceAngle;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, startAngle, endAngle);
        ctx.closePath();
        ctx.fillStyle = SPIN_COLORS[i % SPIN_COLORS.length];
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(startAngle + sliceAngle / 2);
        ctx.textAlign = 'right';
        ctx.fillStyle = 'white';
        const fontSize = players.length > 12 ? 8 : players.length > 7 ? 10 : 12;
        ctx.font = `bold ${fontSize}px sans-serif`;
        // Truncate name to fit
        const displayName = player.name.length > 10 ? player.name.substring(0, 9) + '…' : player.name;
        ctx.fillText(displayName, r - 4, 4);
        ctx.restore();
    });

    // Center hub
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, 2 * Math.PI);
    ctx.fillStyle = '#1E293B';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
};
