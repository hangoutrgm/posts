// quest.js — Daily Quest (account menu → Quest)
// ============================================================
// A per-day checklist (general posts, reels, My Day, notes, hosted
// games, comments, reacts) that pays LB points on claim.
//
// DATA (RTDB 3, database3.rules.json → /quests):
//   /quests/{YYYY-MM-DD}/{uid} = {
//     p: { posts, reels, myday, notes, games, comments, reacts },  // counters
//     t: { react: { postId: true } },                              // react dedupe
//     claimedAt: <ms>                                              // set once via transaction
//   }
// Requests to db3 arrive UNAUTHENTICATED (app3's Auth is never signed in), so
// this follows the same "open with client-side guards" convention as /recruits:
// the client only writes after the primary project's Auth resolves a signed-in
// account and puts that uid in the path.
//
// CONFIG lives in RTDB 1 /settings/quests (admin /config → Daily Quest) and
// reaches us through the existing window.siteSettings mirror in main.js.
//   { enabled, reqPosts, reqReels, reqMyDay, reqNotes, reqGames,
//     reqComments, reqReacts, lbReward, moneyReward }
// A requirement of 0 disables that quest line; moneyReward is DISPLAY-ONLY
// (same convention as recruitPrizeReward) and is hidden when 0.
//
// CLAIM: an RTDB transaction on the day record (mirrors claimRecruitReward),
// so a double-click / second tab / stale modal can never pay twice. The payout
// credits users/{uid}/lbPoints + the daily/weekly/monthly buckets via
// window.creditLbPeriods (js/games.js).
// ============================================================
import { auth, db, db3 } from './firebase-config.js';
import { ref, onValue, get, set, update, increment, runTransaction, remove } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

// Same day-key format as window.lbDayKey (js/games.js) / gamePostCounts —
// defined locally because this module must not depend on games.js.
const questDayKey = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// metric key → admin settings key + modal presentation.
const QUEST_METRICS = [
    { key: 'posts',    reqKey: 'reqPosts',    icon: 'fa-pen',           label: 'General posts' },
    { key: 'reels',    reqKey: 'reqReels',    icon: 'fa-clapperboard',  label: 'Reels posts' },
    { key: 'myday',    reqKey: 'reqMyDay',    icon: 'fa-camera-retro',  label: 'My Day uploads' },
    { key: 'notes',    reqKey: 'reqNotes',    icon: 'fa-note-sticky',   label: 'Notes posted' },
    { key: 'games',    reqKey: 'reqGames',    icon: 'fa-gamepad',       label: 'Games hosted' },
    { key: 'answered', reqKey: 'reqAnswered', icon: 'fa-brain',         label: 'Games answered' },
    { key: 'comments', reqKey: 'reqComments', icon: 'fa-comment',       label: 'Comments' },
    { key: 'reacts',   reqKey: 'reqReacts',   icon: 'fa-heart',         label: 'Reactions given' },
    { key: 'chat',     reqKey: 'reqChat',     icon: 'fa-comments',      label: 'Chat messages' },
];

const QUEST_DEFAULTS = {
    enabled: true,
    reqPosts: 10, reqReels: 3, reqMyDay: 1, reqNotes: 1, reqGames: 50, reqAnswered: 10,
    reqComments: 20, reqReacts: 10, reqChat: 30,
    lbReward: 50,     // LB points paid on claim (all-time + daily/weekly/monthly)
    moneyReward: 0,   // ₱ shown next to the reward (DISPLAY-ONLY; 0 = hidden)
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Live config = hardcoded defaults overlaid with the admin's /settings/quests.
window.questConfig = () => {
    const q = { ...QUEST_DEFAULTS, ...(window.siteSettings && window.siteSettings.quests ? window.siteSettings.quests : {}) };
    const num = (v, fb) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fb; };
    return {
        enabled: q.enabled !== false,
        reqPosts: num(q.reqPosts, QUEST_DEFAULTS.reqPosts),
        reqReels: num(q.reqReels, QUEST_DEFAULTS.reqReels),
        reqMyDay: num(q.reqMyDay, QUEST_DEFAULTS.reqMyDay),
        reqNotes: num(q.reqNotes, QUEST_DEFAULTS.reqNotes),
        reqGames: num(q.reqGames, QUEST_DEFAULTS.reqGames),
        reqAnswered: num(q.reqAnswered, QUEST_DEFAULTS.reqAnswered),
        reqComments: num(q.reqComments, QUEST_DEFAULTS.reqComments),
        reqReacts: num(q.reqReacts, QUEST_DEFAULTS.reqReacts),
        reqChat: num(q.reqChat, QUEST_DEFAULTS.reqChat),
        lbReward: num(q.lbReward, QUEST_DEFAULTS.lbReward),
        moneyReward: num(q.moneyReward, QUEST_DEFAULTS.moneyReward),
    };
};

