import { db, fsdb, fsdb2, getPostDocRef, getFirestoreForPost, getRoundRobinFsdb, getFirestoreBySource } from "./firebase-config.js";
import { ref, update, set, push, get, increment, runTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";
import { collection, doc, addDoc, getDoc, updateDoc, deleteDoc, deleteField, serverTimestamp as fsServerTimestamp, runTransaction as fsRunTransaction } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Local "today" date string (YYYY-MM-DD) — used for the daily game-post limits (resets at 12:00 AM local time)
const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// ============================================================
// LEADERBOARD PERIOD HELPERS
// weekly = ISO year-week (Mon–Sun), monthly = YYYY-MM
// ============================================================
const pad2 = (n) => String(n).padStart(2, '0');

window.lbWeekKey = (d) => {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = date.getDay() === 0 ? 6 : date.getDay() - 1; // Mon=0 .. Sun=6
    const thursday = new Date(date);
    thursday.setDate(date.getDate() - day + 3);
    const jan1 = new Date(thursday.getFullYear(), 0, 1, 12);
    const week = Math.ceil((((thursday - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    return `${thursday.getFullYear()}-W${pad2(week)}`;
};

window.lbMonthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

window.lbPeriodKeyFor = (scope) => {
    const now = new Date();
    if (scope === 'weekly') return window.lbWeekKey(now);
    if (scope === 'monthly') return window.lbMonthKey(now);
    return '';
};

// Monday of the ISO week encoded in a key like "2026-W34"
const isoMondayOf = (key) => {
    const m = String(key || '').match(/^(\d{4})-W(\d+)$/);
    if (!m) return new Date();
    const year = +m[1], week = Math.min(+m[2], 53);
    const jan4 = new Date(year, 0, 4);
    const jan4Dow = (jan4.getDay() + 6) % 7;
    const jan4Monday = new Date(jan4);
    jan4Monday.setDate(jan4.getDate() - jan4Dow);
    const monday = new Date(jan4Monday);
    monday.setDate(jan4Monday.getDate() + (week - 1) * 7);
    return monday;
};

window.lbPeriodLabel = (scope, key) => {
    if (!key) return '';
    if (scope === 'monthly') {
        const [y, mo] = key.split('-').map(Number);
        return new Date(y, mo - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
    const mon = isoMondayOf(key);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const sameMonth = mon.getFullYear() === sun.getFullYear() && mon.getMonth() === sun.getMonth();
    const mLabel = mon.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const sLabel = sameMonth
        ? `${sun.getDate()}, ${sun.getFullYear()}`
        : `${sun.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${sun.getFullYear()}`;
    return `${mLabel} – ${sLabel}`;
};

window.shiftLbPeriod = (scope, key, delta) => {
    if (scope === 'monthly') {
        const [y, mo] = key.split('-').map(Number);
        return window.lbMonthKey(new Date(y, mo - 1 + delta, 1));
    }
    const mon = isoMondayOf(key);
    mon.setDate(mon.getDate() + delta * 7);
    return window.lbWeekKey(mon);
};

// Credit LB points to the weekly & monthly period counters.
// (Overall/all-time is the per-user users/{uid}/lbPoints counter.)
window.creditLbPeriods = (uid, pts) => {
    pts = Number(pts || 0);
    if (!uid || pts <= 0) return;
    const now = new Date();
    const curWeek = window.lbWeekKey(now);
    const curMonth = window.lbMonthKey(now);
    if (curWeek) update(ref(db, `lbWeekly/${curWeek}`), { [uid]: increment(pts) }).catch(e => console.warn('lbWeekly period credit error:', e));
    if (curMonth) update(ref(db, `lbMonthly/${curMonth}`), { [uid]: increment(pts) }).catch(e => console.warn('lbMonthly period credit error:', e));
};

// Award a host LB bonus: all-time counter + weekly/monthly period counters.
window.awardHostBonus = (hostUid, pts) => {
    pts = Number(pts || 0);
    if (!hostUid || pts <= 0) return;
    set(ref(db, `users/${hostUid}/lbPoints`), increment(pts)).catch(e => console.warn('host LB credit error:', e));
    window.creditLbPeriods(hostUid, pts);
    console.log('awardHostBonus =>', hostUid, pts, 'siteSettings.gameHostLbReward=', window.siteSettings.gameHostLbReward);
};

window.logEarnings = (uid, postId, title, prize, lbPoints) => {
    if (!uid) return;
    const payload = {
        postId: postId || '',
        title: title || 'Game Reward',
        prize: prize || '',
        lbPoints: lbPoints || 0,
        timestamp: Date.now()
    };
    push(ref(db, `earnings/${uid}`), payload).catch(e => console.warn('earnings write error:', e));

    // Credit the weekly & monthly period counters (all-time totals live on users/{uid}/lbPoints).
    window.creditLbPeriods(uid, lbPoints);
};

window.logHostedGame = (hostUid, postId, title, prize, winnerUid, winnerName) => {
    if (!hostUid) return;
    const payload = {
        postId: postId || '',
        title: title || 'Game',
        prize: prize || '',
        winnerUid: winnerUid || '',
        winnerName: winnerName || '',
        paymentStatus: 'pending',
        timestamp: Date.now()
    };
    push(ref(db, `hostedGames/${hostUid}`), payload).catch(e => console.warn('hostedGames write error:', e));
};

window.formatPrizeForLog = (prize, bonus) => {
    const parts = [];
    const num = (prize !== null && prize !== undefined && prize !== '') ? (typeof prize === 'number' ? prize : parseFloat(String(prize).replace(/^PHP\s*/i, ''))) : 0;
    if (!isNaN(num) && num > 0) {
        parts.push(`PHP ${num}`);
    } else if (typeof prize === 'string' && prize.trim() && prize.trim() !== '0') {
        parts.push(prize.trim().toUpperCase().startsWith('PHP') ? prize.trim() : `PHP ${prize.trim()}`);
    }
    if (bonus && typeof bonus === 'string' && bonus.trim()) {
        parts.push(`Bonus: ${bonus.trim()}`);
    }
    return parts.join(' + ') || (typeof prize === 'string' && prize ? prize : '');
};

// ============================================================
// EMOJI RIDDLE PRESETS DATASET & HELPERS
// ============================================================
const DEFAULT_EMOJI_RIDDLES = {
    movies: [
        { emojis: '🤡🐠🌊', answer: 'Finding Nemo' },
        { emojis: '🦁👑🌅', answer: 'The Lion King' },
        { emojis: '🚢❄️💔', answer: 'Titanic' },
        { emojis: '🧙‍♂️💍🌋', answer: 'The Lord of the Rings' },
        { emojis: '🕷️🧑🕸️', answer: 'Spider-Man' },
        { emojis: '⚡👦🪄🚂', answer: 'Harry Potter' },
        { emojis: '🦖🏝️🚙', answer: 'Jurassic Park' },
        { emojis: '🍫🏭🎫', answer: 'Charlie and the Chocolate Factory' },
        { emojis: '👻🚫🔫', answer: 'Ghostbusters' },
        { emojis: '🏠🎈👴👦', answer: 'Up' },
        { emojis: '🐀👨‍🍳🍲', answer: 'Ratatouille' },
        { emojis: '🏎️💨😡', answer: 'Fast and Furious' },
        { emojis: '🪓🚪😱', answer: 'The Shining' },
        { emojis: '🤖🕶️🏍️', answer: 'The Terminator' },
        { emojis: '🦇🦸‍♂️🌃', answer: 'Batman' },
        { emojis: '👽🚲🌕', answer: 'E.T.' },
        { emojis: '🪞❄️👸⛄', answer: 'Frozen' },
        { emojis: '🏴‍☠️🦜⚔️🪙', answer: 'Pirates of the Caribbean' },
        { emojis: '👠🏰🕛🎃', answer: 'Cinderella' },
        { emojis: '🐼🥋🥢🥟', answer: 'Kung Fu Panda' }
    ],
    songs: [
        { emojis: '👁️🐯🥊', answer: 'Eye of the Tiger' },
        { emojis: '🌧️☔💃', answer: 'Singing in the Rain' },
        { emojis: '💎🌌✨', answer: 'Diamonds in the Sky' },
        { emojis: '👑🐝💃', answer: 'Queen Bee' },
        { emojis: '🧊🧊👶', answer: 'Ice Ice Baby' },
        { emojis: '💃🕺🪩🌙', answer: 'Dancing Queen' },
        { emojis: '🌊🏖️☀️🍹', answer: 'Cake by the Ocean' },
        { emojis: '🚀👨🌌', answer: 'Rocket Man' },
        { emojis: '🔥🌧️❤️', answer: 'Set Fire to the Rain' },
        { emojis: '🚗🛣️🏎️💨', answer: 'Life is a Highway' },
        { emojis: '🎸⭐🎵', answer: 'Rockstar' },
        { emojis: '💔🏨🛎️', answer: 'Heartbreak Hotel' },
        { emojis: '🌊🐎🤠', answer: 'Old Town Road' },
        { emojis: '🎂🍫🍬🍭', answer: 'Sugar' },
        { emojis: '🌧️🌧️☔', answer: 'Umbrella' },
        { emojis: '👑🦁🎶', answer: 'Roar' }
    ],
    idioms: [
        { emojis: '🌧️🐱🐶', answer: 'Raining Cats and Dogs' },
        { emojis: '🫘🥫🗣️', answer: 'Spill the Beans' },
        { emojis: '🍰✨👌', answer: 'Piece of Cake' },
        { emojis: '🪓🧊🤝', answer: 'Break the Ice' },
        { emojis: '🐱👜🙊', answer: 'Let the Cat out of the Bag' },
        { emojis: '⏰✈️💨', answer: 'Time Flies' },
        { emojis: '🦷👄🤐', answer: 'Bite Your Tongue' },
        { emojis: '🍎👁️❤️', answer: 'Apple of My Eye' },
        { emojis: '🥚🧺⚠️', answer: "Don't Put All Your Eggs in One Basket" },
        { emojis: '🦵🍗🤣', answer: 'Pulling My Leg' },
        { emojis: '🐷🪽☁️', answer: 'When Pigs Fly' },
        { emojis: '❄️⚽🏔️', answer: 'Snowball Effect' },
        { emojis: '🪙🪙💭', answer: 'A Penny for Your Thoughts' },
        { emojis: '👂🌽👂', answer: 'All Ears' },
        { emojis: '🔥🧊🏃‍♂️', answer: 'Cold Feet' },
        { emojis: '🕊️🪨🪨', answer: 'Kill Two Birds with One Stone' }
    ]
};

window.emojiRiddlesData = { ...DEFAULT_EMOJI_RIDDLES };

// Attempt to fetch custom or expanded JSON file if available
(async function loadEmojiRiddlesJSON() {
    try {
        const res = await fetch('config/emoji_riddles.json');
        if (res.ok) {
            const parsed = await res.json();
            if (parsed && typeof parsed === 'object') {
                window.emojiRiddlesData = parsed;
                if (typeof window.updateEmojiRiddlePresetsUI === 'function') {
                    window.updateEmojiRiddlePresetsUI();
                }
            }
        }
    } catch(e) {
        console.debug('Using bundled emoji riddles presets');
    }
})();

window.updateEmojiRiddlePresetsUI = () => {
    const catSelect = document.getElementById('game-emoji-riddle-category');
    const presetBox = document.getElementById('game-emoji-riddle-preset-box');
    const presetSelect = document.getElementById('game-emoji-riddle-preset-select');
    if (!catSelect || !presetSelect) return;

    const category = catSelect.value;
    if (category === 'custom') {
        if (presetBox) presetBox.classList.add('hidden');
        return;
    }

    if (presetBox) presetBox.classList.remove('hidden');
    const items = window.emojiRiddlesData?.[category] || [];
    
    presetSelect.innerHTML = `<option value="">-- Pick a Preset or Type Custom Below (${items.length} available) --</option>`;
    items.forEach((item, index) => {
        presetSelect.innerHTML += `<option value="${index}">${item.emojis} — ${item.answer}</option>`;
    });
};

window.onEmojiRiddlePresetSelected = (indexStr) => {
    if (indexStr === '') return;
    const idx = parseInt(indexStr, 10);
    const catSelect = document.getElementById('game-emoji-riddle-category');
    if (!catSelect) return;
    const category = catSelect.value;
    const items = window.emojiRiddlesData?.[category] || [];
    const chosen = items[idx];
    if (!chosen) return;

    const emojiInput = document.getElementById('game-emoji-riddle-emojis');
    const ansInput = document.getElementById('game-emoji-riddle-answer');
    if (emojiInput) emojiInput.value = chosen.emojis;
    if (ansInput) ansInput.value = chosen.answer;
};

window.pickRandomEmojiRiddlePreset = () => {
    const catSelect = document.getElementById('game-emoji-riddle-category');
    if (!catSelect) return;
    let category = catSelect.value;
    if (category === 'custom') {
        catSelect.value = 'movies';
        category = 'movies';
        window.updateEmojiRiddlePresetsUI();
    }
    const items = window.emojiRiddlesData?.[category] || [];
    if (!items || items.length === 0) return;

    const randomIdx = Math.floor(Math.random() * items.length);
    const presetSelect = document.getElementById('game-emoji-riddle-preset-select');
    if (presetSelect) presetSelect.value = String(randomIdx);
    window.onEmojiRiddlePresetSelected(String(randomIdx));
};

window.gameTypeLabel = (type) => {
    const labels = {
        'math': 'Math Challenge',
        'trivia': 'Trivia Game',
        'jumbled_words': 'Jumbled Words',
        'flags': 'Guess the Flag',
        'periodic_table': 'Periodic Table of Elements',
        'guess_emoji': 'Guess the Emoji',
        'bring_me_emoji': 'Bring Me the Emoji',
        'first_to_mine': 'First to Mine',
        'last_comment': 'Last Comment',
        'challenge': 'Challenge',
        'quick_challenge': 'Quick Challenge',
        'count_dots': 'Count the Dots',
        'tictactoe': 'Tic Tac Toe',
        'four_in_a_row': '4 in a Row (7x7)',
        'drop_four': 'Connect 4',
        'hangman': 'Hangman',
        'gibberish': 'Guess the Gibberish',
        'emoji_riddle': 'Emoji Riddle',
        'bingo': 'Bingo',
        'spin_names': 'Spin the Names',
        'ncl': 'NCL Reward'
    };
    return labels[type] || type;
};

// ============================================================
// FLAGS, EMOJIS & ELEMENTS DATA — loaded from config JSON files
// ============================================================
window.flagsData = [];
window.emojisData = [];
window.elementsData = [];

(async function loadFlagsJSON() {
    try {
        const res = await fetch('config/flags.json');
        if (res.ok) {
            const parsed = await res.json();
            if (Array.isArray(parsed) && parsed.length > 0) window.flagsData = parsed;
        }
    } catch(e) { console.debug('Could not load config/flags.json'); }
})();

(async function loadEmojisJSON() {
    try {
        const res = await fetch('config/emojis.json');
        if (res.ok) {
            const parsed = await res.json();
            if (Array.isArray(parsed) && parsed.length > 0) window.emojisData = parsed;
        }
    } catch(e) { console.debug('Could not load config/emojis.json'); }
})();

(async function loadElementsJSON() {
    try {
        const res = await fetch('config/elements.json');
        if (res.ok) {
            const parsed = await res.json();
            if (Array.isArray(parsed) && parsed.length > 0) {
                window.elementsData = parsed;
                const elementDatalist = document.getElementById('game-element-datalist');
                if (elementDatalist) {
                    elementDatalist.innerHTML = parsed.map(el => `<option value="[${el.number}] ${el.symbol} - ${el.name}" label="[${el.number}] ${el.symbol} - ${el.name}"></option>`).join('');
                }
            }
        }
    } catch(e) { console.debug('Could not load config/elements.json'); }
})();

window.updateElementHint = () => {
    const mode = document.getElementById('game-element-mode')?.value || 'name';
    const hintEl = document.getElementById('game-element-hint');
    if (hintEl) {
        hintEl.innerText = mode === 'name' 
            ? 'Players will see the Chemical Symbol & Atomic Number and guess the Element Name.' 
            : 'Players will see the Element Name & Atomic Number and guess the Chemical Symbol.';
    }
};

window.pickRandomElement = () => {
    const list = window.elementsData || [];
    if (list.length === 0) return;
    const el = list[Math.floor(Math.random() * list.length)];
    const input = document.getElementById('game-element-input');
    if (input) {
        input.value = `[${el.number}] ${el.symbol} - ${el.name}`;
    }
};

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

window.updateGameLimitIndicator = async () => {
    const indicator = document.getElementById('game-limit-indicator');
    const textEl = document.getElementById('game-limit-indicator-text');
    if (!indicator || !textEl) return;
    const hide = () => indicator.classList.add('hidden');
    if (!window.currentUser) return hide();
    const type = document.getElementById('game-type')?.value;
    if (!type) return hide();
    const limits = window.siteSettings.gameLimits || {};
    const limit = Number(limits[type]);
    if (!(limit > 0)) return hide();
    try {
        const counterRef = ref(db, `gamePostCounts/${todayStr()}/${window.currentUser.uid}/${type}`);
        const snap = await get(counterRef);
        const used = snap.exists() ? Number(snap.val()) : 0;
        const gameLabel = window.gameTypeLabel(type);
        if (used >= limit) {
            textEl.innerHTML = `<i class="fa-solid fa-circle-exclamation mr-1"></i>Daily limit reached — <strong>${used}/${limit}</strong> "${gameLabel}" posts used today. Resets at 12:00 AM.`;
        } else {
            textEl.innerHTML = `<i class="fa-solid fa-circle-check mr-1"></i><strong>${limit - used}</strong> of <strong>${limit}</strong> "${gameLabel}" posts left today. Resets at 12:00 AM.`;
        }
        indicator.classList.remove('hidden');
    } catch (err) {
        console.warn("Could not load game limit indicator:", err);
        hide();
    }
};

window.openPostGameModal = () => {
    if (!window.currentUser) return window.showAlert("Please sign in to host a game.");
    document.getElementById('game-modal').classList.remove('hidden');
    
    // Reset form
    document.getElementById('game-prize').value = '';
    const bonusPrizeEl = document.getElementById('game-bonus-prize');
    if (bonusPrizeEl) bonusPrizeEl.value = '';
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
    document.getElementById('game-dots-count').value = '13';
    document.getElementById('game-dots-preview').value = '';
    document.getElementById('game-dots-scrambled').value = '';
    document.getElementById('game-hangman-word').value = '';
    const cluesInput = document.getElementById('game-hangman-clues');
    if (cluesInput) cluesInput.value = '';
    const tttGridSelect = document.getElementById('game-tictactoe-grid-size');
    if (tttGridSelect) tttGridSelect.value = '3';
    const gibberishClue = document.getElementById('game-gibberish-clue');
    if (gibberishClue) gibberishClue.value = '';
    const gibberishAns = document.getElementById('game-gibberish-answer');
    if (gibberishAns) gibberishAns.value = '';
    const riddleCat = document.getElementById('game-emoji-riddle-category');
    if (riddleCat) riddleCat.value = 'movies';
    const riddleEmojis = document.getElementById('game-emoji-riddle-emojis');
    if (riddleEmojis) riddleEmojis.value = '';
    const riddleAns = document.getElementById('game-emoji-riddle-answer');
    if (riddleAns) riddleAns.value = '';
    if (typeof window.updateEmojiRiddlePresetsUI === 'function') {
        window.updateEmojiRiddlePresetsUI();
    }
    const elemMode = document.getElementById('game-element-mode');
    if (elemMode) elemMode.value = 'name';
    const elemInput = document.getElementById('game-element-input');
    if (elemInput) elemInput.value = '';
    window.updateElementHint();
    const fourPlayersSelect = document.getElementById('game-four-players-count');
    if (fourPlayersSelect) fourPlayersSelect.value = '2';
    const dropFourPlayersSelect = document.getElementById('game-drop-four-players-count');
    if (dropFourPlayersSelect) dropFourPlayersSelect.value = '2';

    const spinCountSelect = document.getElementById('game-spin-names-count');
    if (spinCountSelect) spinCountSelect.value = '1';
    for (let i = 1; i <= 3; i++) {
        const targetInp = document.getElementById(`spin-target-${i}`);
        if (targetInp) targetInp.value = i === 1 ? '1' : (i === 2 ? '2' : '3');
        const prizeInp = document.getElementById(`spin-prize-${i}`);
        if (prizeInp) prizeInp.value = '';
        const lbInp = document.getElementById(`spin-lb-${i}`);
        if (lbInp) lbInp.value = '';
    }
    if (typeof window.toggleSpinNamesWinners === 'function') {
        window.toggleSpinNamesWinners();
    }

    document.getElementById('game-type').value = 'first_to_mine';
    
    const maxLb = window.siteSettings.maxLbPointsPrize ?? 5;
    document.getElementById('game-lb-points').max = maxLb;
    document.getElementById('game-lb-points-label').innerText = `🏆 LB Points (Max ${maxLb})`;

    for (let i = 1; i <= 3; i++) {
        const lbInp = document.getElementById(`spin-lb-${i}`);
        if (lbInp) lbInp.max = maxLb;
        const lbLbl = document.getElementById(`spin-lb-label-${i}`);
        if (lbLbl) lbLbl.innerText = `🏆 LB (Max ${maxLb})`;
    }

    const prizeLabel = document.getElementById('game-prize-label');
    if(prizeLabel) prizeLabel.innerText = `🎁 Prize (PHP)`;

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
    emojiDatalist.innerHTML = window.emojisData.map(e => `<option value="${e}"></option>`).join('');

    // Populate Flag Datalist
    const flagDatalist = document.getElementById('game-flag-datalist');
    flagDatalist.innerHTML = window.flagsData.map(f => `<option value="${f.name}" label="[${f.code.toUpperCase()}] ${f.name}"></option>`).join('');

    // Populate Element Datalist
    const elementDatalist = document.getElementById('game-element-datalist');
    if (elementDatalist) {
        elementDatalist.innerHTML = (window.elementsData || []).map(el => `<option value="[${el.number}] ${el.symbol} - ${el.name}" label="[${el.number}] ${el.symbol} - ${el.name}"></option>`).join('');
    }

    window.toggleGameSettings();
    window.updateGameLimitIndicator();
};

window.closePostGameModal = () => {
    document.getElementById('game-modal').classList.add('hidden');
};

window.generateDotsPuzzle = () => {
    const countInput = document.getElementById('game-dots-count');
    let count = parseInt(countInput.value, 10);
    if (isNaN(count) || count < 1) count = 13;
    if (count > 100) count = 100;
    countInput.value = count;

    const distractors = ['○', '▲', '■', '◆', '★', '✖', '✦', '✚', '▼', '◇', '⬟', '✳', '❖', '◈', '▫', '◽', '△', '▷', '◁', '⬢'];
    const dotChar = '●';

    const totalChars = Math.max(count + 24, Math.min(count * 4, 98));
    const distractorCount = totalChars - count;

    const items = [];
    for (let i = 0; i < count; i++) items.push(dotChar);
    for (let i = 0; i < distractorCount; i++) {
        items.push(distractors[Math.floor(Math.random() * distractors.length)]);
    }

    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }

    const cols = 14;
    const rows = [];
    for (let i = 0; i < items.length; i += cols) {
        rows.push(items.slice(i, i + cols).join(' '));
    }
    const puzzle = rows.join('\n');

    document.getElementById('game-dots-preview').value = puzzle;
    document.getElementById('game-dots-scrambled').value = puzzle;
};

window.toggleGameSettings = () => {
    const type = document.getElementById('game-type').value;
    const settingsDiv = document.getElementById('last-comment-settings');
    const targetUserContainer = document.getElementById('game-target-user-container');
    const emojiNameContainer = document.getElementById('game-emoji-name-container');
    const challengeTargets = document.getElementById('game-challenge-targets');
    const flagContainer = document.getElementById('game-flag-container');
    const periodicTableContainer = document.getElementById('game-periodic-table-container');
    const mathContainer = document.getElementById('game-math-container');
    const jumbledContainer = document.getElementById('game-jumbled-container');
    const triviaContainer = document.getElementById('game-trivia-container');
    const bingoContainer = document.getElementById('game-bingo-container');
    const spinNamesContainer = document.getElementById('game-spin-names-container');
    const nclContainer = document.getElementById('game-ncl-container');
    const countDotsContainer = document.getElementById('game-count-dots-container');
    const tictactoeContainer = document.getElementById('game-tictactoe-container');
    const fourInARowContainer = document.getElementById('game-four-in-a-row-container');
    const dropFourContainer = document.getElementById('game-drop-four-container');
    const hangmanContainer = document.getElementById('game-hangman-container');
    const gibberishContainer = document.getElementById('game-gibberish-container');
    const emojiRiddleContainer = document.getElementById('game-emoji-riddle-container');
    const defaultRewardsContainer = document.getElementById('game-default-rewards-container');
    
    // Default rewards container (Prize PHP, LB Points, Bonus prize)
    if (defaultRewardsContainer) {
        if (type === 'spin_names') {
            defaultRewardsContainer.classList.add('hidden');
        } else {
            defaultRewardsContainer.classList.remove('hidden');
        }
    }

    // Timer setting is shown for last_comment, challenge, quick_challenge, math, trivia, bingo, spin_names, count_dots, hangman, gibberish, emoji_riddle, periodic_table
    if (['last_comment', 'challenge', 'quick_challenge', 'math', 'trivia', 'bingo', 'spin_names', 'count_dots', 'hangman', 'gibberish', 'emoji_riddle', 'periodic_table'].includes(type)) {
        settingsDiv.classList.remove('hidden');
        window.toggleTimerSettings();
    } else {
        settingsDiv.classList.add('hidden');
    }

    if (type === 'challenge' || type === 'quick_challenge' || type === 'ncl' || type === 'tictactoe' || type === 'four_in_a_row' || type === 'drop_four') targetUserContainer.classList.remove('hidden');
    else targetUserContainer.classList.add('hidden');

    if (type === 'challenge') challengeTargets.classList.remove('hidden');
    else challengeTargets.classList.add('hidden');

    if (type === 'guess_emoji' || type === 'bring_me_emoji') emojiNameContainer.classList.remove('hidden');
    else emojiNameContainer.classList.add('hidden');

    if (type === 'flags') flagContainer.classList.remove('hidden');
    else flagContainer.classList.add('hidden');

    if (type === 'periodic_table') {
        if (periodicTableContainer) periodicTableContainer.classList.remove('hidden');
    } else {
        if (periodicTableContainer) periodicTableContainer.classList.add('hidden');
    }

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

    if (type === 'count_dots') {
        countDotsContainer.classList.remove('hidden');
    } else {
        countDotsContainer.classList.add('hidden');
    }

    if (type === 'tictactoe') tictactoeContainer.classList.remove('hidden');
    else tictactoeContainer.classList.add('hidden');

    if (type === 'four_in_a_row') {
        if (fourInARowContainer) fourInARowContainer.classList.remove('hidden');
    } else {
        if (fourInARowContainer) fourInARowContainer.classList.add('hidden');
    }

    if (type === 'drop_four') {
        if (dropFourContainer) dropFourContainer.classList.remove('hidden');
    } else {
        if (dropFourContainer) dropFourContainer.classList.add('hidden');
    }

    if (type === 'hangman') hangmanContainer.classList.remove('hidden');
    else hangmanContainer.classList.add('hidden');

    if (type === 'gibberish') {
        if (gibberishContainer) gibberishContainer.classList.remove('hidden');
    } else {
        if (gibberishContainer) gibberishContainer.classList.add('hidden');
    }

    if (type === 'emoji_riddle') {
        if (emojiRiddleContainer) emojiRiddleContainer.classList.remove('hidden');
        if (typeof window.updateEmojiRiddlePresetsUI === 'function') {
            window.updateEmojiRiddlePresetsUI();
        }
    } else {
        if (emojiRiddleContainer) emojiRiddleContainer.classList.add('hidden');
    }

    // Hide LB Points field for NCL (disabled for now)
    const lbPointsLabel = document.getElementById('game-lb-points-label');
    const lbPointsInput = document.getElementById('game-lb-points');
    if (type === 'ncl') {
        if (lbPointsLabel) lbPointsLabel.closest('div').classList.add('hidden');
        if (lbPointsInput) lbPointsInput.value = '0';
    } else {
        if (lbPointsLabel) lbPointsLabel.closest('div').classList.remove('hidden');
    }

    // Refresh the daily limit indicator for the newly selected game type
    if (typeof window.updateGameLimitIndicator === 'function') window.updateGameLimitIndicator();
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

    // Site Control: block game posting for non-admins while posts are paused
    if (window.checkSitePaused && window.checkSitePaused('post')) return;

    const type = document.getElementById('game-type').value;

    // ============================================================
    // DAILY GAME POST LIMIT — per user per day, resets at 12:00 AM.
    // Configured in /config (stored in settings/gameLimits).
    // Enforced atomically AFTER post creation via an RTDB counter:
    // gamePostCounts/{YYYY-MM-DD}/{uid}/{gameType}.
    // ============================================================
    const gameTypeLimits = window.siteSettings.gameLimits || {};
    const typeLimit = Number(gameTypeLimits[type]);

    const rawPrize = document.getElementById('game-prize').value.trim();
    const bonusPrize = document.getElementById('game-bonus-prize') ? document.getElementById('game-bonus-prize').value.trim() : '';

    let prize = 0;
    if (rawPrize !== '') {
        const num = parseFloat(rawPrize);
        if (isNaN(num) || num < 0) {
            return window.showAlert("Please enter a valid numeric prize amount (e.g. 50, 100).");
        }
        prize = num;
    }

    const maxLbAllowed = window.siteSettings.maxLbPointsPrize ?? 5;
    const lbPointsReward = parseInt(document.getElementById('game-lb-points').value) || 0;
    if (lbPointsReward < 0 || lbPointsReward > maxLbAllowed) {
        return window.showAlert(`LB Points reward must be between 0 and ${maxLbAllowed}.`);
    }

    // Require at least prize, bonus, or lb points for non-spin_names games
    if (type !== 'spin_names' && prize <= 0 && !bonusPrize && lbPointsReward <= 0) {
        return window.showAlert("Please enter a prize amount (PHP), bonus prize, or LB points.");
    }

    // Cooldown gate (settings.postCooldownSec)
    if (!(await window.checkActionCooldown('post'))) return;

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
    let dotsCount = 0;
    let dotsScrambled = null;
    let hangmanWord = null;
    let hangmanClueLetters = [];
    let tictactoeGridSize = 3;
    let gibberishClue = null;
    let gibberishAnswer = null;
    let emojiRiddleCategory = 'movies';
    let emojiRiddleEmojis = null;
    let emojiRiddleAnswer = null;
    let elementNumber = null;
    let elementSymbol = null;
    let elementName = null;
    let elementGuessMode = 'name';
    let elementAnswer = null;
    let elementClue = null;
    let fourPlayerCount = 2;
    let dropFourPlayerCount = 2;

    if (type === 'challenge' || type === 'quick_challenge' || type === 'ncl' || ((type === 'tictactoe' || type === 'four_in_a_row' || type === 'drop_four') && document.getElementById('game-target-user').value.trim())) {
        const targetNameInput = document.getElementById('game-target-user').value.trim();
        if (targetNameInput) {
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
        } else if (type === 'challenge' || type === 'quick_challenge' || type === 'ncl') {
            return window.showAlert("Please search and select a target user.");
        }
    }

    if (type === 'tictactoe') {
        tictactoeGridSize = parseInt(document.getElementById('game-tictactoe-grid-size')?.value) || 3;
    }

    if (type === 'four_in_a_row') {
        fourPlayerCount = parseInt(document.getElementById('game-four-players-count')?.value, 10) || 2;
    }

    if (type === 'drop_four') {
        dropFourPlayerCount = parseInt(document.getElementById('game-drop-four-players-count')?.value, 10) || 2;
    }

    if (type === 'periodic_table') {
        const rawElem = (document.getElementById('game-element-input')?.value || '').trim();
        elementGuessMode = document.getElementById('game-element-mode')?.value || 'name';
        if (!rawElem) return window.showAlert("Please select or enter an Element from the Periodic Table.");

        const list = window.elementsData || [];
        let matched = list.find(el => `[${el.number}] ${el.symbol} - ${el.name}`.toLowerCase() === rawElem.toLowerCase() || el.name.toLowerCase() === rawElem.toLowerCase() || el.symbol.toLowerCase() === rawElem.toLowerCase());
        if (!matched) {
            const match = rawElem.match(/\[?(\d+)\]?\s*([A-Za-z]+)\s*[-–]\s*(.+)/i);
            if (match) {
                const num = parseInt(match[1], 10);
                matched = list.find(el => el.number === num) || { number: num, symbol: match[2], name: match[3].trim() };
            }
        }
        if (!matched) {
            return window.showAlert("Element not found. Please pick an element from the suggestions or click Random Element.");
        }
        elementNumber = matched.number;
        elementSymbol = matched.symbol;
        elementName = matched.name;

        if (elementGuessMode === 'name') {
            elementClue = `${elementSymbol} (#${elementNumber})`;
            elementAnswer = elementName;
        } else {
            elementClue = `${elementName} (#${elementNumber})`;
            elementAnswer = elementSymbol;
        }
    }

    if (type === 'challenge') {
        targetReacts = parseInt(document.getElementById('game-target-reacts').value) || 0;
        targetComments = parseInt(document.getElementById('game-target-comments').value) || 0;
        if (targetReacts === 0 && targetComments === 0) return window.showAlert("Please set a target for reacts or comments.");
    }

    if (type === 'count_dots') {
        dotsCount = parseInt(document.getElementById('game-dots-count').value) || 0;
        dotsScrambled = document.getElementById('game-dots-scrambled').value.trim() || document.getElementById('game-dots-preview').value.trim();
        if (dotsCount < 1) return window.showAlert("Please enter a valid number of dots to guess.");
        if (!dotsScrambled) {
            return window.showAlert("Please generate the puzzle first by clicking 'Generate Puzzle'.");
        }
    }

    if (type === 'hangman') {
        const rawWord = document.getElementById('game-hangman-word').value.trim().toUpperCase();
        if (!rawWord || rawWord.length < 2) return window.showAlert("Please enter a secret word (at least 2 letters).");
        if (!/^[A-Z\s]+$/.test(rawWord)) return window.showAlert("Secret word must only contain letters A-Z.");
        hangmanWord = rawWord;

        const rawClues = (document.getElementById('game-hangman-clues')?.value || '').trim().toUpperCase();
        if (rawClues) {
            const clueChars = rawClues.replace(/[^A-Z]/g, '').split('');
            const wordChars = new Set(hangmanWord.replace(/\s+/g, '').split(''));
            for (const ch of clueChars) {
                if (wordChars.has(ch) && !hangmanClueLetters.includes(ch)) {
                    hangmanClueLetters.push(ch);
                }
            }
            if (hangmanClueLetters.length > 0 && hangmanClueLetters.length >= wordChars.size) {
                return window.showAlert("You cannot reveal all letters of the secret word as clues!");
            }
        }
    }

    if (type === 'gibberish') {
        gibberishClue = document.getElementById('game-gibberish-clue')?.value.trim();
        gibberishAnswer = document.getElementById('game-gibberish-answer')?.value.trim();
        if (!gibberishClue || !gibberishAnswer) return window.showAlert("Please provide both the Gibberish clue and the Real Answer phrase.");
    }

    if (type === 'emoji_riddle') {
        emojiRiddleCategory = document.getElementById('game-emoji-riddle-category')?.value || 'movies';
        emojiRiddleEmojis = document.getElementById('game-emoji-riddle-emojis')?.value.trim();
        emojiRiddleAnswer = document.getElementById('game-emoji-riddle-answer')?.value.trim();
        if (!emojiRiddleEmojis || !emojiRiddleAnswer) return window.showAlert("Please provide both the emojis and the answer for the riddle.");
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
        const matched = window.flagsData.find(f => f.name.toLowerCase() === flagInput.toLowerCase());
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
            const prizeInput = document.getElementById(`spin-prize-${i}`)?.value.trim() || '';
            const prizeVal = prizeInput ? parseFloat(prizeInput) : 0;
            const lbInput = document.getElementById(`spin-lb-${i}`)?.value.trim() || '';
            const lbVal = lbInput ? parseInt(lbInput) : 0;

            if (!spinTarget || spinTarget < 1) return window.showAlert(`Please fill out a valid Spin # for Winner ${i}.`);
            if (prizeVal <= 0 && lbVal <= 0) return window.showAlert(`Please enter at least a Prize (PHP) or LB Points for Winner ${i}.`);
            if (lbVal < 0 || lbVal > maxLbAllowed) {
                return window.showAlert(`Winner ${i} LB Points reward must be between 0 and ${maxLbAllowed}.`);
            }

            const prizeParts = [];
            if (prizeVal > 0) prizeParts.push(`PHP ${prizeVal}`);
            if (lbVal > 0) prizeParts.push(`+${lbVal} LB Point${lbVal > 1 ? 's' : ''}`);
            const prizeFormatted = prizeParts.join(' + ');

            spinNamesPrizes.push({ 
                target: spinTarget, 
                prize: prizeFormatted, 
                prizeNum: prizeVal > 0 ? prizeVal : 0,
                lbPoints: lbVal > 0 ? lbVal : 0,
                wonBy: null 
            });
        }
    }

    if (['last_comment', 'challenge', 'quick_challenge', 'math', 'trivia', 'bingo', 'spin_names', 'count_dots', 'hangman', 'gibberish', 'emoji_riddle'].includes(type)) {
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
    else if (type === 'gibberish') text = `🗣️ Guess the Gibberish! Say it out loud: "${gibberishClue}"`;
    else if (type === 'emoji_riddle') {
        const catLabel = emojiRiddleCategory === 'movies' ? 'Movie' : emojiRiddleCategory === 'songs' ? 'Song' : emojiRiddleCategory === 'idioms' ? 'Idiom' : 'Emoji Riddle';
        const icon = emojiRiddleCategory === 'movies' ? '🎬' : emojiRiddleCategory === 'songs' ? '🎵' : emojiRiddleCategory === 'idioms' ? '💬' : '✨';
        text = `${icon} Guess the ${catLabel} from these emojis: ${emojiRiddleEmojis}`;
    }
    else if (type === 'count_dots') text = `🔢 Count the Dots! How many dots (●) can you find? First correct guess wins!`;
    else if (type === 'tictactoe') text = targetUserName ? `⚔️ Tic Tac Toe (${tictactoeGridSize}x${tictactoeGridSize}) match challenge against @${targetUserName}!` : `⚔️ Open Tic Tac Toe (${tictactoeGridSize}x${tictactoeGridSize}) Challenge! First person to accept plays against @${window.currentUser.name}!`;
    else if (type === 'four_in_a_row') {
        text = targetUserName 
            ? `🔴🔵 4 in a Row (${fourPlayerCount} Players, 7x7) match challenge against @${targetUserName}!`
            : `🔴🔵 Open 4 in a Row (${fourPlayerCount} Players, 7x7) Challenge! First to connect 4 in a row wins!`;
    }
    else if (type === 'drop_four') {
        text = targetUserName 
            ? `🟡🔴 Connect 4 (7x6 Drop, ${dropFourPlayerCount} Players) match challenge against @${targetUserName}!`
            : `🟡🔴 Open Connect 4 (7x6 Drop, ${dropFourPlayerCount} Players) Challenge! Drop your pieces to connect 4!`;
    }
    else if (type === 'periodic_table') {
        text = elementGuessMode === 'name'
            ? `🧪 Periodic Table Challenge! Guess the Element Name for symbol: ${elementSymbol} (Atomic #${elementNumber})! ⚛️`
            : `🧪 Periodic Table Challenge! Guess the Chemical Symbol for: ${elementName} (Atomic #${elementNumber})! ⚛️`;
    }
    else if (type === 'hangman') text = `🪓 Hangman Game! Guess letters or guess the secret word before you get eliminated!`;
    else if (type === 'bingo') text = `🎱 Bingo! Pick your entry — ${bingoLetterCount} letter(s) (A–${bingoMaxLetter}) + ${bingoNumberCount} number(s) (1–${bingoMaxNumber}). Submission open!`;
    else if (type === 'spin_names') {
        // Build caption with spin numbers and prizes
        const prizeLines = spinNamesPrizes.map(p => `Spin #${p.target}: ${p.prize}`).join(' | ');
        text = `🎡 Spin the Names! Join for a chance to win! — ${prizeLines}`;
    }
    else if (type === 'ncl') {
        const nclPrizeFormatted = window.formatPrizeForLog(prize, bonusPrize);
        text = `ncl - ${nclPrizeFormatted ? nclPrizeFormatted + ' - ' : ''}@${targetUserName}. Congrats!! 🎉`;
    }

    const postData = {
        authorId: window.currentUser.uid,
        text: text,
        category: 'Games',
        timestamp: Date.now(),
        visibility: 'public',
        isGame: true,
        gameType: type,
        gamePrize: prize,
        gameBonusPrize: bonusPrize,
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
    if (type === 'periodic_table') {
        postData.gameElementNumber = elementNumber;
        postData.gameElementSymbol = elementSymbol;
        postData.gameElementName = elementName;
        postData.gameElementGuessMode = elementGuessMode;
        postData.gameElementClue = elementClue;
        postData.gameElementAnswer = elementAnswer;
    }
    if (mathQuestion) postData.gameMathQuestion = mathQuestion;
    if (mathAnswer) postData.gameMathAnswer = mathAnswer;
    if (jumbledOriginal) postData.gameJumbledOriginal = jumbledOriginal;
    if (jumbledScrambled) postData.gameJumbledScrambled = jumbledScrambled;
    if (triviaQuestion) postData.gameTriviaQuestion = triviaQuestion;
    if (triviaAnswer) postData.gameTriviaAnswer = triviaAnswer;
    if (type === 'gibberish') {
        postData.gameGibberishClue = gibberishClue;
        postData.gameGibberishAnswer = gibberishAnswer;
    }
    if (type === 'emoji_riddle') {
        postData.emojiRiddleCategory = emojiRiddleCategory;
        postData.emojiRiddleEmojis = emojiRiddleEmojis;
        postData.emojiRiddleAnswer = emojiRiddleAnswer;
    }
    if (type === 'count_dots') {
        postData.gameDotsCount = dotsCount;
        postData.gameDotsScrambled = dotsScrambled;
    }
    if (type === 'tictactoe') {
        postData.tictactoeGridSize = tictactoeGridSize;
        postData.tictactoeBoard = Array(tictactoeGridSize * tictactoeGridSize).fill('');
        postData.tictactoePlayerX = window.currentUser.uid;
        postData.tictactoePlayerO = targetUserUid || null;
        postData.tictactoeTurn = 'X';
        postData.tictactoeStatus = targetUserUid ? 'in_progress' : 'waiting';
        postData.tictactoeTargetUser = targetUserUid || null;
    }
    if (type === 'four_in_a_row') {
        postData.fourGridSize = 7;
        postData.fourBoard = Array(49).fill('');
        postData.fourPlayerCount = fourPlayerCount;
        postData.fourPlayerR = window.currentUser.uid;
        postData.fourPlayerB = (fourPlayerCount === 2 && targetUserUid) ? targetUserUid : null;
        postData.fourPlayerY = null;
        postData.fourTurn = 'R';
        postData.fourStatus = (fourPlayerCount === 2 && targetUserUid) ? 'in_progress' : 'waiting';
        postData.fourTargetUser = targetUserUid || null;
    }
    if (type === 'drop_four') {
        postData.dropFourCols = 7;
        postData.dropFourRows = 6;
        postData.dropFourBoard = Array(42).fill('');
        postData.dropFourPlayerCount = dropFourPlayerCount;
        postData.dropFourPlayerR = window.currentUser.uid;
        postData.dropFourPlayerY = (dropFourPlayerCount === 2 && targetUserUid) ? targetUserUid : null;
        postData.dropFourPlayerB = null;
        postData.dropFourTurn = 'R';
        postData.dropFourStatus = (dropFourPlayerCount === 2 && targetUserUid) ? 'in_progress' : 'waiting';
        postData.dropFourTargetUser = targetUserUid || null;
    }
    if (type === 'hangman') {
        postData.hangmanWord = hangmanWord;
        postData.hangmanGuessedLetters = hangmanClueLetters || [];
        postData.hangmanWrongLetters = [];
        postData.hangmanLetterWrong = {};
        postData.hangmanWordWrong = {};
    }
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

    const postBtn = document.getElementById('post-game-btn');
    const originalBtnText = postBtn ? postBtn.innerHTML : '';
    if (postBtn) {
        postBtn.disabled = true;
        postBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Posting...`;
    }

    try {
        const { fsdb: targetFs, dbSource } = getRoundRobinFsdb();
        postData._dbSource = dbSource;
        const newPostRef = await addDoc(collection(targetFs, 'community_posts'), postData);
        window._postDbMap.set(newPostRef.id, dbSource);

        // ===== Daily game limit gate (atomic RTDB counter) =====
        if (typeLimit > 0) {
            const counterRef = ref(db, `gamePostCounts/${todayStr()}/${window.currentUser.uid}/${type}`);
            let txnError = null;
            let limitReached = false;
            try {
                const txn = await runTransaction(counterRef, (current) => {
                    const count = Number(current || 0);
                    if (count >= typeLimit) return undefined; // abort → limit reached
                    return count + 1;
                });
                limitReached = !txn.committed;
            } catch (e) {
                txnError = e;
            }

            if (txnError) {
                // Counter couldn't be verified — undo the post to keep things consistent
                await deleteDoc(newPostRef).catch(() => {});
                console.warn("Daily game limit counter failed:", txnError);
                window.showAlert("Couldn't verify your daily game limit. Please try again.");
                return;
            }

            if (limitReached) {
                await deleteDoc(newPostRef).catch(() => {});
                const gameLabel = window.gameTypeLabel(type);
                window.showAlert(`❌ Daily limit reached: ${typeLimit} "${gameLabel}" game(s) allowed per day (resets at 12:00 AM).`);
                return;
            }
        }

        // For NCL: log the earning immediately since it's awarded on post creation
        if (type === 'ncl' && targetUserUid) {
            const nclPrizeFormatted = window.formatPrizeForLog(prize, bonusPrize);
            window.logEarnings(targetUserUid, newPostRef.id, 'NCL Reward', nclPrizeFormatted, lbPointsReward);
            const nclWinnerName = window.globalUsersCache?.[targetUserUid]?.name || targetUserUid;
            window.logHostedGame(window.currentUser.uid, newPostRef.id, 'NCL Reward', nclPrizeFormatted, targetUserUid, nclWinnerName);
        }

        // Close modal first — post was created successfully
        window.closePostGameModal();

        // Send notification separately so failures here don't show a fake error
        if (targetUserUid) {
            try {
                const nclPrizeFormatted = window.formatPrizeForLog(prize, bonusPrize);
                const notifRef = push(ref(db, `notifications/${targetUserUid}`));
                await set(notifRef, {
                    type: 'game_challenge',
                    fromUid: window.currentUser.uid,
                    fromName: window.currentUser.name,
                    postId: newPostRef.key,
                    timestamp: Date.now(),
                    read: false,
                    message: type === 'ncl' ? `awarded you ${nclPrizeFormatted || 'a reward'} via ncl!` : `challenged you to a game!`
                });
            } catch(notifErr) {
                console.warn('Notification write failed (non-critical):', notifErr);
            }
        }
    } catch(e) {
        console.error("Error posting game:", e);
        window.showAlert("Failed to post game.");
    } finally {
        if (postBtn) {
            postBtn.disabled = false;
            postBtn.innerHTML = originalBtnText;
        }
    }
    // Always attempt re-render after modal closes (outside try so errors above don't block)
    if (typeof window.renderProfileData === 'function') window.renderProfileData(false);
};

window.mineGame = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const postRef = getPostDocRef(postId);

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

        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
        const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
        if (lbPoints > 0) set(ref(db, `users/${window.currentUser.uid}/lbPoints`), increment(lbPoints));
        window.logEarnings(window.currentUser.uid, postId, window.gameTypeLabel(post.gameType), prizeLogged, lbPoints);
        if (post.authorId && post.authorId !== window.currentUser.uid) {
            const myName = window.globalUsersCache?.[window.currentUser.uid]?.name || 'Someone';
            window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), prizeLogged, window.currentUser.uid, myName);
        }
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId && post.authorId !== window.currentUser.uid) {
            window.awardHostBonus(post.authorId, hostLbReward);
        }
        let winMsg = `You won!`;
        if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
        if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
        window.showAlert(winMsg);
    } catch(e) {
        console.error("Mine error:", e);
        window.showAlert("Error playing game: " + e.message);
    }
};

window.endLastCommentGame = async (postId) => {
    if (!window.currentUser) return;
    
    try {
        const localPost = (window.allPosts || []).find(p => p.id === postId);
        if (localPost && localPost.gameStatus !== 'active') return;
        
        // Update gameStatus to evaluating to lock out further entries
        await updateDoc(getPostDocRef(postId), {
            gameStatus: 'evaluating',
            locked: true
        });

        // Wait 1.5 seconds for any last-millisecond comments to settle
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Single read to evaluate the final winner
        const snap = await getDoc(getPostDocRef(postId));
        const post = snap.data();
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

        await updateDoc(getPostDocRef(postId), {
            gameStatus: 'ended',
            gameWinner: lastCommenterId || "none"
        });

        if (lastCommenterId) {
            const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
            const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
            if (lbPoints > 0) set(ref(db, `users/${lastCommenterId}/lbPoints`), increment(lbPoints));
            window.logEarnings(lastCommenterId, postId, window.gameTypeLabel(post.gameType), prizeLogged, lbPoints);
            if (post.authorId) {
                const lcWinnerName = window.globalUsersCache?.[lastCommenterId]?.name || 'Someone';
                window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), prizeLogged, lastCommenterId, lcWinnerName);
            }
            // Reward host only if someone actually won
            const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId) {
                window.awardHostBonus(post.authorId, hostLbReward);
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
                    updateDoc(getPostDocRef(key), {
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
    const postRef = getPostDocRef(postId);
    const snap = await getDoc(postRef);
    if (!snap.exists()) return;
    const post = snap.data();

    if (post.gameStatus !== 'active' || post.gameType !== 'challenge') return;

    const currentReacts = Object.keys(post.reactions || {}).reduce((sum, type) => sum + Object.keys(post.reactions[type] || {}).length, 0);
    const currentComments = Object.keys(post.comments || {}).length;

    if (currentReacts >= post.gameTargetReacts && currentComments >= post.gameTargetComments) {
        let isWinner = false;
        try {
            await fsRunTransaction(getFirestoreForPost(postId), async (transaction) => {
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
                const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
                const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
                if (lbPoints > 0) set(ref(db, `users/${post.gameTargetUser}/lbPoints`), increment(lbPoints));
                window.logEarnings(post.gameTargetUser, postId, window.gameTypeLabel(post.gameType), prizeLogged, lbPoints);
                const winnerName = window.globalUsersCache[post.gameTargetUser]?.name || post.gameTargetUser;
                if (post.authorId) {
                    window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), prizeLogged, post.gameTargetUser, winnerName);
                }
                const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
                if (hostLbReward > 0 && post.authorId) {
                    window.awardHostBonus(post.authorId, hostLbReward);
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

window.openAnswerModal = (postId, customTitle = null, customPlaceholder = null) => {
    if (!window.currentUser) return window.showAlert("Please sign in to answer.");
    document.getElementById('game-answer-postid').value = postId;
    document.getElementById('game-answer-input').value = '';
    const titleEl = document.getElementById('game-answer-title');
    const labelEl = document.getElementById('game-answer-label');
    const inputEl = document.getElementById('game-answer-input');
    if (customTitle && titleEl) titleEl.innerHTML = `<i class="fa-solid fa-keyboard mr-2"></i>${customTitle}`;
    else if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-keyboard mr-2"></i>Submit Answer`;
    if (customPlaceholder && inputEl) inputEl.placeholder = customPlaceholder;
    else if (inputEl) inputEl.placeholder = "Enter your answer";
    if (labelEl) labelEl.innerText = customTitle ? customTitle : "Your Answer";
    document.getElementById('game-answer-modal').classList.remove('hidden');
};

window.answerGame = async (postId, answer) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    if (!answer || !answer.trim()) return window.showAlert("Please enter an answer.");

    const postRef = getPostDocRef(postId);
    const submitBtn = document.getElementById('game-answer-submit-btn');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Submitting...`;
    }

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
        const answerLower = answer.trim().toLowerCase();

        let isCorrect = false;
        if (post.gameType === 'guess_emoji') {
            isCorrect = answerLower === (post.gameEmojiName || '').toLowerCase();
        } else if (post.gameType === 'bring_me_emoji') {
            const correctChar = (post.gameEmojiChar || '');
            isCorrect = correctChar ? answer.trim() === correctChar : answerLower === (post.gameEmojiName || '').toLowerCase();
        } else if (post.gameType === 'flags') {
            const correctName = (post.gameFlagName || '').toLowerCase();
            isCorrect = answerLower === correctName;
        } else if (post.gameType === 'math') {
            isCorrect = answerLower === (post.gameMathAnswer || '').toLowerCase();
        } else if (post.gameType === 'jumbled_words') {
            isCorrect = answerLower === (post.gameJumbledOriginal || '').toLowerCase();
        } else if (post.gameType === 'trivia') {
            isCorrect = answerLower === (post.gameTriviaAnswer || '').toLowerCase();
        } else if (post.gameType === 'gibberish') {
            const clean = str => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            isCorrect = clean(answer) === clean(post.gameGibberishAnswer);
        } else if (post.gameType === 'emoji_riddle') {
            const clean = str => (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            isCorrect = clean(answer) === clean(post.emojiRiddleAnswer);
        } else if (post.gameType === 'periodic_table') {
            const clean = str => (str || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
            isCorrect = clean(answer) === clean(post.gameElementAnswer);
        } else if (post.gameType === 'count_dots') {
            isCorrect = parseInt(answer.trim(), 10) === Number(post.gameDotsCount);
        }

        if (!isCorrect) {
            return window.showAlert("Incorrect! Try again.");
        }

        // Write winner
        await updateDoc(postRef, {
            gameStatus: 'ended',
            gameWinner: window.currentUser.uid
        });

        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
        const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
        if (lbPoints > 0) set(ref(db, `users/${window.currentUser.uid}/lbPoints`), increment(lbPoints));
        window.logEarnings(window.currentUser.uid, postId, window.gameTypeLabel(post.gameType), prizeLogged, lbPoints);
        if (post.authorId && post.authorId !== window.currentUser.uid) {
            const myAnswerName = window.globalUsersCache?.[window.currentUser.uid]?.name || 'Someone';
            window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), prizeLogged, window.currentUser.uid, myAnswerName);
        }
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId && post.authorId !== window.currentUser.uid) {
            window.awardHostBonus(post.authorId, hostLbReward);
        }
        document.getElementById('game-answer-modal').classList.add('hidden');
        let winMsg = `Correct! 🎉 You won!`;
        if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
        if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
        window.showAlert(winMsg);
    } catch(e) {
        console.error("Answer error:", e);
        window.showAlert("Error submitting answer: " + e.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
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
    
    const snap = await getDoc(getPostDocRef(postId));
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

    const postRef = getPostDocRef(postId);

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
    await updateDoc(getPostDocRef(postId), { bingoPhase: 'drawing' });
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
    const postRef = getPostDocRef(postId);
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
        
        const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
        const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
        if (lbPoints > 0) set(ref(db, `users/${winnerId}/lbPoints`), increment(lbPoints));
        window.logEarnings(winnerId, postId, window.gameTypeLabel(post.gameType), prizeLogged, lbPoints);
        if (post.authorId) {
            const bingoWinnerName = window.globalUsersCache?.[winnerId]?.name || 'Someone';
            window.logHostedGame(post.authorId, postId, window.gameTypeLabel(post.gameType), prizeLogged, winnerId, bingoWinnerName);
        }
        const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
        if (hostLbReward > 0 && post.authorId) {
            window.awardHostBonus(post.authorId, hostLbReward);
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
            // Use allPickedUids so eliminated (non-prize) players are also removed from the wheel visually
            const allPickedUids = Array.isArray(post.spinNamesAllPicked) ? post.spinNamesAllPicked
                : existingWinners.map(w => w.uid);
            const remaining = joined.filter(u => !allPickedUids.includes(u.uid));

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
    await updateDoc(getPostDocRef(postId), {
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
    
    const snap = await getDoc(getPostDocRef(postId));
    if (!snap.exists()) return;
    const post = snap.data();
    
    if (post.spinNamesPhase !== 'submission') return window.showAlert("Submissions are closed.");
    if (post.gameEndTime && Date.now() >= post.gameEndTime) return window.showAlert("Time's up!");

    const existingEntry = post.spinNamesJoined && post.spinNamesJoined[window.currentUser.uid];
    if (existingEntry) return window.showAlert("You have already joined this wheel!");

    await updateDoc(getPostDocRef(postId), {
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
    const snap = await getDoc(getPostDocRef(postId));
    if (!snap.exists()) return;
    const post = snap.data();
    if (post.authorId !== window.currentUser.uid) return;
    const joined = post.spinNamesJoined ? Object.values(post.spinNamesJoined) : [];
    if (joined.length < 2) return window.showAlert('Need at least 2 players to start the draw.');

    // Warn host if the last prize spin is unreachable with current participants
    const prizes = Array.isArray(post.spinNamesPrizes) ? post.spinNamesPrizes : [];
    if (prizes.length > 0) {
        const maxTargetSpin = Math.max(...prizes.map(p => p.target));
        if (maxTargetSpin > joined.length) {
            return window.showAlert(`Cannot start: the last prize is set for Spin #${maxTargetSpin}, but there are only ${joined.length} participant(s). Each spin eliminates no one but picks from the full pool — you need at least ${maxTargetSpin} participant(s), or reduce your last prize spin number.`);
        }
    }

    await updateDoc(getPostDocRef(postId), { spinNamesPhase: 'drawing', spinNamesWinners: [], spinNamesSpinCount: 0, spinNamesAllPicked: [], spinNamesSpinHistory: [] });
};

window.startSpinNamesWheel = async (postId) => {
    if (!window.currentUser) return;
    const snap = await getDoc(getPostDocRef(postId));
    if (!snap.exists()) return;
    const post = snap.data();
    
    if (!post.spinNamesJoined || Object.keys(post.spinNamesJoined).length === 0) return window.showAlert("No players have joined yet.");

    // Warn host if the last prize spin is unreachable with current participants
    const prizes = Array.isArray(post.spinNamesPrizes) ? post.spinNamesPrizes : [];
    if (prizes.length > 0) {
        const joined = Object.values(post.spinNamesJoined);
        const maxTargetSpin = Math.max(...prizes.map(p => p.target));
        if (maxTargetSpin > joined.length) {
            return window.showAlert(`Cannot start: the last prize is set for Spin #${maxTargetSpin}, but there are only ${joined.length} participant(s). Each spin picks from the full pool — you need at least ${maxTargetSpin} participant(s), or reduce your last prize spin number.`);
        }
    }

    await updateDoc(getPostDocRef(postId), { spinNamesPhase: 'drawing', spinNamesWinners: [], spinNamesSpinCount: 0, spinNamesAllPicked: [], spinNamesSpinHistory: [] });
};

window.drawSpinNamesItem = async (postId) => {
    if (!window.currentUser) return;
    const snap = await getDoc(getPostDocRef(postId));
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
    const spinHistory = Array.isArray(post.spinNamesSpinHistory) ? post.spinNamesSpinHistory : [];
    
    // ALL previously picked UIDs — prize winners + non-prize picks (both are eliminated from pool)
    const allPickedUids = Array.isArray(post.spinNamesAllPicked) ? post.spinNamesAllPicked
        : existingWinners.map(w => w.uid); // fallback for old games

    const remaining = joined.filter(u => !allPickedUids.includes(u.uid));
    if (!remaining.length) return window.showAlert('No remaining players.');

    const prizes = Array.isArray(post.spinNamesPrizes) ? post.spinNamesPrizes : [];
    const currentSpinNumber = (post.spinNamesSpinCount || 0) + 1;
    const matchingPrize = prizes.find(p => p.target === currentSpinNumber);

    // --- Auto-declare: if only 1 player left and this spin has a prize, skip the spin animation ---
    if (remaining.length === 1 && matchingPrize) {
        const autoWinner = remaining[0];
        const matchingLb = (matchingPrize.lbPoints !== undefined && matchingPrize.lbPoints !== null)
            ? Number(matchingPrize.lbPoints)
            : (post.gameLbPoints !== undefined ? Number(post.gameLbPoints) : 0);

        const newWinners = [...existingWinners, {
            uid: autoWinner.uid,
            name: autoWinner.name,
            prize: matchingPrize.prize,
            lbPoints: matchingLb,
            target: currentSpinNumber
        }];
        const newHistory = [...spinHistory, { 
            spinNumber: currentSpinNumber, 
            name: autoWinner.name, 
            uid: autoWinner.uid, 
            prize: matchingPrize.prize,
            lbPoints: matchingLb
        }];
        const autoUpdates = {
            spinNamesSpinCount: currentSpinNumber,
            spinNamesWinners: newWinners,
            spinNamesAllPicked: [...allPickedUids, autoWinner.uid],
            spinNamesSpinHistory: newHistory,
            spinNamesLastSpin: { item: autoWinner.name, startTime: Date.now() }
        };
        if (matchingLb > 0) set(ref(db, `users/${autoWinner.uid}/lbPoints`), increment(matchingLb));
        window.logEarnings(autoWinner.uid, postId, `Spin the Names (#${currentSpinNumber})`, matchingPrize.prize, matchingLb);
        if (post.authorId) window.logHostedGame(post.authorId, postId, `Spin the Names (#${currentSpinNumber})`, matchingPrize.prize, autoWinner.uid, autoWinner.name);
        if (newWinners.length >= prizes.length) {
            autoUpdates.spinNamesPhase = 'ended';
            autoUpdates.gameStatus = 'ended';
            autoUpdates.gameWinner = autoWinner.uid;
            autoUpdates.locked = true;
            const hostLbReward = window.siteSettings?.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId) window.awardHostBonus(post.authorId, hostLbReward);
        }
        await updateDoc(getPostDocRef(postId), autoUpdates);
        return;
    }

    // Normal spin — pick randomly from remaining pool
    const winner = remaining[Math.floor(Math.random() * remaining.length)];
    const newAllPicked = [...allPickedUids, winner.uid];
    const matchingLb = matchingPrize ? ((matchingPrize.lbPoints !== undefined && matchingPrize.lbPoints !== null)
        ? Number(matchingPrize.lbPoints)
        : (post.gameLbPoints !== undefined ? Number(post.gameLbPoints) : 0)) : 0;

    const newHistory = [...spinHistory, { 
        spinNumber: currentSpinNumber, 
        name: winner.name, 
        uid: winner.uid, 
        prize: matchingPrize ? matchingPrize.prize : null,
        lbPoints: matchingLb
    }];

    const updates = {
        spinNamesLastSpin: { item: winner.name, startTime: Date.now() },
        spinNamesSpinCount: currentSpinNumber,
        spinNamesAllPicked: newAllPicked,
        spinNamesSpinHistory: newHistory
    };

    if (matchingPrize) {
        const newWinners = [...existingWinners, {
            uid: winner.uid,
            name: winner.name,
            prize: matchingPrize.prize,
            lbPoints: matchingLb,
            target: currentSpinNumber
        }];
        updates.spinNamesWinners = newWinners;

        if (matchingLb > 0) set(ref(db, `users/${winner.uid}/lbPoints`), increment(matchingLb));
        window.logEarnings(winner.uid, postId, `Spin the Names (#${currentSpinNumber})`, matchingPrize.prize, matchingLb);
        if (post.authorId) window.logHostedGame(post.authorId, postId, `Spin the Names (#${currentSpinNumber})`, matchingPrize.prize, winner.uid, winner.name);

        if (newWinners.length >= prizes.length) {
            updates.spinNamesPhase = 'ended';
            updates.gameStatus = 'ended';
            updates.gameWinner = winner.uid;
            updates.locked = true;
            const hostLbReward = window.siteSettings?.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId) window.awardHostBonus(post.authorId, hostLbReward);
        }
    } else {
        // Non-prize spin: check if the only remaining player (after this pick) is the next prize winner
        // If so, auto-award them on the next spin immediately after this animation
        // (The auto-declare logic above handles this on the next drawSpinNamesItem call)
    }

    await updateDoc(getPostDocRef(postId), updates);
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

// ============================================================
// TIC TAC TOE GAME HANDLERS
// ============================================================

window.acceptTicTacToeChallenge = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to accept the challenge.");
    const postRef = getPostDocRef(postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active' || post.tictactoeStatus !== 'waiting') {
            return window.showAlert("This challenge is no longer available.");
        }

        if (post.authorId === window.currentUser.uid) {
            return window.showAlert("You cannot accept your own challenge!");
        }

        if (post.tictactoeTargetUser && post.tictactoeTargetUser !== window.currentUser.uid) {
            return window.showAlert("This challenge was sent to another player!");
        }

        await updateDoc(postRef, {
            tictactoePlayerO: window.currentUser.uid,
            tictactoeStatus: 'in_progress'
        });

        window.showAlert("⚔️ Challenge accepted! Game is now in progress.");
    } catch(e) {
        console.error("Error accepting Tic Tac Toe challenge:", e);
        window.showAlert("Error: " + e.message);
    }
};

window.makeTicTacToeMove = async (postId, cellIndex) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const postRef = getPostDocRef(postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active' || post.tictactoeStatus !== 'in_progress') {
            return window.showAlert("This game is not active.");
        }

        const turn = post.tictactoeTurn || 'X';
        const isXTurn = turn === 'X';
        const expectedUid = isXTurn ? post.tictactoePlayerX : post.tictactoePlayerO;

        if (window.currentUser.uid !== expectedUid) {
            return window.showAlert("It is not your turn!");
        }

        const board = [...(post.tictactoeBoard || Array(9).fill(''))];
        if (board[cellIndex]) {
            return window.showAlert("That space is already taken!");
        }

        board[cellIndex] = turn;

        const gridSize = Number(post.tictactoeGridSize) || (board.length === 16 ? 4 : 3);

        // Generate winning lines dynamically for 3x3 (3-in-a-row) or 4x4 (4-in-a-row)
        const winningLines = [];
        // Rows
        for (let r = 0; r < gridSize; r++) {
            const row = [];
            for (let c = 0; c < gridSize; c++) row.push(r * gridSize + c);
            winningLines.push(row);
        }
        // Columns
        for (let c = 0; c < gridSize; c++) {
            const col = [];
            for (let r = 0; r < gridSize; r++) col.push(r * gridSize + c);
            winningLines.push(col);
        }
        // Diagonals
        const diag1 = [];
        const diag2 = [];
        for (let i = 0; i < gridSize; i++) {
            diag1.push(i * gridSize + i);
            diag2.push(i * gridSize + (gridSize - 1 - i));
        }
        winningLines.push(diag1);
        winningLines.push(diag2);

        let hasWon = false;
        for (const line of winningLines) {
            const firstMark = board[line[0]];
            if (firstMark && line.every(idx => board[idx] === firstMark)) {
                hasWon = true;
                break;
            }
        }

        if (hasWon) {
            const winnerUid = window.currentUser.uid;
            await updateDoc(postRef, {
                tictactoeBoard: board,
                tictactoeStatus: 'ended',
                gameStatus: 'ended',
                gameWinner: winnerUid
            });

            const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
            const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
            if (lbPoints > 0) set(ref(db, `users/${winnerUid}/lbPoints`), increment(lbPoints));
            window.logEarnings(winnerUid, postId, 'Tic Tac Toe', prizeLogged, lbPoints);
            if (post.authorId && post.authorId !== winnerUid) {
                const winnerName = window.globalUsersCache?.[winnerUid]?.name || 'Someone';
                window.logHostedGame(post.authorId, postId, 'Tic Tac Toe', prizeLogged, winnerUid, winnerName);
            }
            const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId && post.authorId !== winnerUid) {
                window.awardHostBonus(post.authorId, hostLbReward);
            }

            let winMsg = `🎉 You won the Tic Tac Toe match!`;
            if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
            if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
            window.showAlert(winMsg);
        } else if (!board.includes('')) {
            // Draw
            await updateDoc(postRef, {
                tictactoeBoard: board,
                tictactoeStatus: 'ended',
                gameStatus: 'ended',
                gameWinner: 'draw'
            });
            window.showAlert("It's a Draw! 🤝 Good game!");
        } else {
            // Next turn
            const nextTurn = isXTurn ? 'O' : 'X';
            await updateDoc(postRef, {
                tictactoeBoard: board,
                tictactoeTurn: nextTurn
            });
        }
    } catch(e) {
        console.error("Tic Tac Toe move error:", e);
        window.showAlert("Error making move: " + e.message);
    }
};

