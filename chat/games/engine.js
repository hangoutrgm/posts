// ============================================================
// chat/games/engine.js — creation, RTDB sync, actions, win logic
// ============================================================
import { ref, push, get, set, update, runTransaction, increment } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { db } from '../../js/firebase-config.js';
import { GAME_META, pick, shuffle } from './helpers.js?v=6';
import {
  mathRound, countEmojiRound, jumbledRound, triviaRound, ROUNDS_PER_GAME,
} from './data.js?v=6';

let _getThreadId = () => null;
export const setThreadGetter = (fn) => { _getThreadId = fn; };
// Host-input providers (wired by index.js — e.g. the Hangman setup modal)
let _hostInputs = {};
export const setHostInputs = (h) => { _hostInputs = { ..._hostInputs, ...h }; };
// Admin-configurable runtime (/config → settings) — wired from app.js via index.js
let _getSettings = () => ({});
export const setSettingsGetter = (fn) => { if (typeof fn === 'function') _getSettings = fn; };
let _isLbRewardsEnabled = () => false;
export const setLbRewardsChecker = (fn) => { if (typeof fn === 'function') _isLbRewardsEnabled = fn; };
const getRaceTo = () => {
  const s = _getSettings();
  const n = Number(s.chatGameRaceTo ?? s.chatGameRounds);
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : ROUNDS_PER_GAME;
};
const roundCount = () => getRaceTo();