// Active quest lines = requirements greater than 0.
const activeQuestLines = (cfg) => QUEST_METRICS
    .map((m) => ({ ...m, req: Number(cfg[m.reqKey]) || 0 }))
    .filter((m) => m.req > 0);

const questUid = () => {
    const u = window.currentUser || null;
    if (!u || !u.uid) return null;
    // Anonymous guest sign-ins never earn quests (real accounts only).
    if (auth.currentUser && auth.currentUser.isAnonymous) return null;
    return u.uid;
};

// Firestore doc ids are RTDB-safe, but never trust external ids as keys.
const safeKey = (s) => String(s || '').replace(/[.#$[\]/]/g, '_').slice(0, 128);
// ── Progress tracking ───────────────────────────────────────────────────────
// Fire-and-forget increments — same bandwidth discipline as creditLbPeriods.
// Reacts go through a marker transaction first so react/unreact toggling on
// the same post can never farm the counter.
// 7-DAY HISTORY: on first activity of the day the client deletes its record
// from exactly 7 days earlier (same weekday) — keeping today + the previous
// 6 days, which is the window the Quest modal's History tab renders.
let _questPrunedFor = null; // one prune per uid per session
const pruneOldDays = (uid) => {
    if (_questPrunedFor === uid) return;
    _questPrunedFor = uid;
    const y = new Date(); y.setDate(y.getDate() - 7);
    remove(ref(db3, `quests/${questDayKey(y)}/${uid}`)).catch(() => {});
};

window.questTrack = (metric, targetId) => {
    const uid = questUid();
    if (!uid) return;
    if (!QUEST_METRICS.some((m) => m.key === metric)) {
        console.warn(`questTrack: unknown metric "${metric}" — not tracked`); // surfaces hook typos
        return;
    }
    const dayRef = `quests/${questDayKey()}/${uid}`;
    pruneOldDays(uid);
    if (metric === 'reacts' && targetId) {
        // ONE atomic transaction writes marker + counter together: a
        // react/unreact toggle can never double-count, a dropped write can
        // never lose a counted react, and the record always contains p — so it
        // satisfies the /quests .validate whatever order writes arrive in.
        runTransaction(ref(db3, dayRef), (cur) => {
            const rec = (cur && typeof cur === 'object') ? cur : {};
            const t = rec.t || {};
            const react = t.react || {};
            const key = safeKey(targetId);
            if (react[key]) return undefined; // already counted today
            react[key] = true;
            const p = rec.p || {};
            p.reacts = Number(p.reacts || 0) + 1;
            return { ...rec, t: { ...t, react }, p };
        }).catch((e) => console.warn('quest react track error:', e));
        return;
    }
    update(ref(db3, `${dayRef}/p`), { [metric]: increment(1) })
        .catch((e) => console.warn('quest track error:', e));
};

// ── Modal helpers ───────────────────────────────────────────────────────────
let _questUnsub = null;

const questDaySnapshot = (snap) => {
    const v = snap && snap.exists() ? snap.val() || {} : {};
    return { p: v.p || {}, claimedAt: Number(v.claimedAt) || 0 };
};

const questAllDone = (cfg, p) => {
    const lines = activeQuestLines(cfg);
    return lines.length > 0 && lines.every((m) => Number(p[m.key] || 0) >= m.req);
};

// Green dot on the account-menu Quest row when today is complete but unclaimed.
window.updateQuestDot = async () => {
    const dot = document.getElementById('quest-menu-dot');
    if (!dot) return;
    const uid = questUid();
    const cfg = window.questConfig();
    if (!uid || !cfg.enabled) { dot.classList.add('hidden'); return; }
    try {
        const snap = await get(ref(db3, `quests/${questDayKey()}/${uid}`));
        const s = questDaySnapshot(snap);
        const show = !s.claimedAt && questAllDone(cfg, s.p);
        dot.classList.toggle('hidden', !show);
    } catch (_) { /* best-effort */ }
};
const paintQuestModal = (snap) => {
    const cfg = window.questConfig();
    const s = questDaySnapshot(snap);
    const day = questDayKey();

    const dateEl = document.getElementById('quest-date-label');
    if (dateEl) {
        dateEl.textContent = (window.lbPeriodLabel
            ? window.lbPeriodLabel('daily', day)
            : new Date().toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }));
    }

    // Reward banner — ₱ money is display-only and fully hidden at 0.
    const lbEl = document.getElementById('quest-info-lb');
    if (lbEl) lbEl.textContent = Number(cfg.lbReward || 0).toLocaleString();
    const moneyWrap = document.getElementById('quest-info-money-wrap');
    const moneyEl = document.getElementById('quest-info-money');
    if (moneyWrap && moneyEl) {
        moneyWrap.classList.toggle('hidden', !(cfg.moneyReward > 0));
        moneyEl.textContent = Number(cfg.moneyReward || 0).toLocaleString();
    }

    const list = document.getElementById('quest-list');
    if (list) {
        const lines = activeQuestLines(cfg);
        if (lines.length === 0) {
            list.innerHTML = `<p class="text-[11px] text-gray-400 dark:text-gray-500 text-center py-6">No active quests today. Check back tomorrow!</p>`;
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
    const btn = document.getElementById('quest-claim-btn');
    if (btn) {
        const allDone = questAllDone(cfg, s.p);
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

    window.updateQuestDot();
};
window.userMenuQuest = () => {
    window.closeUserMenu && window.closeUserMenu();
    const modal = document.getElementById('quest-modal');
    if (!modal) return;
    const uid = questUid();
    if (!uid) { window.showToast && window.showToast('Sign in with a real account to see Daily Quests.'); return; }
    modal.classList.remove('hidden');
    // Live progress while the modal is open; unsubscribed on close (bandwidth discipline).
    if (_questUnsub) { _questUnsub(); _questUnsub = null; }
    window.setQuestTab('today'); // always open on Today; History reloads per visit
    paintQuestModal(null); // instant paint from defaults, then the snapshot lands
    _questUnsub = onValue(ref(db3, `quests/${questDayKey()}/${uid}`), paintQuestModal, (e) => console.warn('quest listener error:', e));
};

window.closeQuestModal = () => {
    if (_questUnsub) { _questUnsub(); _questUnsub = null; }
    const modal = document.getElementById('quest-modal');
    if (modal) modal.classList.add('hidden');
    window.updateQuestDot();
};

// ── Tabs: Today / History ───────────────────────────────────────────────────
window._questTab = 'today';

window.setQuestTab = (tab) => {
    window._questTab = (tab === 'history') ? 'history' : 'today';
    ['today', 'history'].forEach((t) => {
        const btn = document.getElementById('quest-tab-' + t);
        if (btn) {
            const on = (t === window._questTab);
            btn.className = `px-3 py-1 rounded-full text-[11px] font-bold transition ${on
                ? 'bg-blue-600 text-white border border-transparent'
                : 'bg-gray-100 text-gray-700 dark:bg-slate-900 dark:text-gray-300 border border-gray-200 dark:border-slate-700'}`;
        }
        const pane = document.getElementById('quest-' + t + '-pane');
        if (pane) pane.classList.toggle('hidden', t !== window._questTab);
    });
    if (window._questTab === 'history') window.loadQuestHistory();
};

// History tab — the previous 7 days (the prune above keeps exactly this window).
// One targeted get() per day key, fired only when the tab is opened — never a
// whole-table read (bandwidth discipline).
const QUEST_HISTORY_DAYS = 7;

window.loadQuestHistory = async () => {
    const uid = questUid();
    const list = document.getElementById('quest-history-list');
    if (!uid || !list) return;
    list.innerHTML = `<p class="text-[11px] text-gray-400 dark:text-gray-500 text-center py-6"><i class="fa-solid fa-spinner fa-spin mr-1"></i>Loading…</p>`;
    const lines = activeQuestLines(window.questConfig());
    const keys = [];
    for (let i = 1; i <= QUEST_HISTORY_DAYS; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        keys.push(questDayKey(d));
    }
    let snaps;
    try {
        snaps = await Promise.all(keys.map((k) => get(ref(db3, `quests/${k}/${uid}`))));
    } catch (e) {
        console.warn('quest history load failed:', e);
        list.innerHTML = `<p class="text-[11px] text-red-400 dark:text-red-400 text-center py-6">Could not load history — try again.</p>`;
        return;
    }
    // Status per day: claimedAt wins; otherwise completion is checked against
    // the CURRENT admin requirements (past days don't store the reqs that were
    // live back then — a later requirement bump can flip an old unclaimed day).
    list.innerHTML = keys.map((key, i) => {
        const s = questDaySnapshot(snaps[i]);
        const hasActivity = Object.keys(s.p).length > 0;
        const met = lines.filter((m) => Number(s.p[m.key] || 0) >= m.req).length;
        const allDone = lines.length > 0 && met === lines.length;
        const [y, mo, d] = key.split('-').map(Number);
        const label = new Date(y, mo - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        let pill, pillCls, rowCls, icon, iconCls;
        if (s.claimedAt) {
            pill = 'Claimed ✓';
            pillCls = 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30';
            rowCls = 'border-green-200 dark:border-green-500/30 bg-green-50/60 dark:bg-green-500/[0.06]';
            icon = 'fa-circle-check'; iconCls = 'text-green-500';
        } else if (allDone) {
            pill = 'Completed (unclaimed)';
            pillCls = 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30';
            rowCls = 'border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.06]';
            icon = 'fa-trophy'; iconCls = 'text-amber-500';
        } else if (hasActivity) {
            pill = `${met}/${lines.length} quests`;
            pillCls = 'bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-gray-400 border-gray-200 dark:border-slate-600';
            rowCls = 'border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-900/50';
            icon = 'fa-hourglass-half'; iconCls = 'text-gray-400';
        } else {
            pill = 'No activity';
            pillCls = 'bg-gray-50 text-gray-400 dark:bg-slate-800/60 dark:text-gray-500 border-gray-100 dark:border-slate-700';
            rowCls = 'border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800/40';
            icon = 'fa-minus'; iconCls = 'text-gray-300 dark:text-gray-600';
        }
        return `
        <div class="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border ${rowCls}">
            <i class="fa-solid ${icon} w-4 text-center text-sm ${iconCls}"></i>
            <span class="flex-1 min-w-0">
                <span class="block text-[11px] font-bold text-gray-800 dark:text-gray-200">${esc(label)}</span>
                ${hasActivity && !s.claimedAt ? `<span class="block text-[10px] text-gray-400 dark:text-gray-500">${met} of ${lines.length} quests completed</span>` : ''}
            </span>
            <span class="text-[9px] font-black px-2 py-0.5 rounded-full border whitespace-nowrap ${pillCls}">${pill}</span>
        </div>`;
    }).join('') + `<p class="text-[9px] text-gray-400 dark:text-gray-500 text-center pt-1">Keeps the last ${QUEST_HISTORY_DAYS} days. Past completion is checked against today's requirements.</p>`;
};

// ── Claim ───────────────────────────────────────────────────────────────────
window._claimingQuest = false;

// Claim today's reward. Atomic: the transaction re-reads the live record and
// re-verifies every counter, so a double-click, a second tab or a stale modal
// can never pay twice — same pattern as window.claimRecruitReward.
window.claimDailyQuest = async () => {
    const uid = questUid();
    if (!uid || window._claimingQuest) return;
    const cfg = window.questConfig();
    const lines = activeQuestLines(cfg);
    if (lines.length === 0) { window.showToast && window.showToast('No active quests today.'); return; }

    window._claimingQuest = true;
    const btn = document.getElementById('quest-claim-btn');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    try {
        const day = questDayKey();
        pruneOldDays(uid);
        const res = await runTransaction(ref(db3, `quests/${day}/${uid}`), (cur) => {
            if (!cur) return undefined;                 // nothing tracked yet
            if (cur.claimedAt) return undefined;        // already paid
            const p = cur.p || {};
            for (const m of lines) {
                if (Number(p[m.key] || 0) < m.req) return undefined; // not complete
            }
            return { ...cur, claimedAt: Date.now() };
        });

        if (!res.committed) {
            window.showToast && window.showToast('Daily Quest is not complete yet — keep going!');
            return;
        }

        // Credit ALL four LB buckets: overall (users/{uid}/lbPoints) + the
        // daily/weekly/monthly period counters. moneyReward stays display-only.
        if (cfg.lbReward > 0) {
            set(ref(db, `users/${uid}/lbPoints`), increment(cfg.lbReward));
            if (window.creditLbPeriods) window.creditLbPeriods(uid, cfg.lbReward);
        }
        window.showToast && window.showToast(`Daily Quest claimed! +${Number(cfg.lbReward || 0).toLocaleString()} LB credited. 🎉`);
    } catch (e) {
        console.warn('Quest claim failed:', e);
        window.showToast && window.showToast('Claim failed — please try again.');
    } finally {
        if (btn) btn.innerHTML = originalHtml;
        window._claimingQuest = false;
    }
};

// ── Visibility + dot ────────────────────────────────────────────────────────
// The Quest row is hidden while the admin toggle is off (missing = enabled).
// Tiny listener on one leaf node — cheap enough to keep always-on.
onValue(ref(db, 'settings/quests/enabled'), (snap) => {
    const btn = document.getElementById('quest-menu-btn');
    if (btn) btn.classList.toggle('hidden', snap.val() === false);
}, () => {});

// Refresh the dot when the account menu opens (the menu itself is toggled by
// main.js, so hook the button instead of wrapping window.toggleUserMenu).
document.getElementById('nav-avatar-btn')?.addEventListener('click', () => {
    setTimeout(() => window.updateQuestDot(), 0);
});