// ============================================================
// 4 IN A ROW GAME HANDLERS (7x7)
// ============================================================

window.checkFourInARowWinner = (board) => {
    const rows = 7, cols = 7;
    // Horizontal (r, c) to (r, c+3)
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c <= cols - 4; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + 1] && m === board[idx + 2] && m === board[idx + 3]) {
                return { won: true, mark: m, line: [idx, idx + 1, idx + 2, idx + 3] };
            }
        }
    }
    // Vertical (r, c) to (r+3, c)
    for (let r = 0; r <= rows - 4; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + cols] && m === board[idx + cols * 2] && m === board[idx + cols * 3]) {
                return { won: true, mark: m, line: [idx, idx + cols, idx + cols * 2, idx + cols * 3] };
            }
        }
    }
    // Diagonal down-right (r, c) to (r+3, c+3)
    for (let r = 0; r <= rows - 4; r++) {
        for (let c = 0; c <= cols - 4; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + (cols + 1)] && m === board[idx + (cols + 1) * 2] && m === board[idx + (cols + 1) * 3]) {
                return { won: true, mark: m, line: [idx, idx + (cols + 1), idx + (cols + 1) * 2, idx + (cols + 1) * 3] };
            }
        }
    }
    // Diagonal down-left (r, c) to (r+3, c-3)
    for (let r = 0; r <= rows - 4; r++) {
        for (let c = 3; c < cols; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + (cols - 1)] && m === board[idx + (cols - 1) * 2] && m === board[idx + (cols - 1) * 3]) {
                return { won: true, mark: m, line: [idx, idx + (cols - 1), idx + (cols - 1) * 2, idx + (cols - 1) * 3] };
            }
        }
    }
    return { won: false };
};

