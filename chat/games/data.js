// ============================================================
// chat/games/data.js — static content + round generators
// (Trivia / Flags / Emoji Riddles / Elements load from ../config/*.json)
// ============================================================
import { pick, randInt, shuffle } from './helpers.js?v=5';

// ── Math duel — difficulty ramps with round index ──
export const mathRound = (roundIdx) => {
  const lvl = Math.min(4, Math.floor(roundIdx / 1)); // 0..4
  const ops = lvl < 2 ? ['+', '-'] : lvl < 3 ? ['+', '-', '×'] : ['+', '-', '×', '÷'];
  const op = pick(ops);
  const cap = [10, 20, 50, 80, 120][lvl] || 10;
  let a = randInt(cap) + 1, b = randInt(cap) + 1, ans;
  switch (op) {
    case '+': ans = a + b; break;
    case '-': if (b > a) [a, b] = [b, a]; ans = a - b; break;
    case '×': a = randInt(Math.min(12, cap)) + 1; b = randInt(Math.min(12, cap)) + 1; ans = a * b; break;
    default : b = randInt(9) + 1; ans = randInt(12) + 1; a = ans * b; break; // ÷ always whole
  }
  return { q: `${a} ${op} ${b}`, a: String(ans) };
};

// ── Count the Emojis — original scatter-grid gameplay: target emoji ×N in a 25-cell grid,
//    remaining cells are dim '·' fillers. Fun mix of emojis — no plain colored balls.
const DOT_EMOJIS = ['🍎','🐸','⭐','🍌','🚗','🌈','🐧','🍓','🦋','🌻','🐙','🍕'];
export const countEmojiRound = () => {
  const emoji = pick(DOT_EMOJIS);
  const target = 3 + randInt(13); // 3..15
  const cells = shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, target);
  const grid = Array.from({ length: 25 }, (_, i) => (cells.includes(i) ? emoji : '·'));
  return { emoji, grid, a: String(target) };
};

// ── Jumbled words — word list lives in ../config/jumbled.json (add more anytime) ──
export const jumbledRound = (words) => {
  const list = Array.isArray(words) && words.length ? words : ['hangout'];
  const word = pick(list);
  let scrambled = word;
  let guard = 0;
  while (scrambled === word && guard++ < 10) scrambled = shuffle(word.split('')).join('');
  return { q: scrambled.toUpperCase(), a: word };
};

// ── Trivia — questions live in ../config/trivia.json (add more anytime) ──
export const triviaRound = (bank) => {
  const list = Array.isArray(bank) && bank.length ? bank : null;
  return list ? pick(list) : null;
};

// Round counts per quiz-style game
export const ROUNDS_PER_GAME = 5;
