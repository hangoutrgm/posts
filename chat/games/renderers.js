// ============================================================
// chat/games/renderers.js — game-card bodies, cloned from the
// Hangout Posts game-card look (gradient shells, pills, boards).
// ============================================================
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { esc, GAME_META } from './helpers.js?v=6';

const me = () => getAuth().currentUser?.uid;
let _ctx = { getName: (uid) => uid };
export const setContext = (ctx) => { _ctx = { ..._ctx, ...ctx }; };
const nameOf = (uid) => _ctx.getName(uid) || 'Player';

/* ── Shared fragments ── */
const badgesHtml = (g) => {
  const ids = Object.keys(g.players || {});
  const mk = (uid2, emoji, cls) =>
    `<span class="cg-badge ${cls}">${emoji} @${esc(nameOf(uid2))}${uid2 === g.hostId ? ' (Host)' : ''}</span>`;
  if (g.type === 'connect4') {
    // Three seats in join order: 🔴 host → 🟡 → 🟢
    const seats = [['R', '🔴', 'r'], ['Y', '🟡', 'y'], ['G', '🟢', 'g']].map(([m, e, c]) => {
      const u = ids.find((x) => g.players[x] === m);
      return u ? mk(u, e, c)
        : `<span class="cg-badge ${c}">${e} <span class="cg-open-slot">Open seat</span></span>`;
    });
    return `<div class="cg-badges">${seats.join('<span class="cg-vs">VS</span>')}</div>`;
  }
  if (ids.length >= 2) {
    return `<div class="cg-badges">${mk(ids[0], '❌', 'r')}<span class="cg-vs">VS</span>${mk(ids[1], '⭕', 'y')}</div>`;
  }
  const only = ids[0];
  return `<div class="cg-badges"><span class="cg-badge r">❌ @${esc(nameOf(only))} (Host)</span><span class="cg-vs">VS</span><span class="cg-badge y">⭕ <span class="cg-open-slot">Open Challenger</span></span></div>`;
};

const turnPill = (g, uid) => {
  if (g.status !== 'active' || !g.turn) return '';
  if (g.turn === uid) {
    let c;
    if (g.type === 'connect4') c = { R: 'Red 🔴', Y: 'Yellow 🟡', G: 'Green 🟢' }[g.players?.[uid]] || '';
    else c = g.players?.[uid] === 'X' ? 'Blue ❌' : 'Pink ⭕';
    return `<div class="cg-turn-mine">▶ YOUR TURN (${c})</div>`;
  }
  return `<div class="cg-turn-wait">Waiting for @${esc(nameOf(g.turn))}…</div>`;
};

const outcomePill = (g) => {
  if (g.status !== 'done') return '';
  if (g.winner === 'draw') return '<div class="cg-outcome draw">🤝 Draw Match!</div>';
  if (g.winner === 'tie') return '<div class="cg-outcome draw">🤝 Tie at the top!</div>';
  if (g.lost) return `<div class="cg-outcome lose">✖ Word was "${esc(g.word)}"</div>`;
  if (g.winner) return `<div class="cg-outcome win">🏆 ${esc(nameOf(g.winner))} won!</div>`;
  return '';
};

/* ── Tic-Tac-Toe ── */
const tttBody = (mid, g, uid) => {
  if (g.status === 'waiting') return '';
  const myTurn = g.status === 'active' && g.turn === uid;
  const cells = (g.board || []).map((v, i) => {
    const can = myTurn && !v;
    return `<button type="button" class="cg-tcell ${v ? 'mark-' + v : ''} ${can ? 'can' : ''}"
      ${can ? `onclick="window.ChatGames.move('${mid}',${i})"` : 'disabled'}>${v || '_'}</button>`;
  }).join('');
  return `<div style="width:100%;">${turnPill(g, uid)}<div class="cg-ttt">${cells}</div></div>`;
};

/* ── Connect 4 ── */
const c4Body = (mid, g, uid) => {
  if (g.status === 'waiting') return '';
  const myTurn = g.status === 'active' && g.turn === uid;
  const board = g.board || [];
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const col = i % 7;
    const v = board[i];
    const can = myTurn && !board[col];
    const disc = v ? `<div class="cg-disc ${v}"></div>` : '<div class="cg-disc empty"></div>';
    cells += `<div class="cg-cellwrap ${can ? 'can' : ''}" ${can ? `onclick="window.ChatGames.move('${mid}',${col})"` : ''}>${disc}</div>`;
  }
  return `<div style="width:100%;">${turnPill(g, uid)}<div class="cg-c4board">${cells}</div></div>`;
};