window.acceptFourInARowChallenge = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to accept the challenge.");
    const postRef = getPostDocRef(postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active' || post.fourStatus !== 'waiting') {
            return window.showAlert("This challenge is no longer available.");
        }

        const myUid = window.currentUser.uid;
        if (post.fourPlayerR === myUid || post.fourPlayerB === myUid || post.fourPlayerY === myUid) {
            return window.showAlert("You are already part of this match!");
        }

        if (post.fourTargetUser && post.fourTargetUser !== myUid && !post.fourPlayerB) {
            return window.showAlert("This challenge was sent to another player!");
        }

        const count = Number(post.fourPlayerCount) || 2;
        const updates = {};

        if (!post.fourPlayerB) {
            updates.fourPlayerB = myUid;
            if (count === 2) {
                updates.fourStatus = 'in_progress';
            }
        } else if (count === 3 && !post.fourPlayerY) {
            updates.fourPlayerY = myUid;
            updates.fourStatus = 'in_progress';
        }

        await updateDoc(postRef, updates);
        window.showAlert("🔴🔵 Challenge accepted! Good luck!");
    } catch(e) {
        console.error("Error accepting 4 in a Row challenge:", e);
        window.showAlert("Error: " + e.message);
    }
};

window.makeFourInARowMove = async (postId, cellIndex) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const postRef = getPostDocRef(postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active' || post.fourStatus !== 'in_progress') {
            return window.showAlert("This game is not active.");
        }

        const turn = post.fourTurn || 'R';
        const expectedUid = turn === 'R' ? post.fourPlayerR : (turn === 'B' ? post.fourPlayerB : post.fourPlayerY);

        if (window.currentUser.uid !== expectedUid) {
            return window.showAlert("It is not your turn!");
        }

        const board = [...(post.fourBoard || Array(49).fill(''))];
        if (board[cellIndex]) {
            return window.showAlert("That space is already taken!");
        }

        board[cellIndex] = turn;

        const winResult = window.checkFourInARowWinner(board);

        if (winResult.won) {
            const winnerUid = window.currentUser.uid;
            await updateDoc(postRef, {
                fourBoard: board,
                fourStatus: 'ended',
                fourWinningLine: winResult.line || null,
                gameStatus: 'ended',
                gameWinner: winnerUid
            });

            const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
            const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
            if (lbPoints > 0) set(ref(db, `users/${winnerUid}/lbPoints`), increment(lbPoints));
            window.logEarnings(winnerUid, postId, '4 in a Row', prizeLogged, lbPoints);
            if (post.authorId && post.authorId !== winnerUid) {
                const winnerName = window.globalUsersCache?.[winnerUid]?.name || 'Someone';
                window.logHostedGame(post.authorId, postId, '4 in a Row', prizeLogged, winnerUid, winnerName);
            }
            const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId && post.authorId !== winnerUid) {
                window.awardHostBonus(post.authorId, hostLbReward);
            }

            let winMsg = `🎉 Connect 4! You won the match!`;
            if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
            if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
            window.showAlert(winMsg);
        } else if (!board.includes('')) {
            // Draw
            await updateDoc(postRef, {
                fourBoard: board,
                fourStatus: 'ended',
                gameStatus: 'ended',
                gameWinner: 'draw'
            });
            window.showAlert("It's a Draw! 🤝 Good game!");
        } else {
            // Next turn
            const count = Number(post.fourPlayerCount) || 2;
            let nextTurn = 'R';
            if (count === 2) {
                nextTurn = turn === 'R' ? 'B' : 'R';
            } else {
                nextTurn = turn === 'R' ? 'B' : (turn === 'B' ? 'Y' : 'R');
            }
            await updateDoc(postRef, {
                fourBoard: board,
                fourTurn: nextTurn
            });
        }
    } catch(e) {
        console.error("4 in a Row move error:", e);
        window.showAlert("Error making move: " + e.message);
    }
};