// ── Leaderboard rewards ──
// Chat game winners earn LB points into the SAME pool as Hangout Posts games:
//   all-time : users/{uid}/lbPoints
//   weekly   : lbWeekly/{ISO-week}/{uid}
//   monthly  : lbMonthly/{YYYY-MM}/{uid}
let _toast = () => {};
export const setToast = (fn) => { if (typeof fn === 'function') _toast = fn; };
const pad2 = (n) => String(n).padStart(2, '0');
export const lbWeekKey = (d) => {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay() === 0 ? 6 : date.getDay() - 1; // Mon=0 .. Sun=6
  const thursday = new Date(date);
  thursday.setDate(date.getDate() - day + 3);
  const jan1 = new Date(thursday.getFullYear(), 0, 1, 12);
  const week = Math.ceil((((thursday - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  return `${thursday.getFullYear()}-W${pad2(week)}`;
};
const lbMonthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const creditLb = (uid, pts) => {
  if (!uid || !(pts > 0)) return;
  const now = new Date();
  set(ref(db, `users/${uid}/lbPoints`), increment(pts)).catch(() => {});
  update(ref(db, `lbWeekly/${lbWeekKey(now)}`), { [uid]: increment(pts) }).catch(() => {});
  update(ref(db, `lbMonthly/${lbMonthKey(now)}`), { [uid]: increment(pts) }).catch(() => {});
};
// Idempotent award: called after every game action. The atomic claim ensures
// exactly ONE client credits the winner, no matter how many people saw the end.
async function maybeAwardLb(mid) {
  const currentTid = tid();
  if (!currentTid) return;
  
  // DMs and regular GCs have LB rewards disabled by default.
  // Only gaming rooms/GCs with lbRewardsEnabled set to true by an admin award points.
  let allowed = _isLbRewardsEnabled();
  if (!allowed) {
    try {
      const tSnap = await get(ref(db, `chatThreads/${currentTid}`));
      const tVal = tSnap.val();
      if (tVal?.isGroup && tVal?.lbRewardsEnabled === true) {
        allowed = true;
      }
    } catch (_) {}
  }
  if (!allowed) return;

  const pts = Number(_getSettings().chatGameLbReward || 0);
  const hostPts = Number(_getSettings().chatGameHostLbReward || 0);
  if (!(pts > 0 || hostPts > 0)) return;
  try {
    // Atomically claim awards in one transaction
    const claim = await runTransaction(gRef(mid), (gm) => {
      if (!gm || gm.status !== 'done') return undefined;

      // Anti-abuse check: If host created the game and is the ONLY one who answered/played, reward is 0
      if (gm.hostId) {
        let hasOtherParticipants = false;
        if (gm.type === 'first_to_mine') {
          hasOtherParticipants = Boolean(gm.winner && gm.winner !== gm.hostId);
        } else if (gm.type === 'hangman') {
          const lFails = Object.keys(gm.letterFails || {}).filter((u) => u !== gm.hostId);
          const wFails = Object.keys(gm.wordFails || {}).filter((u) => u !== gm.hostId);
          hasOtherParticipants = (lFails.length > 0 || wFails.length > 0 || (gm.winner && gm.winner !== gm.hostId));
        } else if (gm.players) {
          const others = Object.keys(gm.players).filter((u) => u !== gm.hostId);
          hasOtherParticipants = (others.length > 0);
        } else {
          // Quiz family / multi-round / gibberish:
          const scoredOthers = Object.keys(gm.scores || {}).filter((u) => u !== gm.hostId);
          const solvedOthers = Object.values(gm.solved || {}).filter((u) => u && u !== gm.hostId);
          let attemptedOthers = false;
          if (gm.attempts) {
            Object.values(gm.attempts).forEach((att) => {
              if (att && typeof att === 'object') {
                if (Object.keys(att).some((u) => u !== gm.hostId)) attemptedOthers = true;
              }
            });
          }
          const otherWinner = Boolean(gm.winner && gm.winner !== gm.hostId && gm.winner !== 'tie' && gm.winner !== 'draw' && gm.winner !== 'lost');
          hasOtherParticipants = (scoredOthers.length > 0 || solvedOthers.length > 0 || attemptedOthers || otherWinner);
        }

        if (!hasOtherParticipants) {
          gm.lbAbortedSolo = true;
          return gm;
        }
      }

      let changed = false;
      // Single winner only (ties/draws/losses get nothing)
      if (pts > 0) {
        const win = gm.winner;
        if (win && win !== 'tie' && win !== 'draw' && win !== 'lost' && !gm.lbRewardAt) {
          gm.lbRewardAt = Date.now();
          gm.lbRewardPts = pts;
          gm.lbWinnerUid = win;
          changed = true;
        }
      }
      // Host bonus: host earns once when legitimate multi-player game finishes
      if (hostPts > 0 && gm.hostId && !gm.lbHostAwarded) {
        gm.lbHostAwarded = Date.now();
        gm.lbHostPts = hostPts;
        changed = true;
      }
      return changed ? gm : undefined;
    });
    if (!claim || claim.committed !== true) return;
    const snapNow = await get(gRef(mid));
    const gm = snapNow.val();
    if (!gm || gm.lbAbortedSolo) return;
    if (gm.lbWinnerUid && gm.lbRewardPts > 0) {
      creditLb(gm.lbWinnerUid, gm.lbRewardPts);
      _toast(`🏆 +${gm.lbRewardPts} LB points!`);
    }
    if (gm.hostId && gm.lbHostPts > 0) {
      creditLb(gm.hostId, gm.lbHostPts);
      if (gm.hostId !== gm.lbWinnerUid) _toast(`🎉 +${gm.lbHostPts} Host Bonus!`);
    }
  } catch (e) { console.warn('[ChatGames] LB award skipped:', e); }
}
const tid = () => _getThreadId();
const me = () => getAuth().currentUser?.uid;
// Game state lives inline inside the message (simplest, single-write, no bounce).
const gRef = (mid) => ref(db, `chatMessages/${tid()}/${mid}/game`);

// ── Config bank loaders (posts-side JSON, cached) ──
let _flags = null, _riddles = null, _elements = null, _emojiBank = null, _trivia = null, _jumbled = null;
const loadFlags = async () => {
  if (_flags) return _flags;
  try { const r = await fetch('../config/flags.json?v=1'); _flags = await r.json(); } catch (_) { _flags = []; }
  return _flags;
};
const loadRiddles = async () => {
  if (_riddles) return _riddles;
  try {
    const r = await fetch('../config/emoji_riddles.json?v=1');
    const cats = await r.json();
    _riddles = Object.values(cats || {}).flat();
  } catch (_) { _riddles = []; }
  return _riddles;
};
const loadElements = async () => {
  if (_elements) return _elements;
  try { const r = await fetch('../config/elements.json?v=1'); _elements = await r.json(); } catch (_) { _elements = []; }
  return Array.isArray(_elements) ? _elements : [];
};
// "🍎 Apple Name" strings → { c: '🍎', n: 'Apple Name' }
const loadEmojiBank = async () => {
  if (_emojiBank) return _emojiBank;
  let list = [];
  try { const r = await fetch('../config/emojis.json?v=1'); list = await r.json(); } catch (_) { list = []; }
  _emojiBank = (Array.isArray(list) ? list : [])
    .map((s) => { const i = String(s).indexOf(' '); return i > 0 ? { c: s.slice(0, i), n: s.slice(i + 1).trim() } : null; })
    .filter(Boolean);
  return _emojiBank;
};
const loadTrivia = async () => {
  if (_trivia) return _trivia;
  try { const r = await fetch('../config/trivia.json?v=1'); _trivia = await r.json(); } catch (_) { _trivia = []; }
  return Array.isArray(_trivia) ? _trivia : [];
};
const loadJumbledWords = async () => {
  if (_jumbled) return _jumbled;
  try { const r = await fetch('../config/jumbled.json?v=1'); _jumbled = await r.json(); } catch (_) { _jumbled = []; }
  return Array.isArray(_jumbled) ? _jumbled : [];
};

/** Ask the host for text via prompt(). Returns trimmed string or null when cancelled. */
const ask = (msg, def) => {
  const v = window.prompt(msg, def || '');
  return v === null ? null : v.trim();
};

// ── Build the initial game object per type ──
const buildGame = async (type) => {
  const base = { type, hostId: me(), createdAt: Date.now(), status: 'active', winner: null };
  switch (GAME_META[type]?.family) {
    case 'board':
      return { ...base,
        status: 'waiting',                       // waiting for opponent to join
        players: { [me()]: type === 'connect4' ? 'R' : 'X' },
        turn: null,
        board: Array(type === 'connect4' ? 42 : 9).fill(''),
        lastMove: null,
      };
    case 'hangman': {                            // cloned from Hangout Posts: host picks the word (setup modal)
      let setup = null;
      if (_hostInputs.hangman) setup = await _hostInputs.hangman();
      else {
        const raw = ask('🔤 Hangman\nEnter the secret word (letters & spaces only):');
        if (raw === null) throw new Error('cancelled');
        setup = { word: raw, clues: '' };
      }
      if (!setup || !setup.word) throw new Error('cancelled');
      const word = String(setup.word).toUpperCase().replace(/\s+/g, ' ').trim();
      if (!/^[A-Z ]{2,30}$/.test(word)) throw new Error('Word must be 2-30 letters.');
      const distinct = [...new Set(word.replace(/ /g, '').split(''))];
      const cluesRaw = String(setup.clues || '').toUpperCase();
      let clues = [...new Set((cluesRaw.match(/[A-Z]/g) || []))].filter((L) => distinct.includes(L));
      if (clues.length >= distinct.length) clues = clues.slice(0, Math.max(0, distinct.length - 1));
      // Fixed allowance cloned from Hangout Posts: 2 wrong letter guesses
      // AND 2 wrong whole-word guesses per player.
      const maxFails = 2;
      return { ...base,
        word,
        guessed: Object.fromEntries(clues.map((L) => [L, 'hit'])),
        wrongLetters: [],
        letterFails: {},                         // per-player wrong-letter count
        wordFails: {},                           // per-player wrong-word-guess count
        maxFails,
      };
    }
    case 'gibberish': {                          // host supplies the phrase + answer (setup modal)
      let setup = null;
      if (_hostInputs.gibberish) setup = await _hostInputs.gibberish();
      else {
        const p = ask('🗣️ Gibberish\nEnter your nonsense phrase (e.g. "Hue Can Knot Paws"):');
        if (p === null) throw new Error('cancelled');
        const a = ask('Great!\nNow enter the correct answer for that phrase:');
        if (a === null) throw new Error('cancelled');
        setup = { phrase: p, answer: a };
      }
      if (!setup || !setup.phrase || !setup.answer) throw new Error('cancelled');
      return { ...base, rounds: [{ q: setup.phrase, a: [setup.answer] }], revealed: 0, scores: {}, solved: {} };
    }
    case 'mine':
      return { ...base, status: 'active' };      // one big MINE button — first tap wins
    case 'quiz': {
      const rounds = [];
      const raceTo = getRaceTo();
      const count = Math.max(raceTo * 6, 25);

      if (type === 'trivia') {
        const pool = shuffle(await loadTrivia());
        for (let i = 0; i < Math.min(count, pool.length); i++) {
          const t = pool[i];
          rounds.push({ q: t.q, a: t.a, choices: shuffle([...(t.choices || [])]) });
        }
      } else if (type === 'jumbled') {
        const pool = shuffle(await loadJumbledWords());
        for (let i = 0; i < Math.min(count, pool.length); i++) {
          const w = pool[i];
          let scrambled = w;
          let guard = 0;
          while (scrambled === w && guard++ < 10 && w.length > 1) {
            scrambled = shuffle(w.split('')).join('');
          }
          rounds.push({ q: scrambled.toUpperCase(), a: [w] });
        }
      } else if (type === 'flags') {
        const pool = shuffle(await loadFlags());
        for (let i = 0; i < Math.min(count, pool.length); i++) {
          const f = pool[i];
          rounds.push({ code: f.code, a: [f.name] });
        }
      } else if (type === 'emojiriddle') {
        const pool = shuffle(await loadRiddles());
        for (let i = 0; i < Math.min(count, pool.length); i++) {
          const er = pool[i];
          rounds.push({ emojis: er.emojis, a: [er.answer] });
        }
      } else if (type === 'guessemoji' || type === 'bringmeemoji') {
        const pool = shuffle(await loadEmojiBank());
        for (let i = 0; i < Math.min(count, pool.length); i++) {
          const item = pool[i] || { c: '🍎', n: 'Red Apple' };
          if (type === 'guessemoji') rounds.push({ emojis: item.c, a: [item.n] });
          else rounds.push({ q: `Send me this emoji: ${item.n}`, char: item.c, a: [item.n] });
        }
      } else if (type === 'periodic') {
        const pool = shuffle(await loadElements());
        for (let i = 0; i < Math.min(count, pool.length); i++) {
          const el = pool[i] || { number: 1, symbol: 'H', name: 'Hydrogen' };
          if (Math.random() < 0.5) rounds.push({ q: `${el.symbol} · Atomic #${el.number} — which element?`, a: [el.name] });
          else rounds.push({ q: `${el.name} · Atomic #${el.number} — chemical symbol?`, a: [el.symbol] });
        }
      } else if (type === 'math') {
        for (let i = 0; i < count; i++) {
          const m = mathRound(i);
          rounds.push({ q: m.q, a: [m.a] });
        }
      } else if (type === 'countemoji') {
        for (let i = 0; i < count; i++) {
          const d = countEmojiRound();
          rounds.push({ grid: d.grid, emoji: d.emoji, a: [d.a] });
        }
      }
      return { ...base, raceTo, rounds, revealed: 0, scores: {}, solved: {} };
    }
    default:
      return base;
  }
};
const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

// ── Push the game message into the thread ──
export const createGame = async (type) => {
  const threadId = tid();
  const uid = me();
  if (!threadId || !uid) return;
  const meta = GAME_META[type];
  if (!meta) return;

  // Daily game hosting limit (configured in /config → settings/gameLimits)
  // Maps first_to_mine -> chat_first_to_mine, gibberish -> chat_gibberish, etc.
  const limitKey = type === 'first_to_mine' ? 'chat_first_to_mine' : type === 'gibberish' ? 'chat_gibberish' : `chat_${type}`;
  const limits = _getSettings().gameLimits || {};
  const typeLimit = Number(limits[limitKey] ?? 0);

  if (typeLimit > 0) {
    const counterRef = ref(db, `gamePostCounts/${todayStr()}/${uid}/${limitKey}`);
    const snap = await get(counterRef).catch(() => null);
    const used = snap?.exists() ? Number(snap.val()) : 0;
    if (used >= typeLimit) {
      const err = new Error('limit_reached');
      err.limitMessage = `Daily limit reached — you've already hosted ${used}/${typeLimit} "${meta.name}" games today. Resets at 12:00 AM.`;
      throw err;
    }
  }

  // Cooldown between starting games (/config → Chat Game Start, seconds; 0 = off)
  const cd = Number(_getSettings().chatGameCooldownSec ?? 0);
  if (cd > 0) {
    const snap = await get(ref(db, `users/${uid}/lastChatGameAt`)).catch(() => null);
    const waitMs = cd * 1000 - (Date.now() - Number(snap?.val() || 0));
    if (waitMs > 0) {
      const err = new Error('cooldown');
      err.cooldownWait = Math.ceil(waitMs / 1000);
      throw err;
    }
  }

  let game;
  try { game = await buildGame(type); }
  catch (e) {
    if (e && e.message === 'cancelled') throw e; // host closed setup modal
    console.warn('[ChatGames] build failed:', e);
    throw e;
  }

  // Atomic limit consumption
  if (typeLimit > 0) {
    const counterRef = ref(db, `gamePostCounts/${todayStr()}/${uid}/${limitKey}`);
    let limitReached = false;
    try {
      const txn = await runTransaction(counterRef, (current) => {
        const count = Number(current || 0);
        if (count >= typeLimit) return undefined;
        return count + 1;
      });
      limitReached = !txn.committed;
    } catch (_) {}
    if (limitReached) {
      const err = new Error('limit_reached');
      err.limitMessage = `Daily limit reached — you've reached the daily limit of ${typeLimit} "${meta.name}" games for today. Resets at 12:00 AM.`;
      throw err;
    }
  }

  const text = `${meta.icon} ${meta.name}`;

  // Single-write creation: the full game ships inside the message, so it renders
  // complete in ONE pass — no placeholder, no second-load swap, no bounce.
  await push(ref(db, `chatMessages/${threadId}`), {
    senderId: uid,
    timestamp: Date.now(),
    text,
    isGame: true,
    game,
  });
  update(ref(db, 'users/' + uid), { lastChatGameAt: Date.now() });
};

// ── Board helpers ──
const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const tttWinner = (b) => {
  for (const [a, c, d] of TTT_LINES) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 'draw' : null;
};
const C4_MARKS = ['R', 'Y', 'G'];
const c4Winner = (b) => {
  const at = (r, c) => (r >= 0 && r < 6 && c >= 0 && c < 7 ? b[r * 7 + c] : '');
  for (const s of C4_MARKS) {
    for (let r = 5; r >= 0; r--) for (let c = 0; c < 7; c++) {
      if (at(r, c) !== s) continue;
      if (s === at(r, c+1) && s === at(r, c+2) && s === at(r, c+3)) return s;
      if (s === at(r-1, c) && s === at(r-2, c) && s === at(r-3, c)) return s;
      if (s === at(r-1, c+1) && s === at(r-2, c+2) && s === at(r-3, c+3)) return s;
      if (s === at(r-1, c-1) && s === at(r-2, c-2) && s === at(r-3, c-3)) return s;
    }
  }
  return b.every(Boolean) ? 'draw' : null;
};

// ============================================================
// ACTIONS (wired to window.ChatGames by index.js)
// ============================================================

/** Board games: players join → game goes active when the table is full.
 *  Connect 4 seats up to THREE players (🔴 host, then 🟡, then 🟢); Tic-Tac-Toe stays 2. */
export const joinGame = async (mid) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'waiting') return g;
    if (!g.players || g.players[uid]) return g; // already started / already in
    const need = g.type === 'connect4' ? 3 : 2;
    if (Object.keys(g.players).length >= need) return g;
    const marks = g.type === 'connect4' ? ['Y', 'G'] : ['O'];
    g.players[uid] = marks[Object.keys(g.players).length - 1] || marks[marks.length - 1];
    if (Object.keys(g.players).length >= need) { g.status = 'active'; g.turn = g.hostId; }
    return g;
  });
};

