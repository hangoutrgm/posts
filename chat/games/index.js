// ============================================================
// chat/games/index.js — public API + picker wiring
// Exposes window.ChatGames used by app.js and inline onclicks.
// ============================================================
import * as engine from './engine.js?v=20';
import { renderBody, pickerHtml, setContext } from './renderers.js?v=21';
import { GAME_META } from './helpers.js?v=6';

let _getThreadId = () => null;
let _toast = (m) => console.log('[ChatGames]', m);

const ensureThread = () => {
  const t = _getThreadId();
  if (!t) _toast('Open a conversation first.');
  return t;
};

// ── Picker dialog ──
let _pickerEl = null;
const openPicker = () => {
  if (!ensureThread()) return;
  if (!_pickerEl) {
    _pickerEl = document.createElement('dialog');
    _pickerEl.id = 'chat-games-picker';
    _pickerEl.className = 'dialog cg-picker-dialog';
    _pickerEl.innerHTML = `
      <div class="dialog-card cg-picker-card">
        <header class="dialog-header">
          <div class="dialog-header-icon accent-icon">
            <svg viewBox="0 0 24 24"><polygon points="6 2 18 2 18 6 6 6 6 2"/><rect x="3" y="6" width="18" height="16" rx="2"/><circle cx="12" cy="14" r="3"/></svg>
          </div>
          <h2 style="flex:1;margin:0;font-size:17px;font-weight:800;">Choose a Game</h2>
          <button class="dialog-close-btn cg-close" type="button" aria-label="Close">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>
        <div class="cg-picker-scroll">
          ${pickerHtml()}
        </div>
        <p class="cg-picker-footer">🎮 Games are played directly in chat — challenge your friends!</p>
      </div>`;
    document.body.appendChild(_pickerEl);
    _pickerEl.querySelector('.cg-close')?.addEventListener('click', () => _pickerEl.close());
    _pickerEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.cg-pick-card, .cg-pick');
      if (!btn) return;
      const type = btn.dataset.type;
      _pickerEl.close();
      // Route through the public wrapper so cooldown/errors surface as friendly toasts.
      try { await window.ChatGames.create(type); } catch (err) { console.error(err); }
    });
  }
  _pickerEl.showModal();
};

// ── Direct-answer wrapper: host closes setup modal = cancelled (handled in engine) ──
const hangmanSetup = () => new Promise((resolve) => {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog cg-picker-dialog';
  dlg.innerHTML = `
    <div class="dialog-card cg-picker-card">
      <header class="dialog-header">
        <div class="dialog-header-icon accent-icon">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><text x="7" y="17" font-size="11" font-weight="800" fill="#fff">A?</text></svg>
        </div>
        <h2 style="flex:1;margin:0;font-size:17px;font-weight:800;">Hangman Setup</h2>
        <button class="dialog-close-btn cg-hm-cancel" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div style="padding:8px 4px 4px;text-align:left;">
        <label class="cg-hm-label">Secret word (letters & spaces only)</label>
        <input id="cg-hm-word" class="cg-hm-input" maxlength="30" autocomplete="off" spellcheck="false" placeholder="e.g. PHILIPPINES">
        <label class="cg-hm-label">Reveal starting letters — optional (comma separated)</label>
        <input id="cg-hm-clues" class="cg-hm-input" maxlength="25" autocomplete="off" spellcheck="false" placeholder="e.g. P, I, N">
        <p class="cg-picker-footer">🪓 Each player gets 2 wrong letter guesses + 2 wrong whole-word guesses.</p>
      </div>
      <div class="cg-hm-actions">
        <button type="button" class="cg-btn cg-hm-cancel">Cancel</button>
        <button type="button" class="cg-btn green cg-hm-start">Start Game</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const done = (val) => { try { dlg.close(); } catch (_) {} dlg.remove(); resolve(val); };
  dlg.querySelectorAll('.cg-hm-cancel').forEach((b) => b.addEventListener('click', () => done(null)));
  dlg.querySelector('.cg-hm-start')?.addEventListener('click', () => {
    const word = dlg.querySelector('#cg-hm-word').value;
    const clues = dlg.querySelector('#cg-hm-clues').value;
    if (!/^[A-Za-z][A-Za-z ]{1,29}$/.test(word.trim())) { _toast('Word must be 2-30 letters (no numbers/symbols).'); return; }
    done({ word: word.trim(), clues });
  });
  dlg.addEventListener('cancel', () => done(null)); // Esc key
  dlg.showModal();
  setTimeout(() => dlg.querySelector('#cg-hm-word')?.focus(), 50);
});
engine.setHostInputs({ hangman: hangmanSetup });

// ── Gibberish setup modal — host types the nonsense phrase + the real answer ──
const gibberishSetup = () => new Promise((resolve) => {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog cg-picker-dialog';
  dlg.innerHTML = `
    <div class="dialog-card cg-picker-card">
      <header class="dialog-header">
        <div class="dialog-header-icon accent-icon">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 10h8M8 14h5"/></svg>
        </div>
        <h2 style="flex:1;margin:0;font-size:17px;font-weight:800;">Gibberish Setup</h2>
        <button class="dialog-close-btn cg-gb-cancel" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>
      <div style="padding:8px 4px 4px;text-align:left;">
        <label class="cg-hm-label">Your nonsense phrase</label>
        <input id="cg-gb-phrase" class="cg-hm-input" maxlength="60" autocomplete="off" placeholder='e.g. Hue Can Knot Paws'>
        <label class="cg-hm-label">The real answer (players must guess this)</label>
        <input id="cg-gb-answer" class="cg-hm-input" maxlength="60" autocomplete="off" placeholder="e.g. You cannot pass">
        <p class="cg-picker-footer">🗣️ Say it out loud — first to decode it wins the round!</p>
      </div>
      <div class="cg-hm-actions">
        <button type="button" class="cg-btn cg-gb-cancel">Cancel</button>
        <button type="button" class="cg-btn green cg-gb-start">Start Game</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  const done = (val) => { try { dlg.close(); } catch (_) {} dlg.remove(); resolve(val); };
  dlg.querySelectorAll('.cg-gb-cancel').forEach((b) => b.addEventListener('click', () => done(null)));
  dlg.querySelector('.cg-gb-start')?.addEventListener('click', () => {
    const phrase = dlg.querySelector('#cg-gb-phrase').value.trim();
    const answer = dlg.querySelector('#cg-gb-answer').value.trim();
    if (!phrase || !answer) { _toast('Both the phrase and the answer are required.'); return; }
    done({ phrase, answer });
  });
  dlg.addEventListener('cancel', () => done(null)); // Esc key
  dlg.showModal();
  setTimeout(() => dlg.querySelector('#cg-gb-phrase')?.focus(), 50);
});
engine.setHostInputs({
  hangman: hangmanSetup,
  gibberish: gibberishSetup,
});