// ============================================================
// CONNECT 4 (7x6 DROP) GAME HANDLERS
// ============================================================

window.checkDropFourWinner = (board) => {
    const rows = 6, cols = 7;
    // Horizontal (r, c) to (r, c+3)
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c <= cols - 4; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + 1] && m === board[idx + 2] && m === board[idx + 3]) {
                return { won: true, mark: m, line: [idx, idx + 1, idx + 2, idx + 3] };
            }
        }
    }
    // Vertical (r, c) to (r+3, c)
    for (let r = 0; r <= rows - 4; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + cols] && m === board[idx + cols * 2] && m === board[idx + cols * 3]) {
                return { won: true, mark: m, line: [idx, idx + cols, idx + cols * 2, idx + cols * 3] };
            }
        }
    }
    // Diagonal down-right (r, c) to (r+3, c+3)
    for (let r = 0; r <= rows - 4; r++) {
        for (let c = 0; c <= cols - 4; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + (cols + 1)] && m === board[idx + (cols + 1) * 2] && m === board[idx + (cols + 1) * 3]) {
                return { won: true, mark: m, line: [idx, idx + (cols + 1), idx + (cols + 1) * 2, idx + (cols + 1) * 3] };
            }
        }
    }
    // Diagonal down-left (r, c) to (r+3, c-3)
    for (let r = 0; r <= rows - 4; r++) {
        for (let c = 3; c < cols; c++) {
            const idx = r * cols + c;
            const m = board[idx];
            if (m && m === board[idx + (cols - 1)] && m === board[idx + (cols - 1) * 2] && m === board[idx + (cols - 1) * 3]) {
                return { won: true, mark: m, line: [idx, idx + (cols - 1), idx + (cols - 1) * 2, idx + (cols - 1) * 3] };
            }
        }
    }
    return { won: false };
};