/** Connect-4: host may start early once 2 of the 3 seats are filled. */
export const startNow = async (mid) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'waiting' || g.type !== 'connect4') return g;
    if (uid !== g.hostId || Object.keys(g.players || {}).length < 2) return g;
    g.status = 'active';
    g.turn = g.hostId;
    return g;
  });
};

/** Tic-Tac-Toe cell click / Connect-4 column click. */
export const playMove = async (mid, idx) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active' || g.turn !== uid) return g;
    const board = [...(g.board || [])];
    let changed = false;
    if (g.type === 'tictactoe') {
      if (!board[idx]) { board[idx] = g.players[uid] || 'X'; changed = true; }
    } else if (g.type === 'connect4') {
      const col = Number(idx);
      for (let r = 5; r >= 0; r--) {
        if (!board[r * 7 + col]) { board[r * 7 + col] = g.players[uid] || 'R'; changed = true; break; }
      }
    }
    if (!changed) return g;
    g.board = board;
    const w = g.type === 'tictactoe' ? tttWinner(board) : c4Winner(board);
    if (w === 'draw') { g.status = 'done'; g.winner = 'draw'; }
    else if (w) {
      g.status = 'done';
      g.winnerMark = w;
      g.winner = Object.keys(g.players || {}).find((u) => g.players[u] === w) || null;
    } else {
      // Rotate to the next player in join order (supports 2 or 3 players)
      const order = Object.keys(g.players || {});
      const i = order.indexOf(uid);
      g.turn = order.length ? order[(i + 1) % order.length] : null;
    }
    return g;
  });
  void maybeAwardLb(mid);
};

