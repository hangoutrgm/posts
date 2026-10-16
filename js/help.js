// help.js — Help / FAQ modal (nav bar ? button, beside Members)
// ============================================================
// Newcomer FAQ. The markup ships in index.html (#help-modal) as collapsible
// question → answer pairs (window.toggleHelpFaq). v1 questions:
//   · How do I earn Leaderboard (LB) points?
//   · How do I earn money (₱)?
//   · How do I register?
// Live amounts come from window.siteSettings on every open — no DB reads, the
// settings mirror in main.js already keeps siteSettings fresh. Rows whose
// reward the admin set to 0 (or disabled) are hidden automatically, so the
// guide never advertises an amount that can't be earned. More questions can
// be added as new button + panel pairs inside #help-modal.
// ============================================================

const helpEl = (id) => document.getElementById(id);

// Row visibility: hidden when the configured reward is off/zero.
const helpShow = (id, show) => { const el = helpEl(id); if (el) el.classList.toggle('hidden', !show); };
const helpText = (id, txt) => { const el = helpEl(id); if (el) el.textContent = txt; };
const helpNum = (n) => Number(n || 0).toLocaleString();

// FAQ accordion — toggle one answer panel + rotate its chevron.
window.toggleHelpFaq = (key) => {
    const panel = helpEl('help-a-' + key);
    if (!panel) return;
    const open = panel.classList.toggle('hidden') === false;
    const chev = helpEl('help-ch-' + key);
    if (chev) chev.classList.toggle('rotate-180', open);
};

// Fills the live amounts + visibility. Re-run on every open so a mid-session
// settings change from /config shows up without a reload.
window.renderHelpValues = () => {
    const s = window.siteSettings || {};
    const q = s.quests || {};

    // 🛠️ Host bonus — hidden when the admin pays nothing.
    const hostBonus = Number(s.gameHostLbReward || 0);
    helpShow('help-row-host', hostBonus > 0);
    helpText('help-host-bonus', helpNum(hostBonus));

    // 💬 Chat games — one row, sentence built from whichever halves are live.
    const chatWin = Number(s.chatGameLbReward || 0);
    const chatHost = Number(s.chatGameHostLbReward || 0);
    const chatParts = [];
    if (chatWin > 0) chatParts.push(`${helpNum(chatWin)} LB to the first correct answer`);
    if (chatHost > 0) chatParts.push(`${helpNum(chatHost)} LB to the host when someone wins`);
    helpShow('help-row-chat', chatParts.length > 0);
    helpText('help-chat-text', chatParts.join(' + ') + '.');

    // 🎯 Daily Quest claim.
    const questLb = Number(q.lbReward || 0);
    helpShow('help-row-quest', questLb > 0);
    helpText('help-quest-lb', helpNum(questLb));

    // 👥 Recruit reward.
    const recruitLb = Number(s.recruitLbReward || 0);
    helpShow('help-row-recruit', recruitLb > 0);
    helpText('help-recruit-lb', helpNum(recruitLb));

    // ⚡ Boost window — only meaningful when the multiplier is above 1.
    const boost = Number(s.lbBoostMultiplier || 1);
    helpShow('help-row-boost', boost > 1);
    helpText('help-boost-window', `${s.lbBoostStart || '22:00'} – ${s.lbBoostEnd || '00:00'}`);
    helpText('help-boost-mult', `×${boost}`);

    // 🏆 Weekly ladder prizes (settings/leaderboardRewards — array or map,
    // ranks 1..10; a prized rank = a non-empty value). Hidden when none.
    const rew = s.leaderboardRewards || {};
    let prizedRanks = 0, rank1 = 0;
    for (let i = 1; i <= 10; i++) {
        const v = rew[String(i)];
        if (v !== undefined && v !== null && String(v).trim() !== '' && Number(v) > 0) {
            prizedRanks++;
            if (i === 1) rank1 = Number(v);
        }
    }
    helpShow('help-row-weekly', prizedRanks > 0);
    helpText('help-money-ranks', `${prizedRanks} weekly`);
    helpText('help-money-r1', `₱${helpNum(rank1)}`);

    // 💰 Daily Quest / Recruits peso amounts (money FAQ).
    const questPeso = Number(q.moneyReward || 0);
    helpShow('help-row-quest-peso', questPeso > 0);
    helpText('help-money-quest', `₱${helpNum(questPeso)}`);
    const recruitPeso = Number(s.recruitPrizeReward || 0);
    helpShow('help-row-recruit-peso', recruitPeso > 0);
    helpText('help-money-recruit', `₱${helpNum(recruitPeso)}`);
};

window.openHelpModal = () => {
    const modal = helpEl('help-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    window.renderHelpValues();
};

window.closeHelpModal = () => {
    const modal = helpEl('help-modal');
    if (modal) modal.classList.add('hidden');
};

// Esc closes the modal (same as the other dialogs).
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.closeHelpModal();
});