window.acceptDropFourChallenge = async (postId) => {
    if (!window.currentUser) return window.showAlert("Please sign in to accept the challenge.");
    const postRef = getPostDocRef(postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active' || post.dropFourStatus !== 'waiting') {
            return window.showAlert("This challenge is no longer available.");
        }

        const myUid = window.currentUser.uid;
        if (post.dropFourPlayerR === myUid || post.dropFourPlayerY === myUid || post.dropFourPlayerB === myUid) {
            return window.showAlert("You are already part of this match!");
        }

        if (post.dropFourTargetUser && post.dropFourTargetUser !== myUid && !post.dropFourPlayerY) {
            return window.showAlert("This challenge was sent to another player!");
        }

        const count = Number(post.dropFourPlayerCount) || 2;
        const updates = {};

        if (!post.dropFourPlayerY) {
            updates.dropFourPlayerY = myUid;
            if (count === 2) {
                updates.dropFourStatus = 'in_progress';
            }
        } else if (count === 3 && !post.dropFourPlayerB) {
            updates.dropFourPlayerB = myUid;
            updates.dropFourStatus = 'in_progress';
        }

        await updateDoc(postRef, updates);
        window.showAlert("🟡🔴 Challenge accepted! Good luck!");
    } catch(e) {
        console.error("Error accepting Drop Four challenge:", e);
        window.showAlert("Error: " + e.message);
    }
};