/** Hangman letter guess — cloned from Hangout Posts rules:
 *  shared board reveal · 2 wrong letters per player max, then letters lock for them.
 *  Host cannot guess their own game. */
export const guessLetter = async (mid, rawLetter) => {
  const uid = me(); if (!uid) return;
  const L = String(rawLetter || '').toUpperCase().slice(0, 1);
  if (!/^[A-Z]$/.test(L)) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active' || !g.word) return g;
    if (uid === g.hostId) return g;                   // hosts can't play their own game
    g.letterFails = g.letterFails || {};
    g.wordFails = g.wordFails || {};
    const lettersLocked = (g.letterFails[uid] || 0) >= (g.maxFails || 2)
      && (g.wordFails[uid] || 0) >= (g.maxFails || 2);
    if (lettersLocked || (g.letterFails[uid] || 0) >= (g.maxFails || 2)) return g;
    g.guessed = g.guessed || {};
    g.wrongLetters = g.wrongLetters || [];
    if (g.guessed[L] || g.wrongLetters.includes(L)) return g;   // already revealed / tried
    if (g.word.includes(L)) {
      g.guessed[L] = 'hit';
      const allFound = [...g.word].every((ch) => ch === ' ' || g.guessed[ch]);
      if (allFound) { g.status = 'done'; g.winner = uid; }
    } else {
      g.wrongLetters.push(L);
      g.letterFails[uid] = (g.letterFails[uid] || 0) + 1;
    }
    return g;
  });
  void maybeAwardLb(mid);
};