// ── Hangman (gameplay cloned from Hangout Posts) ──
const hangmanBody = (mid, g, uid) => {
  const word = String(g.word || '');
  const guessed = g.guessed || {};
  const isHost = uid === g.hostId;

  if (['done', 'closed'].includes(g.status)) {
    return `<div class="cg-ended-box">
      <div class="cg-host-pill" style="margin-bottom:4px;">Word was: <b>${esc(word)}</b></div>
      ${g.winner ? `<div class="cg-winner-pill"><span class="cg-winner-icon">🏆</span><div class="cg-winner-text"><strong>${esc(nameOf(g.winner))}</strong><span>Solved Hangman!</span></div></div>` : '<div class="cg-note">Hangman Ended</div>'}
    </div>`;
  }

  const blanks = [...word].map((ch) => ch === ' '
    ? '<span style="width:6px;"></span>'
    : `<span class="cg-blank ${guessed[ch] === 'hit' ? 'hit' : ''}">${guessed[ch] === 'hit' ? esc(ch) : '_'}</span>`).join('');
  // Wrong letters: live games track wrongLetters[] · legacy games stored misses in guessed{}
  const wrongs = g.wrongLetters
    ? g.wrongLetters
    : Object.entries(guessed).filter(([, v]) => v === 'miss').map(([l]) => l);
  const maxFails = g.maxFails || 2;
  const letterLeft = Math.max(0, maxFails - Number((g.letterFails || {})[uid] || 0));
  const wordLeft = Math.max(0, maxFails - Number((g.wordFails || {})[uid] || 0));
  const keys = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((L) => {
    const hit = guessed[L] === 'hit';
    const missed = wrongs.includes(L);
    const dis = Boolean(hit || missed) || g.status !== 'active' || isHost || letterLeft === 0;
    return `<button type="button" class="cg-key ${hit ? 'hit' : missed ? 'miss' : ''}" ${dis ? 'disabled' : `onclick="window.ChatGames.guessLetter('${mid}','${L}')"`}>${L}</button>`;
  }).join('');

  const missesHtml = wrongs.length
    ? `<div class="cg-wrong-row">❌ ${wrongs.map((l) => `<span class="cg-chip-miss">${esc(l)}</span>`).join('')}</div>`
    : '';
  const hostPill = isHost
    ? `<div class="cg-host-pill">Word: <b>${esc(word)}</b></div>`
    : '';
  const livesPill = !isHost
    ? `<div class="cg-lives">🅰️ <b>${letterLeft}</b> · 🔠 <b>${wordLeft}</b> left</div>`
    : '';
  const wordForm = !isHost
    ? `<form class="cg-inputrow" onsubmit="event.preventDefault();const el=this.querySelector('input');
        window.ChatGames.guessWord('${mid}',el.value); el.value='';">
        <input type="text" autocomplete="off" placeholder="Guess full word…">
        <button type="submit" class="cg-go">Go</button></form>`
    : '';

  return `<div class="cg-hm-wrap">
    ${missesHtml}
    <div class="cg-blanks">${blanks}</div>
    ${hostPill}
    ${livesPill}
    <div class="cg-keys">${keys}</div>
    ${wordForm}
  </div>`;
};