window.makeDropFourMove = async (postId, colIndex) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const postRef = getPostDocRef(postId);

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active' || post.dropFourStatus !== 'in_progress') {
            return window.showAlert("This game is not active.");
        }

        const turn = post.dropFourTurn || 'R';
        const expectedUid = turn === 'R' ? post.dropFourPlayerR : (turn === 'Y' ? post.dropFourPlayerY : post.dropFourPlayerB);

        if (window.currentUser.uid !== expectedUid) {
            return window.showAlert("It is not your turn!");
        }

        const board = [...(post.dropFourBoard || Array(42).fill(''))];
        
        // Find lowest empty slot in column (rows 0 to 5, row 5 is bottom)
        let targetRow = -1;
        for (let r = 5; r >= 0; r--) {
            if (board[r * 7 + colIndex] === '') {
                targetRow = r;
                break;
            }
        }

        if (targetRow === -1) {
            return window.showAlert("That column is full! Please choose another column.");
        }

        const targetCellIndex = targetRow * 7 + colIndex;
        board[targetCellIndex] = turn;

        const winResult = window.checkDropFourWinner(board);

        if (winResult.won) {
            const winnerUid = window.currentUser.uid;
            await updateDoc(postRef, {
                dropFourBoard: board,
                dropFourStatus: 'ended',
                dropFourWinningLine: winResult.line || null,
                gameStatus: 'ended',
                gameWinner: winnerUid
            });

            const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
            const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
            if (lbPoints > 0) set(ref(db, `users/${winnerUid}/lbPoints`), increment(lbPoints));
            window.logEarnings(winnerUid, postId, 'Connect 4', prizeLogged, lbPoints);
            if (post.authorId && post.authorId !== winnerUid) {
                const winnerName = window.globalUsersCache?.[winnerUid]?.name || 'Someone';
                window.logHostedGame(post.authorId, postId, 'Connect 4', prizeLogged, winnerUid, winnerName);
            }
            const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
            if (hostLbReward > 0 && post.authorId && post.authorId !== winnerUid) {
                window.awardHostBonus(post.authorId, hostLbReward);
            }

            let winMsg = `🎉 Connect 4! You won the match!`;
            if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
            if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
            window.showAlert(winMsg);
        } else if (!board.includes('')) {
            // Draw
            await updateDoc(postRef, {
                dropFourBoard: board,
                dropFourStatus: 'ended',
                gameStatus: 'ended',
                gameWinner: 'draw'
            });
            window.showAlert("It's a Draw! 🤝 Good game!");
        } else {
            // Next turn
            const count = Number(post.dropFourPlayerCount) || 2;
            let nextTurn = 'R';
            if (count === 2) {
                nextTurn = turn === 'R' ? 'Y' : 'R';
            } else {
                nextTurn = turn === 'R' ? 'Y' : (turn === 'Y' ? 'B' : 'R');
            }
            await updateDoc(postRef, {
                dropFourBoard: board,
                dropFourTurn: nextTurn
            });
        }
    } catch(e) {
        console.error("Drop Four move error:", e);
        window.showAlert("Error making move: " + e.message);
    }
};

