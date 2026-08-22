// treasury.js
import { app, auth, db } from "../js/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { ref, onValue, push, update, remove, set, get } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js";

const ADMIN_UID = 'IrcAY3gUELNjiRUhMkr7muxNIpm2';
const $ = (id) => document.getElementById(id);

const state = {
    rewards: {},
    keep: {},
    lend: {},
    buysell: {},
    savings: {},
    rewardFilter: 'all',
    myUid: null,
    viewingUid: null,
    users: {},
    sponsors: [],
    detachers: []
};

// Path helper: whose treasury is currently on screen
const tPath = (leaf) => `treasury/${state.viewingUid}/${leaf}`;

const STATUS_LABEL = {
    to_send: 'To Send',
    to_receive: 'To Receive',
    pending: 'Pending',
    on_hold: 'On Hold',
    sent: 'Sent'
};

const STATUS_BADGE = {
    to_send: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300',
    to_receive: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    pending: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    on_hold: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    sent: 'bg-green-100 text-green-600 dark:bg-green-500/15 dark:text-green-300'
};

function money(n) {
    return '₱' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return isNaN(d) ? ts : d.toLocaleDateString();
}
function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ── Auth gate ──
// Every signed-in user gets their own treasury space (treasury/{uid}/...) with full control.
// Users appointed as "treasurers" by a sponsor can also open and manage the sponsor's treasury.
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = '../'; return; }
    state.myUid = user.uid;

    await migrateLegacyIfNeeded();   // one-time move of the old shared pool under the Super Admin account
    loadUsers();                     // names for badges/pickers
    watchDeputyOffers();             // sponsors that appointed me
    switchTreasury(user.uid);        // load my own treasury

    $('loading-screen').classList.add('hidden');
    $('treasury-content').classList.remove('hidden');
    initTreasury();
});

// ── Load / switch whose treasury is on screen ──
function switchTreasury(uid) {
    state.viewingUid = uid;
    state.detachers.forEach(off => off());
    state.detachers = [
        onValue(ref(db, tPath('rewards')), (s) => { state.rewards = s.val() || {}; renderRewards(); }),
        onValue(ref(db, tPath('keep')), (s) => { state.keep = s.val() || {}; renderKeep(); }),
        onValue(ref(db, tPath('lend')), (s) => { state.lend = s.val() || {}; renderLend(); }),
        onValue(ref(db, tPath('buysell')), (s) => { state.buysell = s.val() || {}; renderBuysell(); }),
        onValue(ref(db, tPath('savings')), (s) => { state.savings = s.val() || {}; renderSavings(); })
    ];
    updateViewBanner();
}

function updateViewBanner() {
    const bar = $('view-banner');
    if (!bar) return;
    if (state.viewingUid === state.myUid) { bar.classList.add('hidden'); return; }
    bar.innerHTML =
        `<span><i class="fa-solid fa-user-pen mr-1"></i>Managing <b>${escapeHtml(state.users[state.viewingUid]?.name || 'sponsor')}'s</b> treasury — changes are saved to their account.</span>` +
        `<button onclick="window.openSponsorTreasury('${state.myUid}')" class="bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition shrink-0">Back to Mine</button>`;
    bar.classList.remove('hidden');
}

// One-time: move the old shared pool (treasury/rewards|keep|lend) under the Super Admin's own space.
async function migrateLegacyIfNeeded() {
    if (state.myUid !== ADMIN_UID) return;
    try {
        if ((await get(ref(db, `treasury/${state.myUid}`))).exists()) return;
        const [rw, kp, ln] = await Promise.all([
            get(ref(db, 'treasury/rewards')), get(ref(db, 'treasury/keep')), get(ref(db, 'treasury/lend'))
        ]);
        if (!rw.exists() && !kp.exists() && !ln.exists()) return;
        const pool = {};
        if (rw.exists()) pool.rewards = rw.val();
        if (kp.exists()) pool.keep = kp.val();
        if (ln.exists()) pool.lend = ln.val();
        await set(ref(db, `treasury/${state.myUid}`), pool);
        await Promise.all([
            remove(ref(db, 'treasury/rewards')),
            remove(ref(db, 'treasury/keep')),
            remove(ref(db, 'treasury/lend'))
        ]);
    } catch (e) { console.warn('Legacy treasury migration skipped:', e); }
}