// ── Quiz family (trivia / flags / math / jumbled / gibberish / emoji riddle / count the emojis) ──
const quizBody = (mid, g, uid) => {
  const idx = Number(g.revealed || 0);
  const round = (g.rounds || [])[idx];
  if (!round) return '<p class="cg-note">No rounds available</p>';
  
  if (['done', 'closed'].includes(g.status)) {
    const sub = g.raceTo ? `Reached ${g.raceTo} pts first!` : 'Won the game!';
    return `<div class="cg-ended-box">
      ${g.winner ? `<div class="cg-winner-pill"><span class="cg-winner-icon">🏆</span><div class="cg-winner-text"><strong>${esc(nameOf(g.winner))}</strong><span>${sub}</span></div></div>` : '<div class="cg-note">Game Ended</div>'}
    </div>`;
  }

  // Intermission / Cooldown between rounds (3s timer: 3, 2, 1)
  const isCooldown = Boolean(g.nextRoundAt && Number(g.nextRoundAt) > Date.now());
  if (isCooldown) {
    const solverUid = g.roundWinner || g.solved?.[idx];
    const diffSec = Math.max(1, Math.ceil((Number(g.nextRoundAt) - Date.now()) / 1000));
    return `<div class="cg-cooldown-box" data-mid="${esc(mid)}">
      <div class="cg-cd-solver">
        <span class="cg-cd-check">✅</span>
        <div class="cg-cd-solver-info">
          <strong>@${esc(nameOf(solverUid))}</strong>
          <span>Got it right! (+1 pt)</span>
        </div>
      </div>
      <div class="cg-cd-timer">
        <span>Next round in <b class="cg-cd-sec" data-until="${g.nextRoundAt}">${diffSec}</b>s…</span>
        <div class="cg-cd-track"><div class="cg-cd-fill"></div></div>
      </div>
    </div>`;
  } else if (g.nextRoundAt && Date.now() >= Number(g.nextRoundAt)) {
    // Expired timer fallback
    if (window.ChatGames?.advanceRound) {
      window.ChatGames.advanceRound(mid, idx);
    }
  }

  let promptHtml = '';
  if (round.choices) {
    // Wrong-choice lockout: once YOU clicked a wrong choice this round, your buttons disable
    const lockedOut = Boolean(((g.attempts || {})[idx] || {})[uid]);
    promptHtml = `<div class="cg-choice-grid">
      ${round.choices.map((ch) => `<button type="button" class="cg-choice" ${lockedOut ? 'disabled style="opacity:.45;cursor:default;"' : `onclick="window.ChatGames.guess('${mid}',this.textContent)"`}>${esc(ch)}</button>`).join('')}</div>
      ${lockedOut ? '<p class="cg-note">❌ You picked wrong — sit this round out!</p>' : ''}`;
  } else {
    promptHtml = `<form class="cg-inputrow" onsubmit="event.preventDefault();const el=this.querySelector('input');
      window.ChatGames.guess('${mid}',el.value); el.value='';">
      <input type="text" autocomplete="off" placeholder="Your answer…">
      <button type="submit" class="cg-go">Go</button></form>`;
  }

  let media = '';
  if (round.code) {
    media = `<div class="cg-flag-box"><img class="cg-flag" src="https://flagcdn.com/w160/${esc(round.code)}.png" alt="flag"></div>`;
  } else if (round.emojis) {
    media = `<div class="cg-emoji-banner">${esc(round.emojis)}</div>`;
  } else if (round.grid) {
    media = `<div class="cg-dots">${round.grid.map((c) =>
      `<span class="${c === '·' ? 'dim' : ''}">${c === '·' ? '·' : c}</span>`).join('')}</div>`;
  } else if (g.type === 'jumbled') {
    media = `<div class="cg-jumble-box"><span class="cg-jumble-label">UNSCRAMBLE</span><div class="cg-jumble-word">${esc(round.q || '')}</div></div>`;
  } else if (round.q) {
    media = `<div class="cg-prompt">${esc(round.q)}</div>`;
  }

  return `<div class="cg-quiz-wrap">${media}${promptHtml}</div>`;
};

// ── First to Mine — one big tap, first player wins (cloned from Hangout Posts) ──
const mineBody = (mid, g) => {
  if (g.status !== 'done') {
    return `<button type="button" class="cg-mine-btn" onclick="window.ChatGames.mine('${mid}')">💎 MINE!</button>
      <div class="cg-note">First to tap wins! (Hosts can't mine their own)</div>`;
  }
  return `<div class="cg-winner-pill">
    <span class="cg-winner-icon">💖</span>
    <div class="cg-winner-text">
      <strong class="cg-winner-name">${esc(nameOf(g.winner))}</strong>
      <span class="cg-winner-sub">mined it first!</span>
    </div>
  </div>`;
};