/** Hangman whole-word guess — wrong guesses cost one of the player's 2 word tries. */
export const guessWord = async (mid, value) => {
  const uid = me(); if (!uid) return;
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active' || !g.word) return g;
    if (uid === g.hostId) return g;
    g.wordFails = g.wordFails || {};
    if ((g.wordFails[uid] || 0) >= (g.maxFails || 2)) return g;
    const w = String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (w === g.word) { g.status = 'done'; g.winner = uid; return g; }
    g.wordFails[uid] = (g.wordFails[uid] || 0) + 1;
    return g;
  });
  void maybeAwardLb(mid);
};

/** First to Mine — one atomic tap, first player wins. Host tapping gets 'host' back. */
export const mineNow = async (mid) => {
  const uid = me(); if (!uid) return 'signed-out';
  let result = 'late';
  await runTransaction(gRef(mid), (g) => {
    if (!g || g.status !== 'active') return g;
    if (uid === g.hostId) { result = 'host'; return g; } // hosts can't win their own game
    g.status = 'done';
    g.winner = uid;
    result = 'won';
    return g;
  });
  void maybeAwardLb(mid);
  return result;
};

/** Advance to the next round once the intermission cooldown has elapsed */
export const advanceRound = async (mid, expectedIdx) => {
  if (!mid) return;
  await runTransaction(gRef(mid), (gg) => {
    if (!gg || gg.status !== 'active') return gg;
    const curIdx = Number(gg.revealed || 0);
    if (expectedIdx !== undefined && curIdx !== expectedIdx) return gg;
    if (gg.nextRoundAt && Date.now() >= Number(gg.nextRoundAt) - 300) {
      gg.revealed = curIdx + 1;
      gg.nextRoundAt = null;
      gg.roundWinner = null;
      gg.lastAnswer = null;
    }
    return gg;
  });
};