// ── Treasurer delegation ──
async function loadUsers() {
    try {
        const s = await get(ref(db, 'users'));
        state.users = s.val() || {};
        renderSponsorChips();
        updateViewBanner();
    } catch (e) { /* non-fatal */ }
}

// Watch appointments: treasury_deputies/{sponsorUid}/{myUid} = true
function watchDeputyOffers() {
    onValue(ref(db, 'treasury_deputies'), (snap) => {
        const all = snap.val() || {};
        state.sponsors = Object.keys(all).filter(sp => all[sp] && all[sp][state.myUid] === true);
        renderSponsorChips();
    });
}

function renderSponsorChips() {
    const wrap = $('deputy-bar');
    if (!wrap) return;
    wrap.innerHTML = state.sponsors.map(uid =>
        `<button onclick="window.openSponsorTreasury('${uid}')" class="${state.viewingUid === uid ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-slate-800/90 text-emerald-600 dark:text-emerald-400'} border border-emerald-200 dark:border-emerald-900/40 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 text-[11px] font-bold px-3 py-1.5 rounded-full transition shadow-sm flex items-center gap-1.5">` +
        `<i class="fa-solid fa-vault"></i>Manage ${escapeHtml(state.users[uid]?.name || 'sponsor')}'s Treasury</button>`
    ).join('');
    wrap.classList.toggle('hidden', !state.sponsors.length);
}
window.openSponsorTreasury = (uid) => switchTreasury(uid);

window.removeDeputy = async (uid) => {
    try {
        await remove(ref(db, `treasury_deputies/${state.myUid}/${uid}`));
        toast('Treasurer removed.');
        openTreasurersModal();
    } catch (e) { toast('Could not remove: ' + e.message); }
};

async function openTreasurersModal() {
    await loadUsers();
    const snap = await get(ref(db, `treasury_deputies/${state.myUid}`));
    const deps = snap.exists() ? Object.keys(snap.val()).filter(k => snap.val()[k] === true) : [];
    const options = Object.keys(state.users).filter(uid => uid !== state.myUid)
        .sort((a, b) => (state.users[a].name || '').localeCompare(state.users[b].name || ''))
        .map(uid => `<option value="${uid}">${escapeHtml(state.users[uid].name || 'User')}</option>`).join('');
    if (!options) { toast('No registered users found.'); return; }
    const listHtml = deps.length ? deps.map(uid =>
        `<div class="flex items-center justify-between bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-2">
            <span class="text-xs font-semibold text-slate-800 dark:text-white truncate">${escapeHtml(state.users[uid]?.name || uid.substring(0, 8))}</span>
            <button type="button" onclick="window.removeDeputy('${uid}')" class="text-rose-500 hover:text-rose-400 text-[11px] font-bold ml-2 shrink-0"><i class="fa-solid fa-xmark mr-0.5"></i>Remove</button>
        </div>`).join('')
        : '<p class="text-[11px] text-slate-400 dark:text-slate-500">No treasurers yet. Pick a user above to let them manage your treasury.</p>';
    openModal('My Treasurers',
        `<p class="text-[11px] text-slate-500 dark:text-slate-400">People you appoint can open your treasury from their own treasury page and make changes to it.</p>` +
        `<select id="dp-user" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-2 text-xs outline-none transition">${options}</select>` +
        `<div class="space-y-2 max-h-44 overflow-y-auto custom-scrollbar">${listHtml}</div>`,
        'Add Treasurer',
        async () => {
            const uid = $('dp-user')?.value;
            if (!uid) return toast('Select a user first.');
            try {
                await set(ref(db, `treasury_deputies/${state.myUid}/${uid}`), true);
                toast('Treasurer added.');
                openTreasurersModal();
            } catch (e) { toast('Could not add: ' + e.message); }
        });
}

