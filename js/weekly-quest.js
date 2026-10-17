// weekly-quest.js — Weekly Quest (Quest modal → Weekly tab)
// ============================================================
// A per-ISO-week checklist (reactions received, valid chat-game
// wins, valid recruits claimed, pet level-ups, songs added) that
// pays LB + ₱ on claim. Shares the Daily Quest's #quest-modal as a
// third tab (Today · History · Weekly): js/quest.js owns the modal
// + tab plumbing and calls mountWeeklyQuestPane / unmountWeekly-
// QuestPane; this module owns only the Weekly pane and its data.
//
// DATA (RTDB 3, database3.rules.json → /weekly_quests):
//   /weekly_quests/{YYYY-Www}/{uid} = {
//     p: { reactsReceived, chatWins, recruits, petLevels, songsAdded },
//     t: { <metric>: { <dedupeKey>: true } },
//     claimedAt: <ms>
//   }
// Requests to db3 arrive UNAUTHENTICATED (app3's Auth is never
// signed in), so — same "open + client-side guard" convention as
// /quests and /recruits — writes only happen after the primary
// project's Auth resolves a signed-in (non-anonymous) account.
//
// CONFIG lives in RTDB 1 /settings/weeklyQuests (admin /config →
// Weekly Quest) and reaches us through the window.siteSettings
// mirror (js/main.js). Shape:
//   { enabled, reqReactsReceived, reqChatWins, reqRecruits,
//     reqPetLevels, reqSongsAdded, lbReward, moneyReward }
// A requirement of 0 hides that quest line; moneyReward (₱) is
// hidden at 0 and, on claim, logged to RTDB 3 /earnings via
// window.logMoneyRewardClaim (js/quest.js) — admin funds it by hand.
//
// CLAIM: an RTDB transaction on the week record (mirrors
// claimDailyQuest / claimRecruitReward) so a double-click, a
// second tab or a stale modal can never pay twice. The payout
// credits users/{uid}/lbPoints + the daily/weekly/monthly buckets
// via window.creditLbPeriods (js/games.js).
//
// PROGRESS WRITERS:
//  - posts app: window.weeklyQuestTrack() — reactions received,
//    valid recruits (js/main.js).
//  - chat: inline write in chat/games/engine.js maybeAwardLb.
//  - music: inline write in music/music-app.js addToLibrary.
//  - pet: window.PetCloud.weeklyQuest() bridge (pet/pet.js).
// Cross-app writers are inline because those pages never import
// this module (would evaluate firebase-config.js twice).
//
// No history tab / no auto-prune: only the CURRENT week is ever
// read (there is no past-week view to support), so old records
// stay inert and are never fetched.
// ============================================================
import { auth, db, db3 } from './firebase-config.js';
import { ref, onValue, get, set, update, increment, runTransaction } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

// ISO year-week key (Mon–Sun) — byte-identical to window.lbWeekKey
// (js/games.js) and lbWeekKey (chat/games/engine.js) so every
// writer lands on the same bucket. Defined locally because this
// module must not depend on games.js.
const weekKey = (d = new Date()) => {
    const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = date.getDay() === 0 ? 6 : date.getDay() - 1; // Mon=0 .. Sun=6
    const thursday = new Date(date);
    thursday.setDate(date.getDate() - day + 3);
    const jan1 = new Date(thursday.getFullYear(), 0, 1, 12);
    const week = Math.ceil((((thursday - jan1) / 86400000) + jan1.getDay() + 1) / 7);
    return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
};

// metric key → admin settings key + modal presentation.
const WEEKLY_METRICS = [
    { key: 'reactsReceived', reqKey: 'reqReactsReceived', icon: 'fa-heart',     label: 'Reactions received' },
    { key: 'chatWins',       reqKey: 'reqChatWins',       icon: 'fa-gamepad',   label: 'Chat games won (with LB)' },
    { key: 'recruits',       reqKey: 'reqRecruits',       icon: 'fa-user-plus', label: 'Valid recruits claimed' },
    { key: 'petLevels',      reqKey: 'reqPetLevels',      icon: 'fa-paw',       label: 'Pet level-ups' },
    { key: 'songsAdded',     reqKey: 'reqSongsAdded',     icon: 'fa-music',     label: 'Songs added to Music' },
];