/** Host skips the current round in a multi-round game */
export const skipRound = async (mid) => {
  const uid = me();
  if (!uid || !mid) return;
  
  let isGameOver = false;

  await runTransaction(gRef(mid), (gg) => {
    if (!gg || gg.status !== 'active' || !Array.isArray(gg.rounds)) return gg;
    if (gg.hostId !== uid) return gg; // only host can skip

    const curIdx = Number(gg.revealed || 0);
    const isOutOfRounds = (curIdx + 1 >= (gg.rounds || []).length);
    isGameOver = isOutOfRounds;

    if (isGameOver) {
      gg.revealed = curIdx + 1;
      gg.status = 'done';
      gg.nextRoundAt = null;
      const entries = Object.entries(gg.scores || {});
      if (entries.length) {
        const top = Math.max(...entries.map(([, v]) => v));
        const tops = entries.filter(([, v]) => v === top).map(([u]) => u);
        gg.winner = tops.length === 1 ? tops[0] : 'tie';
      } else {
        gg.winner = null;
      }
      gg.finalScores = Object.fromEntries(Object.entries(gg.scores || {}));
    } else {
      gg.revealed = curIdx + 1;
      gg.nextRoundAt = null;
      gg.roundWinner = null;
      gg.lastAnswer = null;
    }
    return gg;
  });

  if (isGameOver) {
    void maybeAwardLb(mid);
  }
};