window.ChatGames = {
  /** Called once by chat app.js to provide context hooks. */
  init: ({ getThreadId, getName, toast, getSettings, isLbRewardsEnabled, notifySummary, ensureMessage }) => {
    if (typeof getThreadId === 'function') { _getThreadId = getThreadId; engine.setThreadGetter(getThreadId); }
    setContext({ getName });
    if (typeof toast === 'function') { _toast = toast; engine.setToast(toast); }
    if (typeof getSettings === 'function') engine.setSettingsGetter(getSettings);
    if (typeof isLbRewardsEnabled === 'function') engine.setLbRewardsChecker(isLbRewardsEnabled);
    if (typeof notifySummary === 'function') engine.setSummaryNotifier(notifySummary);
    if (typeof ensureMessage === 'function') engine.setEnsureMessage(ensureMessage);
  },
  openPicker,
  renderBody,
  create: async (type) => {
    if (!ensureThread()) return;
    try { await engine.createGame(type); }
    catch (err) {
      if (err && err.cooldownWait) {
        const s = err.cooldownWait;
        _toast(`⏳ Game cooldown — please wait ${s}${s === 1 ? ' second' : ' seconds'} before posting another game.`);
      } else if (err && err.limitMessage) {
        _toast(`🚫 ${err.limitMessage}`);
      } else if (err && (err.message === 'cancelled' || err === 'cancelled')) {
        // User closed the setup modal / prompt — silently cancel
      } else {
        console.error(err);
        _toast(`Could not start game: ${err?.message || 'unknown error'}`);
      }
    }
  },
  move: (mid, idx) => engine.playMove(mid, idx),
  join: (mid) => engine.joinGame(mid),
  start: (mid) => engine.startNow(mid),
  guessLetter: (mid, L) => engine.guessLetter(mid, L),
  guessWord: (mid, value) => engine.guessWord(mid, value),
  mine: async (mid) => {
    const r = await engine.mineNow(mid);
    if (r === 'host') _toast("You can't mine your own gem! 💎");
    else if (r === 'late') _toast('Too late — someone already mined it!');
  },
  guess: (mid, value) => engine.submitGuess(mid, value),
  advanceRound: (mid, expectedIdx) => engine.advanceRound(mid, expectedIdx),
  skip: (mid) => engine.skipRound(mid),
  close: (mid) => engine.closeGame(mid),
  getMeta: (type) => GAME_META[type] || { name: 'Game', icon: '🎮' },
  bump: (mid) => {
    if (typeof window.bumpGameMessage === 'function') window.bumpGameMessage(mid);
  },
};

// Active round cooldown live ticker (updates 3 -> 2 -> 1 without server re-render)
if (typeof window !== 'undefined' && !window._cgCooldownTicker) {
  window._cgCooldownTicker = setInterval(() => {
    const secs = document.querySelectorAll('.cg-cd-sec[data-until]');
    if (!secs.length) return;
    const now = Date.now();
    secs.forEach((el) => {
      const until = Number(el.dataset.until || 0);
      const remaining = Math.max(0, Math.ceil((until - now) / 1000));
      el.textContent = String(remaining || 1);
      if (now >= until) {
        const box = el.closest('[data-mid]');
        const mid = box?.dataset.mid;
        if (mid && window.ChatGames?.advanceRound) {
          window.ChatGames.advanceRound(mid);
        }
      }
    });
  }, 250);
}

export default window.ChatGames;