const WEEKLY_DEFAULTS = {
    enabled: true,
    reqReactsReceived: 50, reqChatWins: 50, reqRecruits: 2, reqPetLevels: 10, reqSongsAdded: 10,
    lbReward: 5000,     // LB points paid on claim (all-time + daily/weekly/monthly)
    moneyReward: 5,     // ₱ shown next to the reward (DISPLAY-ONLY; 0 = hidden)
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Live config = hardcoded defaults overlaid with the admin's /settings/weeklyQuests.
window.weeklyQuestConfig = () => {
    const q = { ...WEEKLY_DEFAULTS, ...(window.siteSettings && window.siteSettings.weeklyQuests ? window.siteSettings.weeklyQuests : {}) };
    const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fb; };
    return {
        enabled: q.enabled !== false,
        reqReactsReceived: num(q.reqReactsReceived, WEEKLY_DEFAULTS.reqReactsReceived),
        reqChatWins: num(q.reqChatWins, WEEKLY_DEFAULTS.reqChatWins),
        reqRecruits: num(q.reqRecruits, WEEKLY_DEFAULTS.reqRecruits),
        reqPetLevels: num(q.reqPetLevels, WEEKLY_DEFAULTS.reqPetLevels),
        reqSongsAdded: num(q.reqSongsAdded, WEEKLY_DEFAULTS.reqSongsAdded),
        lbReward: num(q.lbReward, WEEKLY_DEFAULTS.lbReward),
        moneyReward: num(q.moneyReward, WEEKLY_DEFAULTS.moneyReward),
    };
};

// Active quest lines = requirements greater than 0.
const activeWeeklyLines = (cfg) => WEEKLY_METRICS
    .map((m) => ({ ...m, req: Number(cfg[m.reqKey]) || 0 }))
    .filter((m) => m.req > 0);

const weeklyQuestUid = () => {
    const u = window.currentUser || null;
    if (!u || !u.uid) return null;
    // Anonymous guest sign-ins never earn quests (real accounts only).
    if (auth.currentUser && auth.currentUser.isAnonymous) return null;
    return u.uid;
};