// ── Init ──
function initTreasury() {
    const themeBtn = $('theme-toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            if (document.documentElement.classList.contains('dark')) {
                document.documentElement.classList.remove('dark'); localStorage.theme = 'light';
            } else {
                document.documentElement.classList.add('dark'); localStorage.theme = 'dark';
            }
        });
    }
    document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    switchTab('rewards');
    document.querySelectorAll('.reward-filter').forEach(btn => btn.addEventListener('click', () => {
        state.rewardFilter = btn.dataset.rewardFilter;
        document.querySelectorAll('.reward-filter').forEach(b => {
            const on = b.dataset.rewardFilter === state.rewardFilter;
            b.classList.toggle('bg-indigo-600', on); b.classList.toggle('text-white', on); b.classList.toggle('border-indigo-600', on);
        });
        renderRewards();
    }));
    $('btn-add-reward').addEventListener('click', () => openRewardForm());
    $('btn-deposit').addEventListener('click', () => openKeepForm('deposit'));
    $('btn-withdraw').addEventListener('click', () => openKeepForm('withdraw'));
    $('btn-add-loan').addEventListener('click', () => openLoanForm());
    $('btn-bs-buy').addEventListener('click', () => openBuySellForm('buy'));
    $('btn-bs-sell').addEventListener('click', () => openBuySellForm('sell'));
    $('btn-savings-add').addEventListener('click', () => openSavingsForm());
    $('btn-treasurers').addEventListener('click', () => openTreasurersModal());
    $('modal-close').addEventListener('click', closeModal);
    $('modal-cancel').addEventListener('click', closeModal);
    $('modal-form').addEventListener('submit', (e) => e.preventDefault());
}

function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b => {
        const on = b.dataset.tab === name;
        b.classList.toggle('bg-indigo-600', on); b.classList.toggle('text-white', on);
    });
    $('tab-rewards').classList.toggle('hidden', name !== 'rewards');
    $('tab-keep').classList.toggle('hidden', name !== 'keep');
    $('tab-lend').classList.toggle('hidden', name !== 'lend');
    $('tab-buysell').classList.toggle('hidden', name !== 'buysell');
    $('tab-savings').classList.toggle('hidden', name !== 'savings');
}

// ── Modal helpers & form field builders ──
function openModal(title, fields, submitLabel, onSubmit) {
    $('modal-title').textContent = title;
    $('modal-fields').innerHTML = fields;
    $('modal-submit').textContent = submitLabel;
    $('modal-submit').onclick = (e) => { e.preventDefault(); onSubmit(); };
    $('modal').classList.remove('hidden');
}
function closeModal() {
    $('modal').classList.add('hidden');
    $('modal-submit').onclick = null;
}
const field = (label, id, type = 'text', placeholder = '', value = '') =>
    `<div><label class="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1 ml-0.5">${label}</label>` +
    `<input id="${id}" type="${type}" value="${escapeHtml(value)}" placeholder="${placeholder}" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-2 text-xs outline-none transition"></div>`;
const textarea = (label, id, placeholder = '', value = '') =>
    `<div><label class="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1 ml-0.5">${label}</label>` +
    `<textarea id="${id}" rows="2" placeholder="${placeholder}" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-2 text-xs outline-none transition">${escapeHtml(value)}</textarea></div>`;
const select = (label, id, options, selected) =>
    `<div><label class="block text-[10px] font-semibold text-slate-500 dark:text-slate-400 mb-1 ml-0.5">${label}</label>` +
    `<select id="${id}" class="w-full bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 rounded-lg px-2.5 py-2 text-xs outline-none transition">` +
    options.map(o => `<option value="${o.v}" ${o.v === selected ? 'selected' : ''}>${o.l}</option>`).join('') + `</select></div>`;