/** Quiz-style answer submit. First correct per round scores; auto-advances rounds with 3s cooldown. */
export const submitGuess = async (mid, value) => {
  const uid = me(); if (!uid || value == null) return;
  const snap = await get(gRef(mid));
  const g = snap.val();
  if (!g || g.status !== 'active' || !Array.isArray(g.rounds)) return;
  const idx = Number(g.revealed || 0);
  const round = g.rounds[idx];
  if (!round) return;
  
  // If currently in round cooldown intermission, reject new guesses until next round starts
  if (g.nextRoundAt && Number(g.nextRoundAt) > Date.now()) return;

  // Trivia-style lockout: a player who already clicked a wrong choice can't answer this round
  if (round.choices && Number((g.attempts || {})[idx]?.[uid])) return;

  // Bring-Me-Emoji rounds are matched on the pasted emoji CHARACTER itself
  // (text normalization would strip emojis), with the name as fallback.
  let ok = false;
  if (round.char) {
    ok = String(value ?? '').includes(round.char);
  }
  if (!ok) {
    const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ').trim();
    const guess = norm(value);
    ok = (Array.isArray(round.a) ? round.a : [round.a])
      .some((a) => { const t = norm(a); return guess && (guess === t || guess.replace(/^(a|an|the) /, '') === t.replace(/^(a|an|the) /, '')); });
  }
  if (!ok) {
    // Wrong choice click → record the miss so this player is locked out of the current round
    if (round.choices) {
      await runTransaction(
        ref(db, `chatMessages/${tid()}/${mid}/game/attempts/${idx}/${uid}`),
        (cur) => (cur ? undefined : true),
      ).catch(() => {});
    }
    return;                                           // wrong answers stay silent (no spam writes)
  }

  // Claim this round atomically — only the first correct solver scores.
  const claim = await runTransaction(ref(db, `chatMessages/${tid()}/${mid}/game/solved/${idx}`), (cur) => (cur ? undefined : uid));
  if (!claim.committed) return;

  let isGameOver = false;

  await runTransaction(gRef(mid), (gg) => {
    if (!gg || gg.status !== 'active') return gg;
    // Respect the wrong-choice lockout — a locked-out player can't score this round
    if ((gg.attempts || {})[idx]?.[uid]) return gg;
    gg.scores = gg.scores || {};
    const newScore = (gg.scores[uid] || 0) + 1;
    gg.scores[uid] = newScore;
    gg.roundWinner = uid;
    gg.lastAnswer = String(round.a?.[0] || round.a || round.name || round.char || value || '');

    const target = Number(gg.raceTo || getRaceTo());
    const hitTarget = newScore >= target;
    const isOutOfRounds = (idx + 1 >= (gg.rounds || []).length);
    isGameOver = hitTarget || isOutOfRounds;

    if (isGameOver) {
      gg.revealed = idx + 1;
      gg.status = 'done';
      gg.nextRoundAt = null;
      if (hitTarget) {
        gg.winner = uid;
      } else {
        const entries = Object.entries(gg.scores);
        if (entries.length) {
          const top = Math.max(...entries.map(([, v]) => v));
          const tops = entries.filter(([, v]) => v === top).map(([u]) => u);
          gg.winner = tops.length === 1 ? tops[0] : 'tie';
        } else {
          gg.winner = null;
        }
      }
      gg.finalScores = Object.fromEntries(Object.entries(gg.scores));
    } else {
      // 3-second cooldown before next round starts
      gg.revealed = idx;
      gg.nextRoundAt = Date.now() + 3200;
    }
    return gg;
  });

  if (isGameOver) {
    void maybeAwardLb(mid);
  } else {
    // Schedule advance after 3.2 seconds
    setTimeout(() => {
      advanceRound(mid, idx);
    }, 3200);
  }
};

/** Host abort/close. */
export const closeGame = async (mid) => {
  if (me()) await update(gRef(mid), { status: 'closed' });
};