// Firestore doc ids are RTDB-safe, but never trust external ids as keys.
const safeKey = (s) => String(s || '').replace(/[.#$[\]/]/g, '_').slice(0, 128);

// ── Progress tracking ───────────────────────────────────────────────────────
// Fire-and-forget, same bandwidth discipline as daily questTrack.
// `targetUid` is WHO gets the credit — it can differ from the actor (a
// reaction RECEIVED credits the author, not the reactor). A dedupeKey
// routes through a marker transaction so react/unreact toggling (or any
// repeat) can never double-count; without one it's a plain increment.
// The acting user must be signed-in and non-anonymous — mirrors questUid.
window.weeklyQuestTrack = (metric, targetUid, dedupeKey) => {
    const actor = weeklyQuestUid();
    if (!actor) return;                    // guest / signed-out → no credit
    if (!targetUid || targetUid === 'undefined') return;
    if (!WEEKLY_METRICS.some((m) => m.key === metric)) {
        console.warn(`weeklyQuestTrack: unknown metric "${metric}" — not tracked`);
        return;
    }
    const weekRef = `weekly_quests/${weekKey()}/${targetUid}`;
    if (dedupeKey) {
        // ONE atomic transaction writes marker + counter together: a
        // react/unreact toggle can never double-count, and the record
        // always contains p so it satisfies the /weekly_quests .validate
        // whatever order writes arrive in.
        runTransaction(ref(db3, weekRef), (cur) => {
            const rec = (cur && typeof cur === 'object') ? cur : {};
            const t = rec.t || {};
            const bucket = t[metric] || {};
            const key = safeKey(dedupeKey);
            if (bucket[key]) return undefined;   // already counted
            bucket[key] = true;
            const p = rec.p || {};
            p[metric] = Number(p[metric] || 0) + 1;
            return { ...rec, t: { ...t, [metric]: bucket }, p };
        }).catch((e) => console.warn('weekly quest track error:', e));
        return;
    }
    update(ref(db3, `${weekRef}/p`), { [metric]: increment(1) })
        .catch((e) => console.warn('weekly quest track error:', e));
};

// ── Modal helpers ───────────────────────────────────────────────────────────
let _wqUnsub = null;

const weeklySnapshot = (snap) => {
    const v = snap && snap.exists() ? snap.val() || {} : {};
    return { p: v.p || {}, claimedAt: Number(v.claimedAt) || 0 };
};

const weeklyAllDone = (cfg, p) => {
    const lines = activeWeeklyLines(cfg);
    return lines.length > 0 && lines.every((m) => Number(p[m.key] || 0) >= m.req);
};

// True when this week is complete but unclaimed. js/quest.js's shared
// account-menu dot (window.updateQuestDot) ORs this in, so the single
// Quest row lights up when EITHER the daily or the weekly reward is ready.
window.weeklyQuestIsReady = async () => {
    const uid = weeklyQuestUid();
    const cfg = window.weeklyQuestConfig();
    if (!uid || !cfg.enabled) return false;
    try {
        const snap = await get(ref(db3, `weekly_quests/${weekKey()}/${uid}`));
        const s = weeklySnapshot(snap);
        return !s.claimedAt && weeklyAllDone(cfg, s.p);
    } catch (_) { return false; }
};
// s = normalized { p, claimedAt } (weeklySnapshot output or the copy from
// the localStorage cache) — null paints the empty state. Callers normalize:
// the live listener wraps its snap, the instant paint passes the cached copy.
const paintWeeklyPane = (sIn) => {
    const cfg = window.weeklyQuestConfig();
    const s = sIn || { p: {}, claimedAt: 0 };

    const dateEl = document.getElementById('weekly-quest-date-label');
    if (dateEl) {
        dateEl.textContent = (window.lbPeriodLabel
            ? window.lbPeriodLabel('weekly', weekKey())
            : weekKey());
    }

    // Reward banner — ₱ money is display-only and fully hidden at 0.
    const lbEl = document.getElementById('weekly-quest-info-lb');
    if (lbEl) lbEl.textContent = Number(cfg.lbReward || 0).toLocaleString();
    const moneyWrap = document.getElementById('weekly-quest-info-money-wrap');
    const moneyEl = document.getElementById('weekly-quest-info-money');
    if (moneyWrap && moneyEl) {
        moneyWrap.classList.toggle('hidden', !(cfg.moneyReward > 0));
        moneyEl.textContent = Number(cfg.moneyReward || 0).toLocaleString();
    }

    const list = document.getElementById('weekly-quest-list');
    if (list) {
        const lines = activeWeeklyLines(cfg);
        if (lines.length === 0) {
            list.innerHTML = `<p class="text-[11px] text-gray-400 dark:text-gray-500 text-center py-6">No active weekly quests this week. Check back next week!</p>`;
        } else {
            list.innerHTML = lines.map((m) => {
                const cur = Math.min(Number(s.p[m.key] || 0), m.req);
                const done = cur >= m.req;
                const pct = Math.round((cur / m.req) * 100);
                return `
                <div class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border ${done
                    ? 'border-green-200 dark:border-green-500/30 bg-green-50/60 dark:bg-green-500/[0.06]'
                    : 'border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50'}">
                    <i class="fa-solid ${m.icon} w-4 text-center text-sm ${done ? 'text-green-500' : 'text-gray-400'}"></i>
                    <span class="flex-1 min-w-0">
                        <span class="block text-[11px] font-bold text-gray-800 dark:text-gray-200">${esc(m.label)}</span>
                        <span class="block mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-slate-700 overflow-hidden">
                            <span style="width:${pct}%" class="block h-full ${done ? 'bg-green-500' : 'bg-blue-500'} transition-all"></span>
                        </span>
                    </span>
                    <span class="text-[10px] font-black text-gray-500 dark:text-gray-400 tabular-nums">${cur}/${m.req}</span>
                    ${done ? '<i class="fa-solid fa-circle-check text-green-500"></i>' : ''}
                </div>`;
            }).join('');
        }
    }

    // Claim button states: claimed ✓ / ready / in progress.
    const btn = document.getElementById('weekly-quest-claim-btn');
    if (btn) {
        const allDone = weeklyAllDone(cfg, s.p);
        if (s.claimedAt) {
            btn.disabled = true;
            btn.className = 'mt-3 shrink-0 w-full py-2 rounded-lg text-xs font-black bg-green-500/15 text-green-600 dark:text-green-400 border border-green-500/30 cursor-default transition';
            btn.textContent = 'Claimed ✓';
        } else if (allDone) {
            btn.disabled = false;
            btn.className = 'mt-3 shrink-0 w-full py-2 rounded-lg text-xs font-black bg-blue-600 text-white hover:bg-blue-500 shadow-sm transition';
            btn.textContent = cfg.lbReward > 0 ? `Claim ${Number(cfg.lbReward).toLocaleString()} LB` : 'Claim Reward';
        } else {
            btn.disabled = true;
            btn.className = 'mt-3 shrink-0 w-full py-2 rounded-lg text-xs font-black bg-gray-100 dark:bg-slate-700 text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-slate-600 cursor-not-allowed transition';
            btn.textContent = 'Complete all quests to claim';
        }
    }

    // The account-menu dot is deliberately NOT refreshed here: the menu (its
    // only home) is closed on every one of these paints, and each refresh
    // costs 1–2 reads — closeQuestModal + the nav-avatar hook keep it fresh.
};

// The Weekly pane lives inside the shared #quest-modal (js/quest.js owns the
// modal + tab plumbing and calls these). Mount = paint + live listener;
// unmount = drop the listener (bandwidth discipline, same as the History tab).
window.mountWeeklyQuestPane = () => {
    const uid = weeklyQuestUid();
    if (!uid) return;
    if (_wqUnsub) { _wqUnsub(); _wqUnsub = null; }
    // 1) Instant paint from the localStorage cache (quest.js exposes the
    //    helper) — never wait on the network.
    // 2) The listener below IS the revalidation ("update every open"): it
    //    fires immediately on attach, repaints, rewrites the cache.
    const wk = weekKey();
    paintWeeklyPane(window.questCacheRead ? window.questCacheRead('weekly', `${uid}:${wk}`) : null);
    _wqUnsub = onValue(ref(db3, `weekly_quests/${wk}/${uid}`), (snap) => {
        const s = weeklySnapshot(snap);
        if (window.questCacheWrite) window.questCacheWrite('weekly', `${uid}:${wk}`, s);
        paintWeeklyPane(s);
    }, (e) => console.warn('weekly quest listener error:', e));
};

window.unmountWeeklyQuestPane = () => {
    if (_wqUnsub) { _wqUnsub(); _wqUnsub = null; }
};

// ── Claim ───────────────────────────────────────────────────────────────────
window._claimingWeeklyQuest = false;

// Claim this week's reward. Atomic: the transaction re-reads the live record
// and re-verifies every counter, so a double-click, a second tab or a stale
// modal can never pay twice — same pattern as window.claimDailyQuest.
window.claimWeeklyQuest = async () => {
    const uid = weeklyQuestUid();
    if (!uid || window._claimingWeeklyQuest) return;
    const cfg = window.weeklyQuestConfig();
    const lines = activeWeeklyLines(cfg);
    if (lines.length === 0) { window.showToast && window.showToast('No active weekly quests this week.'); return; }

    window._claimingWeeklyQuest = true;
    const btn = document.getElementById('weekly-quest-claim-btn');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    try {
        const res = await runTransaction(ref(db3, `weekly_quests/${weekKey()}/${uid}`), (cur) => {
            if (!cur) return undefined;                 // nothing tracked yet
            if (cur.claimedAt) return undefined;        // already paid
            const p = cur.p || {};
            for (const m of lines) {
                if (Number(p[m.key] || 0) < m.req) return undefined; // not complete
            }
            return { ...cur, claimedAt: Date.now() };
        });

        if (!res.committed) {
            window.showToast && window.showToast('Weekly Quest is not complete yet — keep going!');
            return;
        }

        // Credit ALL four LB buckets: overall (users/{uid}/lbPoints) + the
        // daily/weekly/monthly period counters.
        if (cfg.lbReward > 0) {
            set(ref(db, `users/${uid}/lbPoints`), increment(cfg.lbReward));
            if (window.creditLbPeriods) window.creditLbPeriods(uid, cfg.lbReward);
        }
        // ₱ reward (admin-funded): one earnings row for the claimer + one in the
        // admin's HOST LOG (Treasury → Hosted). Fire-and-forget; helper lives in js/quest.js.
        const moneyLogged = cfg.moneyReward > 0;
        if (moneyLogged && window.logMoneyRewardClaim) {
            window.logMoneyRewardClaim(uid, window.globalUsersCache?.[uid]?.name || 'Member', 'Weekly Quest Reward', cfg.moneyReward);
        }
        window.showToast && window.showToast(`Weekly Quest claimed! +${Number(cfg.lbReward || 0).toLocaleString()} LB credited.${moneyLogged ? ` ₱${Number(cfg.moneyReward).toLocaleString()} logged to Earnings.` : ''} 🎉`);
    } catch (e) {
        console.warn('Weekly quest claim failed:', e);
        window.showToast && window.showToast('Claim failed — please try again.');
    } finally {
        if (btn) btn.innerHTML = originalHtml;
        window._claimingWeeklyQuest = false;
    }
};

// ── Visibility ──────────────────────────────────────────────────────────────
// The Weekly tab is hidden while the admin toggle is off (missing = enabled).
// Tiny listener on one leaf node — cheap enough to keep always-on.
onValue(ref(db, 'settings/weeklyQuests/enabled'), (snap) => {
    const tab = document.getElementById('quest-tab-weekly');
    if (tab) tab.classList.toggle('hidden', snap.val() === false);
}, () => {});