// ── Rewards ──
function openRewardForm(id = null) {
    const rec = id ? state.rewards[id] : null;
    openModal(rec ? 'Edit Reward' : 'Add Reward',
        field('User Name', 'rw-name', 'text', 'e.g. Juan or registered name', rec?.name || '') +
        field('GCash Number', 'rw-gcash', 'text', 'e.g. 09171234567', rec?.gcash || '') +
        field('Prize Amount', 'rw-amount', 'number', '0', rec?.amount ?? '') +
        select('Status', 'rw-status', [
            { v: 'to_send', l: 'To Send' }, { v: 'to_receive', l: 'To Receive' },
            { v: 'pending', l: 'Pending' }, { v: 'on_hold', l: 'On Hold' }, { v: 'sent', l: 'Sent' }
        ], rec?.status || 'to_send') +
        textarea('Note', 'rw-note', 'optional note', rec?.note || ''),
        rec ? 'Save Changes' : 'Add Reward', async () => {
            const name = $('rw-name').value.trim();
            const gcash = $('rw-gcash').value.trim();
            const amount = parseFloat($('rw-amount').value);
            const status = $('rw-status').value;
            if (!name || isNaN(amount) || amount <= 0) return toast('Enter a name and valid amount.');
            try {
                if (rec) {
                    await update(ref(db, tPath(`rewards/${id}`)), {
                        name, gcash: gcash || '—', amount, status,
                        note: $('rw-note').value.trim() || '', updatedAt: Date.now()
                    });
                    closeModal(); toast('Reward updated.');
                } else {
                    await push(ref(db, tPath('rewards')), {
                        name, gcash: gcash || '—', amount, status,
                        note: $('rw-note').value.trim() || '',
                        createdAt: Date.now(), updatedAt: Date.now()
                    });
                    closeModal(); toast('Reward added.');
                }
            } catch (e) { toast((rec ? 'Could not update: ' : 'Could not add reward: ') + e.message); }
        });
}
window.editReward = (id) => openRewardForm(id);
window.setRewardStatus = (id, status) => {
    update(ref(db, tPath(`rewards/${id}`)), { status, updatedAt: Date.now() })
        .then(() => toast('Status updated to ' + STATUS_LABEL[status] + '.'))
        .catch(() => toast('Failed to update.'));
};
window.deleteReward = (id) => {
    if (!confirm('Delete this reward?')) return;
    remove(ref(db, tPath(`rewards/${id}`))).then(() => toast('Reward deleted.')).catch(() => toast('Delete failed.'));
};
function renderRewards() {
    const tbody = $('rewards-list');
    const rows = Object.keys(state.rewards);
    let filtered = rows.map(id => ({ id, ...state.rewards[id] }));
    filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (state.rewardFilter !== 'all') filtered = filtered.filter(r => r.status === state.rewardFilter);

    let toSend = 0, onHold = 0, sent = 0, total = 0;
    rows.forEach(id => {
        const r = state.rewards[id];
        const amt = Number(r.amount || 0);
        total += amt;
        if (r.status === 'to_send') toSend += amt;
        else if (r.status === 'on_hold') onHold += amt;
        else if (r.status === 'sent') sent += amt;
    });
    $('stat-to-send').textContent = toSend;
    $('stat-on-hold').textContent = onHold;
    $('stat-sent').textContent = sent;
    $('stat-total').textContent = money(total);

    $('rewards-empty').classList.toggle('hidden', filtered.length > 0);
    let html = '';
    filtered.forEach(r => {
        html += `<tr>
            <td class="px-4 py-3"><div class="font-semibold text-slate-800 dark:text-white">${escapeHtml(r.name)}</div>${r.note ? `<div class="text-[10px] text-slate-400">${escapeHtml(r.note)}</div>` : ''}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${escapeHtml(r.gcash || '—')}</td>
            <td class="px-4 py-3 text-right font-bold text-slate-800 dark:text-white">${money(r.amount)}</td>
            <td class="px-4 py-3"><span class="text-[10px] font-bold px-2 py-1 rounded-full ${STATUS_BADGE[r.status] || STATUS_BADGE.pending}">${STATUS_LABEL[r.status] || r.status}</span></td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${fmtDate(r.createdAt)}</td>
            <td class="px-4 py-3"><div class="flex items-center justify-end gap-1">
                <button onclick="window.editReward('${r.id}')" title="Edit" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-pen text-xs"></i></button>
                ${r.status !== 'sent' ? `<button onclick="window.setRewardStatus('${r.id}','sent')" title="Mark as Sent" class="w-7 h-7 rounded-lg bg-green-600 hover:bg-green-500 text-white flex items-center justify-center transition"><i class="fa-solid fa-check text-xs"></i></button>` : ''}
                <button onclick="window.setRewardStatus('${r.id}','on_hold')" title="On Hold" class="w-7 h-7 rounded-lg bg-rose-600 hover:bg-rose-500 text-white flex items-center justify-center transition"><i class="fa-solid fa-pause text-xs"></i></button>
                <button onclick="window.deleteReward('${r.id}')" title="Delete" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div></td>
        </tr>`;
    });
    tbody.innerHTML = html;
}