// ============================================================
// HANGMAN GAME HANDLERS
// ============================================================

window.openHangmanGuessModal = (postId, mode) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const input = document.getElementById('hangman-guess-input');
    const titleEl = document.getElementById('hangman-guess-title');
    const labelEl = document.getElementById('hangman-guess-label');
    const tipEl = document.getElementById('hangman-guess-tip');

    document.getElementById('hangman-guess-postid').value = postId;
    document.getElementById('hangman-guess-mode').value = mode;
    input.value = '';

    if (mode === 'letter') {
        titleEl.innerHTML = `<i class="fa-solid fa-font mr-2"></i>Guess One Letter`;
        labelEl.innerText = "Enter a Single Letter (A–Z)";
        input.maxLength = 1;
        input.placeholder = "e.g. E";
        tipEl.innerText = "Tip: If you guess wrong and also fail the whole word guess, you are eliminated.";
    } else {
        titleEl.innerHTML = `<i class="fa-solid fa-bullseye mr-2"></i>Guess the Whole Word`;
        labelEl.innerText = "Enter the Secret Word";
        input.removeAttribute('maxLength');
        input.placeholder = "e.g. PHILIPPINES";
        tipEl.innerText = "Caution: If your whole word guess is wrong, you lose your word guess.";
    }

    document.getElementById('hangman-guess-modal').classList.remove('hidden');
    input.focus();
};