// ── Status fragments ──
const waitingJoin = (g, uid) => {
  const seated = Object.keys(g.players || {}).length;
  if (uid === g.hostId) {
    // Connect-4 seats three, but the host can start as soon as two have joined
    if (g.type === 'connect4' && seated >= 2) {
      return `<button type="button" class="cg-btn-join" onclick="window.ChatGames.start('${g._mid}')">▶ Start now (${seated}/3)</button>
        <div class="cg-note">Or keep waiting for a third player.</div>`;
    }
    return `<div class="cg-note">⏳ Waiting for challenger…${g.type === 'connect4' ? ` (${seated}/3)` : ''}</div>`;
  }
  if (g.players?.[uid]) return '<div class="cg-note">⏳ Waiting for the table to fill…</div>';
  return `<button type="button" class="cg-btn-join" onclick="window.ChatGames.join('${g._mid}')">🎮 Accept Challenge & Join</button>`;
};

const scoreFooter = (g) => {
  const entries = Object.entries(g.finalScores || g.scores || {});
  if (!entries.length) return '';
  return `<div class="cg-scores">${entries.map(([u, s]) =>
    `<span>${esc(nameOf(u))}: <b>${s}</b></span>`).join('')}</div>`;
};

// ── Dispatcher: full game-card body for a message ──
const SHELL = {
  tictactoe: 'cg-indigo', connect4: 'cg-blue', hangman: 'cg-rose',
  first_to_mine: 'cg-fuchsia', gibberish: 'cg-amber', trivia: 'cg-indigo',
  flags: 'cg-indigo', math: 'cg-indigo', jumbled: 'cg-indigo',
  emojiriddle: 'cg-indigo', countemoji: 'cg-indigo', guessemoji: 'cg-amber',
  bringmeemoji: 'cg-emerald', periodic: 'cg-indigo',
};

export const renderBody = (msg) => {
  const g = msg.game || {};
  const mid = msg.id;
  const uid = me();
  g._mid = mid;
  const meta = GAME_META[g.type] || { name: 'Game', icon: '🎮' };
  let body = '';
  switch (g.type) {
    case 'tictactoe': body = badgesHtml(g) + tttBody(mid, g, uid); break;
    case 'connect4': body = badgesHtml(g) + c4Body(mid, g, uid); break;
    case 'hangman': body = hangmanBody(mid, g, uid); break;
    case 'first_to_mine': body = mineBody(mid, g, uid); break;
    default: body = quizBody(mid, g, uid);
  }
  const isEnded = ['done', 'closed'].includes(g.status);
  const shell = isEnded ? 'cg-ended' : (SHELL[g.type] || 'cg-indigo');
  const title = isEnded ? `${meta.icon} ${meta.name} Ended` : `${meta.icon} ${meta.name}`;
  
  // Header badge for raceTo / multi-round games
  let roundBadge = '';
  if (!isEnded) {
    if (g.raceTo) {
      roundBadge = `<span class="cg-round-pill">Race to ${g.raceTo}</span>`;
    } else if ((g.rounds || []).length > 1) {
      roundBadge = `<span class="cg-round-pill">R${(Number(g.revealed || 0) + 1)}/${g.rounds.length}</span>`;
    }
  }
  
  const isMultiRound = Array.isArray(g.rounds) && g.rounds.length > 1;
  const skipBtn = (uid === g.hostId && !isEnded && isMultiRound)
    ? `<button type="button" class="cg-skip-link" onclick="window.ChatGames.skip('${mid}')" title="Skip this question">⏭️ skip</button>` : '';

  const closeBtn = (uid === g.hostId && !isEnded)
    ? `<button type="button" class="cg-close-link" onclick="window.ChatGames.close('${mid}')">close</button>` : '';

  return `<div class="chat-game-card">
    <div class="cg-card ${shell}">
      <div class="cg-header">
        <span class="cg-title">${title}</span>
        <div class="cg-header-right">
          ${roundBadge}
          ${skipBtn}
          ${closeBtn}
        </div>
      </div>
      ${body}
      ${outcomePill(g)}
      ${g.status === 'waiting' ? waitingJoin(g, uid) : ''}
      ${scoreFooter(g)}
    </div>
  </div>`;
};

// ── Game picker sheet HTML (injected into a dialog by index.js) ──
export const pickerHtml = () => `<div class="cg-picker-grid">
  ${Object.entries(GAME_META).map(([type, m]) => `
    <button type="button" class="cg-pick-card" data-type="${type}">
      <span class="cg-pick-icon-wrap">${m.icon}</span>
      <span class="cg-pick-info">
        <span class="cg-pick-name">${esc(m.name)}</span>
        <span class="cg-pick-hint">${esc(m.hint || '')}</span>
      </span>
    </button>`).join('')}
</div>`;