const escapeHtml = (str) => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const today = () => new Date().toISOString().slice(0, 10);

// ── Keep ──
function openKeepForm(type, id = null) {
    const isDeposit = type === 'deposit';
    const rec = id ? state.keep[id] : null;
    openModal(rec ? 'Edit Deposit (Keep)' : (isDeposit ? 'Deposit (Keep)' : 'Withdraw (Keep)'),
        field('Name', 'kp-name', 'text', 'e.g. Maria', rec?.name || '') +
        field('Amount', 'kp-amount', 'number', '0', rec?.amount ?? '') +
        field('Date', 'kp-date', 'date', '', rec?.date || today()) +
        textarea('Remarks', 'kp-remarks', 'e.g. entrusted for monthly savings', rec?.remarks || ''),
        rec ? 'Save Changes' : (isDeposit ? 'Add Deposit' : 'Add Withdraw'), async () => {
            const name = $('kp-name').value.trim();
            const amount = parseFloat($('kp-amount').value);
            if (!name || isNaN(amount) || amount <= 0) return toast('Enter a name and valid amount.');
            try {
                if (rec) {
                    await update(ref(db, tPath(`keep/${id}`)), {
                        name, amount,
                        date: $('kp-date').value || today(),
                        remarks: $('kp-remarks').value.trim() || ''
                    });
                    closeModal(); toast('Transaction updated.');
                } else {
                    await push(ref(db, tPath('keep')), {
                        name, type: isDeposit ? 'deposit' : 'withdraw', amount,
                        date: $('kp-date').value || today(),
                        remarks: $('kp-remarks').value.trim() || '',
                        createdAt: Date.now()
                    });
                    closeModal(); toast(isDeposit ? 'Deposit recorded.' : 'Withdrawal recorded.');
                }
            } catch (e) { toast('Could not save: ' + e.message); }
        });
}
window.editKeep = (id) => { const r = state.keep[id]; if (r) openKeepForm(r.type, id); };
window.deleteKeep = (id) => {
    if (!confirm('Delete this transaction?')) return;
    remove(ref(db, tPath(`keep/${id}`))).then(() => toast('Deleted.')).catch(() => toast('Delete failed.'));
};
function renderKeep() {
    const tbody = $('keep-list');
    const rows = Object.keys(state.keep).map(id => ({ id, ...state.keep[id] }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let deposits = 0, withdrawals = 0;
    rows.forEach(r => {
        const amt = Number(r.amount || 0);
        if (r.type === 'withdraw') withdrawals += amt; else deposits += amt;
    });
    $('keep-deposits').textContent = money(deposits);
    $('keep-withdrawals').textContent = money(withdrawals);
    $('keep-net').textContent = money(deposits - withdrawals);

    $('keep-empty').classList.toggle('hidden', rows.length > 0);
    let html = '';
    rows.forEach(r => {
        const isW = r.type === 'withdraw';
        html += `<tr>
            <td class="px-4 py-3"><span class="text-[10px] font-bold px-2 py-1 rounded-full ${isW ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'}">${isW ? 'Withdraw' : 'Deposit'}</span></td>
            <td class="px-4 py-3 font-semibold text-slate-800 dark:text-white">${escapeHtml(r.name)}</td>
            <td class="px-4 py-3 text-right font-bold ${isW ? 'text-rose-500' : 'text-emerald-500'}">${isW ? '-' : '+'}${money(r.amount)}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${escapeHtml(r.remarks || '—')}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${fmtDate(r.date)}</td>
            <td class="px-4 py-3 text-right"><div class="flex items-center justify-end gap-1">
                <button onclick="window.editKeep('${r.id}')" title="Edit" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-pen text-xs"></i></button>
                <button onclick="window.deleteKeep('${r.id}')" title="Delete" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div></td>
        </tr>`;
    });
    tbody.innerHTML = html;
}

// ── Lend ──
function openLoanForm(id = null) {
    const rec = id ? state.lend[id] : null;
    openModal(rec ? 'Edit Loan' : 'Add Loan',
        field('Name', 'ln-name', 'text', 'e.g. Pedro', rec?.name || '') +
        field('Lent Amount', 'ln-principal', 'number', '0', rec?.principal ?? '') +
        field('Interest (₱)', 'ln-interest', 'number', '0', rec?.interest ?? '') +
        field('Date', 'ln-date', 'date', '', rec?.date || today()),
        rec ? 'Save Changes' : 'Add Loan', async () => {
            const name = $('ln-name').value.trim();
            const principal = parseFloat($('ln-principal').value);
            const interest = parseFloat($('ln-interest').value) || 0;
            if (!name || isNaN(principal) || principal <= 0) return toast('Enter a name and valid lent amount.');
            try {
                if (rec) {
                    await update(ref(db, tPath(`lend/${id}`)), {
                        name, principal, interest,
                        date: $('ln-date').value || today()
                    });
                    closeModal(); toast('Loan updated.');
                } else {
                    await push(ref(db, tPath('lend')), {
                        name, principal, interest,
                        date: $('ln-date').value || today(),
                        status: 'active', createdAt: Date.now()
                    });
                    closeModal(); toast('Loan recorded.');
                }
            } catch (e) { toast('Could not save: ' + e.message); }
        });
}
window.editLoan = (id) => openLoanForm(id);
window.toggleLoanRepaid = (id, status) => {
    update(ref(db, tPath(`lend/${id}`)), { status }).then(() => toast(status === 'repaid' ? 'Marked as paid.' : 'Marked as active.')).catch(() => toast('Failed to update.'));
};
window.deleteLoan = (id) => {
    if (!confirm('Delete this loan?')) return;
    remove(ref(db, tPath(`lend/${id}`))).then(() => toast('Deleted.')).catch(() => toast('Delete failed.'));
};
function renderLend() {
    const tbody = $('lend-list');
    const rows = Object.keys(state.lend).map(id => ({ id, ...state.lend[id] }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let totalLent = 0, expected = 0, outstanding = 0;
    rows.forEach(r => {
        const p = Number(r.principal || 0);
        const i = Number(r.interest || 0);
        const collect = p + i;
        totalLent += p;
        expected += collect;
        if (r.status !== 'repaid') outstanding += collect;
    });
    $('lend-total').textContent = money(totalLent);
    $('lend-expected').textContent = money(expected);
    $('lend-outstanding').textContent = money(outstanding);

    $('lend-empty').classList.toggle('hidden', rows.length > 0);
    let html = '';
    rows.forEach(r => {
        const collect = (Number(r.principal || 0) + Number(r.interest || 0));
        const repaid = r.status === 'repaid';
        html += `<tr class="${repaid ? 'opacity-50' : ''}">
            <td class="px-4 py-3 font-semibold text-slate-800 dark:text-white">${escapeHtml(r.name)}</td>
            <td class="px-4 py-3 text-right font-bold text-slate-800 dark:text-white">${money(r.principal)}</td>
            <td class="px-4 py-3 text-right text-slate-500 dark:text-slate-400">${money(r.interest)}</td>
            <td class="px-4 py-3 text-right font-bold text-blue-600 dark:text-blue-400">${money(collect)}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${fmtDate(r.date)}</td>
            <td class="px-4 py-3"><span class="text-[10px] font-bold px-2 py-1 rounded-full ${repaid ? 'bg-green-100 text-green-600 dark:bg-green-500/15 dark:text-green-300' : 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'}">${repaid ? 'Paid' : 'Active'}</span></td>
            <td class="px-4 py-3"><div class="flex items-center justify-end gap-1">
                <button onclick="window.editLoan('${r.id}')" title="Edit" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-pen text-xs"></i></button>
                ${!repaid ? `<button onclick="window.toggleLoanRepaid('${r.id}','repaid')" title="Mark as Paid" class="w-7 h-7 rounded-lg bg-green-600 hover:bg-green-500 text-white flex items-center justify-center transition"><i class="fa-solid fa-check text-xs"></i></button>` : `<button onclick="window.toggleLoanRepaid('${r.id}','active')" title="Reopen" class="w-7 h-7 rounded-lg bg-amber-600 hover:bg-amber-500 text-white flex items-center justify-center transition"><i class="fa-solid fa-rotate-left text-xs"></i></button>`}
                <button onclick="window.deleteLoan('${r.id}')" title="Delete" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div></td>
        </tr>`;
    });
    tbody.innerHTML = html;
}

// ── Buy/Sell ──
function openBuySellForm(type, id = null) {
    const isBuy = type === 'buy';
    const rec = id ? state.buysell[id] : null;
    openModal(rec ? (isBuy ? 'Edit Purchase' : 'Edit Sale') : (isBuy ? 'Add Purchase' : 'Add Sale'),
        field('Item / Name', 'bs-name', 'text', isBuy ? 'e.g. Load wallet top-up' : 'e.g. Mobile data 1GB — Maria', rec?.name || '') +
        field('Amount', 'bs-amount', 'number', '0', rec?.amount ?? '') +
        field('Date', 'bs-date', 'date', '', rec?.date || today()) +
        textarea('Remarks', 'bs-remarks', 'optional note', rec?.remarks || ''),
        rec ? 'Save Changes' : (isBuy ? 'Add Purchase' : 'Add Sale'), async () => {
            const name = $('bs-name').value.trim();
            const amount = parseFloat($('bs-amount').value);
            if (!name || isNaN(amount) || amount <= 0) return toast('Enter a name and valid amount.');
            try {
                if (rec) {
                    await update(ref(db, tPath(`buysell/${id}`)), {
                        name, amount,
                        date: $('bs-date').value || today(),
                        remarks: $('bs-remarks').value.trim() || ''
                    });
                    closeModal(); toast('Record updated.');
                } else {
                    await push(ref(db, tPath('buysell')), {
                        name, type, amount,
                        date: $('bs-date').value || today(),
                        remarks: $('bs-remarks').value.trim() || '',
                        createdAt: Date.now()
                    });
                    closeModal(); toast(isBuy ? 'Purchase recorded.' : 'Sale recorded.');
                }
            } catch (e) { toast('Could not save: ' + e.message); }
        });
}
window.editBuysell = (id) => { const r = state.buysell[id]; if (r) openBuySellForm(r.type, id); };

// ── Savings ──
function openSavingsForm(id = null) {
    const rec = id ? state.savings[id] : null;
    openModal(rec ? 'Edit Savings' : 'Add Savings',
        field('Name / Source', 'sv-name', 'text', 'e.g. Salary cut — January', rec?.name || '') +
        field('Amount', 'sv-amount', 'number', '0', rec?.amount ?? '') +
        field('Date', 'sv-date', 'date', '', rec?.date || today()) +
        textarea('Remarks', 'sv-remarks', 'optional note', rec?.remarks || ''),
        rec ? 'Save Changes' : 'Add Savings', async () => {
            const name = $('sv-name').value.trim();
            const amount = parseFloat($('sv-amount').value);
            if (!name || isNaN(amount) || amount <= 0) return toast('Enter a name and valid amount.');
            try {
                if (rec) {
                    await update(ref(db, tPath(`savings/${id}`)), {
                        name, amount,
                        date: $('sv-date').value || today(),
                        remarks: $('sv-remarks').value.trim() || ''
                    });
                    closeModal(); toast('Savings updated.');
                } else {
                    await push(ref(db, tPath('savings')), {
                        name, amount,
                        date: $('sv-date').value || today(),
                        remarks: $('sv-remarks').value.trim() || '',
                        createdAt: Date.now()
                    });
                    closeModal(); toast('Savings recorded.');
                }
            } catch (e) { toast('Could not save: ' + e.message); }
        });
}
window.editSavings = (id) => openSavingsForm(id);
window.deleteSavings = (id) => {
    if (!confirm('Delete this record?')) return;
    remove(ref(db, tPath(`savings/${id}`))).then(() => toast('Deleted.')).catch(() => toast('Delete failed.'));
};
function renderSavings() {
    const tbody = $('savings-list');
    const rows = Object.keys(state.savings).map(id => ({ id, ...state.savings[id] }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let total = 0;
    rows.forEach(r => { total += Number(r.amount || 0); });
    $('sv-total').textContent = money(total);
    $('sv-count').textContent = rows.length;

    $('savings-empty').classList.toggle('hidden', rows.length > 0);
    let html = '';
    rows.forEach(r => {
        html += `<tr>
            <td class="px-4 py-3 font-semibold text-slate-800 dark:text-white">${escapeHtml(r.name)}</td>
            <td class="px-4 py-3 text-right font-bold text-emerald-500">+${money(r.amount)}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${escapeHtml(r.remarks || '—')}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${fmtDate(r.date)}</td>
            <td class="px-4 py-3"><div class="flex items-center justify-end gap-1">
                <button onclick="window.editSavings('${r.id}')" title="Edit" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-pen text-xs"></i></button>
                <button onclick="window.deleteSavings('${r.id}')" title="Delete" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div></td>
        </tr>`;
    });
    tbody.innerHTML = html;
}
window.deleteBuysell = (id) => {
    if (!confirm('Delete this record?')) return;
    remove(ref(db, tPath(`buysell/${id}`))).then(() => toast('Deleted.')).catch(() => toast('Delete failed.'));
};
function renderBuysell() {
    const tbody = $('buysell-list');
    const rows = Object.keys(state.buysell).map(id => ({ id, ...state.buysell[id] }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let bought = 0, sold = 0;
    rows.forEach(r => {
        const amt = Number(r.amount || 0);
        if (r.type === 'sell') sold += amt; else bought += amt;
    });
    $('bs-bought').textContent = money(bought);
    $('bs-sold').textContent = money(sold);
    $('bs-profit').textContent = money(sold - bought);

    $('buysell-empty').classList.toggle('hidden', rows.length > 0);
    let html = '';
    rows.forEach(r => {
        const isSell = r.type === 'sell';
        html += `<tr>
            <td class="px-4 py-3"><span class="text-[10px] font-bold px-2 py-1 rounded-full ${isSell ? 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300' : 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300'}">${isSell ? 'Sale' : 'Buy'}</span></td>
            <td class="px-4 py-3 font-semibold text-slate-800 dark:text-white">${escapeHtml(r.name)}</td>
            <td class="px-4 py-3 text-right font-bold ${isSell ? 'text-emerald-500' : 'text-rose-500'}">${isSell ? '+' : '-'}${money(r.amount)}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${escapeHtml(r.remarks || '—')}</td>
            <td class="px-4 py-3 text-slate-500 dark:text-slate-400">${fmtDate(r.date)}</td>
            <td class="px-4 py-3 text-right"><div class="flex items-center justify-end gap-1">
                <button onclick="window.editBuysell('${r.id}')" title="Edit" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-pen text-xs"></i></button>
                <button onclick="window.deleteBuysell('${r.id}')" title="Delete" class="w-7 h-7 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-300 flex items-center justify-center transition"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div></td>
        </tr>`;
    });
    tbody.innerHTML = html;
}