window.submitHangmanGuess = async (postId, mode, inputVal) => {
    if (!window.currentUser) return window.showAlert("Please sign in to play.");
    const guess = (inputVal || '').trim().toUpperCase();
    if (!guess) return window.showAlert("Please enter your guess.");

    if (mode === 'letter') {
        if (!/^[A-Z]$/.test(guess)) return window.showAlert("Please enter a single valid letter from A to Z.");
    } else {
        if (!/^[A-Z\s]+$/.test(guess)) return window.showAlert("Please enter letters only.");
    }

    const postRef = getPostDocRef(postId);
    const submitBtn = document.getElementById('hangman-guess-submit-btn');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i>Submitting...`;
    }

    try {
        const snap = await getDoc(postRef);
        if (!snap.exists()) return window.showAlert("Game not found.");
        const post = snap.data();

        if (post.gameStatus !== 'active') return window.showAlert("This game has already ended.");
        if (post.authorId === window.currentUser.uid) return window.showAlert("You cannot guess on your own game!");

        const uid = window.currentUser.uid;
        const letterFailCount = Number(post.hangmanLetterWrong?.[uid] || 0);
        const wordFailCount = Number(post.hangmanWordWrong?.[uid] || 0);
        const letterFailed = letterFailCount >= 2;
        const wordFailed = wordFailCount >= 2;
        const letterRemaining = 2 - letterFailCount;
        const wordRemaining = 2 - wordFailCount;

        if (letterFailed && wordFailed) {
            document.getElementById('hangman-guess-modal').classList.add('hidden');
            return window.showAlert("You have used all your guesses and are eliminated from this game.");
        }

        const secretWord = (post.hangmanWord || '').toUpperCase();
        const guessedLetters = post.hangmanGuessedLetters || [];
        const wrongLetters = post.hangmanWrongLetters || [];

        if (mode === 'letter') {
            if (letterFailed) {
                return window.showAlert("You have used both letter guesses. You can only attempt the whole word.");
            }
            if (guessedLetters.includes(guess)) {
                return window.showAlert(`'${guess}' has already been revealed!`);
            }
            if (wrongLetters.includes(guess)) {
                return window.showAlert(`'${guess}' was already guessed and is not in the word.`);
            }

            if (secretWord.includes(guess)) {
                const newGuessed = [...guessedLetters, guess];
                // Check if all letters in secretWord are revealed
                const distinctSecretLetters = [...new Set(secretWord.replace(/\s+/g, '').split(''))];
                const allRevealed = distinctSecretLetters.every(ch => newGuessed.includes(ch));

                if (allRevealed) {
                    await updateDoc(postRef, {
                        hangmanGuessedLetters: newGuessed,
                        gameStatus: 'ended',
                        gameWinner: uid
                    });

                    const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
                    const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
                    if (lbPoints > 0) set(ref(db, `users/${uid}/lbPoints`), increment(lbPoints));
                    window.logEarnings(uid, postId, 'Hangman', prizeLogged, lbPoints);
                    if (post.authorId && post.authorId !== uid) {
                        const winnerName = window.globalUsersCache?.[uid]?.name || 'Someone';
                        window.logHostedGame(post.authorId, postId, 'Hangman', prizeLogged, uid, winnerName);
                    }
                    const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
                    if (hostLbReward > 0 && post.authorId && post.authorId !== uid) {
                        window.awardHostBonus(post.authorId, hostLbReward);
                    }

                    document.getElementById('hangman-guess-modal').classList.add('hidden');
                    let winMsg = `🎉 Amazing! You revealed the last letter and WON the Hangman game!`;
                    if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
                    if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
                    window.showAlert(winMsg);
                } else {
                    await updateDoc(postRef, {
                        hangmanGuessedLetters: newGuessed
                    });
                    document.getElementById('hangman-guess-modal').classList.add('hidden');
                    window.showAlert(`Correct! '${guess}' is in the secret word! 👍`);
                }
            } else {
                // Wrong letter
                const newWrong = [...wrongLetters, guess];
                const newLetterCount = letterFailCount + 1;
                const updatePayload = {
                    hangmanWrongLetters: newWrong,
                    [`hangmanLetterWrong.${uid}`]: newLetterCount
                };
                await updateDoc(postRef, updatePayload);
                document.getElementById('hangman-guess-modal').classList.add('hidden');
                if (newLetterCount >= 2 && wordFailed) {
                    window.showAlert(`'${guess}' is not in the word. You've used all guesses and are eliminated! 💀`);
                } else if (newLetterCount >= 2) {
                    window.showAlert(`'${guess}' is not in the word! You've used both letter guesses. You still have ${wordRemaining} word guess(es).`);
                } else {
                    window.showAlert(`'${guess}' is not in the word! You have ${2 - newLetterCount} letter guess(es) and ${wordRemaining} word guess(es) remaining.`);
                }
            }
        } else if (mode === 'word') {
            if (wordFailed) {
                return window.showAlert("You have used both word guesses. You can only guess individual letters.");
            }

            if (guess === secretWord) {
                // Win!
                const allWordLetters = [...new Set(secretWord.replace(/\s+/g, '').split(''))];
                await updateDoc(postRef, {
                    hangmanGuessedLetters: allWordLetters,
                    gameStatus: 'ended',
                    gameWinner: uid
                });

                const lbPoints = post.gameLbPoints !== undefined ? post.gameLbPoints : 5;
                const prizeLogged = window.formatPrizeForLog(post.gamePrize, post.gameBonusPrize);
                if (lbPoints > 0) set(ref(db, `users/${uid}/lbPoints`), increment(lbPoints));
                window.logEarnings(uid, postId, 'Hangman', prizeLogged, lbPoints);
                if (post.authorId && post.authorId !== uid) {
                    const winnerName = window.globalUsersCache?.[uid]?.name || 'Someone';
                    window.logHostedGame(post.authorId, postId, 'Hangman', prizeLogged, uid, winnerName);
                }
                const hostLbReward = window.siteSettings.gameHostLbReward ?? 0;
                if (hostLbReward > 0 && post.authorId && post.authorId !== uid) {
                    window.awardHostBonus(post.authorId, hostLbReward);
                }

                document.getElementById('hangman-guess-modal').classList.add('hidden');
                let winMsg = `🏆 BINGO! You guessed the entire word correctly and WON!`;
                if (prizeLogged) winMsg += ` Prize: ${prizeLogged}`;
                if (lbPoints > 0) winMsg += ` +${lbPoints} LB points!`;
                window.showAlert(winMsg);
            } else {
                // Wrong word
                const newWordCount = wordFailCount + 1;
                const updatePayload = {
                    [`hangmanWordWrong.${uid}`]: newWordCount
                };
                await updateDoc(postRef, updatePayload);
                document.getElementById('hangman-guess-modal').classList.add('hidden');
                if (newWordCount >= 2 && letterFailed) {
                    window.showAlert(`"${guess}" is incorrect! You've used all guesses and are eliminated! 💀`);
                } else if (newWordCount >= 2) {
                    window.showAlert(`"${guess}" is incorrect! You've used both word guesses. You still have ${letterRemaining} letter guess(es).`);
                } else {
                    window.showAlert(`"${guess}" is incorrect! You have ${letterRemaining} letter guess(es) and ${2 - newWordCount} word guess(es) remaining.`);
                }
            }
        }
    } catch(e) {
        console.error("Hangman guess error:", e);
        window.showAlert("Error submitting guess: " + e.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    }
};

