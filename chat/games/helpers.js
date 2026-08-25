// ============================================================
// chat/games/helpers.js — shared utilities for Hangout Chat games
// ============================================================

/** Escape a string for safe HTML interpolation. */
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Random integer 0..n-1 */
export const randInt = (n) => Math.floor(Math.random() * n);

/** Pick one random element */
export const pick = (arr) => arr[randInt(arr.length)];

/** Fisher–Yates shuffle (returns a copy) */
export const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Normalize a guess: trim, lowercase, collapse spaces, strip punctuation/diacritics. */
export const normAnswer = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Accept comma/ampersand/space-separated multi-part answers ("salt and pepper"). */
export const answersMatch = (guess, accepted) => {
  const g = normAnswer(guess);
  return (Array.isArray(accepted) ? accepted : [accepted]).some((a) => {
    const t = normAnswer(a);
    return g === t || g.replace(/^(a|an|the) /, '') === t.replace(/^(a|an|the) /, '');
  });
};

/** Short unique id for local UI keys (not a DB key). */
export const miniId = () => Math.random().toString(36).slice(2, 10);

// ── Cached JSON loader for the posts-side config banks ──
const _jsonCache = {};
export const fetchJson = async (relPath) => {
  if (_jsonCache[relPath]) return _jsonCache[relPath];
  try {
    const res = await fetch(relPath, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _jsonCache[relPath] = data;
    return data;
  } catch (e) {
    console.warn('[ChatGames] JSON load failed:', relPath, e);
    _jsonCache[relPath] = null;
    return null;
  }
};

// ── Game registry metadata (single source for the picker + titles) ──
export const GAME_META = {
  tictactoe:    { name: 'Tic-Tac-Toe',        icon: '⭕',  family: 'board',     hint: 'Best of one — 3 in a row wins' },
  connect4:     { name: 'Connect 4',          icon: '🔴',  family: 'board',     hint: '2–3 players — line up 4 to win' },
  hangman:      { name: 'Hangman',            icon: '🔤',  family: 'hangman',   hint: 'You pick the word — they guess letters' },
  first_to_mine:{ name: 'First to Mine',      icon: '💎',  family: 'mine',      hint: 'One tap — fastest miner wins' },
  trivia:       { name: 'Trivia',             icon: '🧠',  family: 'quiz',      hint: '5 rounds of general knowledge' },
  flags:        { name: 'Flag Quiz',          icon: '🚩',  family: 'quiz',      hint: 'Name the country from its flag' },
  math:         { name: 'Math Duel',          icon: '➗',  family: 'quiz',      hint: 'Quick-fire arithmetic rounds' },
  jumbled:      { name: 'Jumbled Words',      icon: '🔀',  family: 'quiz',      hint: 'Unscramble the word' },
  gibberish:    { name: 'Gibberish',          icon: '🗣️', family: 'gibberish', hint: 'Say your phrase — they decode it' },
  emojiriddle:  { name: 'Emoji Riddles',      icon: '🧩',  family: 'quiz',      hint: 'Guess from the emojis' },
  countemoji:   { name: 'Count the Emojis',   icon: '🧮',  family: 'quiz',      hint: 'Count fast, count right' },
  guessemoji:   { name: 'Guess the Emoji',    icon: '❓',  family: 'quiz',      hint: 'See the emoji — race to name it (first to 5)' },
  bringmeemoji: { name: 'Bring Me the Emoji', icon: '📨',  family: 'quiz',      hint: 'Send the matching emoji — first to 5' },
  periodic:     { name: 'Periodic Table',     icon: '🧪',  family: 'quiz',      hint: '5 rounds of elements & symbols' },
};
