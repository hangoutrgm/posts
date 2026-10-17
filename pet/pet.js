// Hangout Pet — account gate + RTDB 3 cloud saves (pet/pet.js).
//
// The game itself lives in pet/index.html as a plain inline script; this module
// only wires it to the shared Hangout accounts and mirrors the save to RTDB 3
// at /pets/{uid} — same "open rules + client-side guard" convention as Music
// and Arena (app3's Auth is never signed in, so the owner uid goes in the path).
//
// Contract with the inline script (window.* globals):
//   window.PetCloud.waitForGate()      -> Promise, resolves once signed-in + cloud save merged
//   window.PetCloud.scheduleSave(s)    -> throttled cloud write (localStorage stays primary)
//   window.PetCloud.resetSave()        -> deletes /pets/{uid}
//   window.__petMergeCloud(c, switch)  -> merges cloud save, returns true when local must be pushed up
//   window.__petGetState()             -> current petState for that push
//   window.__petRefreshUI()            -> re-renders setup/gameplay screens after a merge

import { auth, db, db3 } from '../js/firebase-config.js?v=4';
import {
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    updateProfile,
    GoogleAuthProvider,
    signInWithPopup
} from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { ref, get, set, update, remove, increment } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

const SYNC_INTERVAL_MS = 15000;   // at most one RTDB write per 15s (the game saves every 2.5s)
const savePath = (ownerUid) => `pets/${ownerUid}`;
const SAVE_KEY = 'pocketPalCelestialSave';
const OWNER_KEY = 'pocketPalSaveOwner';   // uid that owns the local save (shared-device guard)

let uid = null;                   // signed-in account; null while signed out
let petOwnerUid = null;           // whose /pets/{uid} blob we play (self, or co-parent's uid)
let partnerRec = null;            // co-parent link record, or null when raising alone
let lastSyncAt = 0;
let syncTimer = null;
let pendingState = null;
let syncedPetOwner = null;        // pet owner of the last merge (detects switches)
let booted = false;
let gateResolve = null;
const gateReady = new Promise((resolve) => { gateResolve = resolve; });

const $ = (id) => document.getElementById(id);

function showGate() {
    const gate = $('petAuthGate');
    if (!gate) return;
    const loading = $('petGateLoading');
    if (loading) loading.classList.add('hidden');
    const panel = $('petGatePanel');
    if (panel) panel.classList.remove('hidden');
    gate.classList.remove('hidden');
}

function hideGate() {
    const gate = $('petAuthGate');
    if (gate) gate.classList.add('hidden');
}

// ── Cloud sync ───────────────────────────────────────────────────────────────

async function pushNow() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    const state = pendingState;
    pendingState = null;
    if (!petOwnerUid || !state) return;
    lastSyncAt = Date.now();
    try {
        // JSON round-trip strips undefined/function values the RTDB rejects.
        await set(ref(db3, savePath(petOwnerUid)), JSON.parse(JSON.stringify(state)));
    } catch (e) {
        console.warn('[pet] cloud save failed:', e);
    }
}

function flushSoon() {
    const wait = SYNC_INTERVAL_MS - (Date.now() - lastSyncAt);
    if (wait <= 0) { pushNow(); return; }
    if (!syncTimer) syncTimer = setTimeout(() => { syncTimer = null; pushNow(); }, wait);
}

window.PetCloud = {
    // Resolves after the first signed-in account's cloud save has been merged
    // (never resolves while signed out — the gate stays up).
    waitForGate: () => gateReady,

    scheduleSave(state) {
        if (!petOwnerUid) return;          // never write for signed-out visitors
        if (!state || !state.petName) return;   // nothing worth syncing pre-adoption
        pendingState = state;
        flushSoon();
    },

    resetSave() {
        pendingState = null;
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
        if (!petOwnerUid) return Promise.resolve();
        return remove(ref(db3, savePath(petOwnerUid)))
            .catch((e) => console.warn('[pet] cloud reset failed:', e));
    },

    // Reset is owner-only: a co-parent must leave instead of nuking the pet.
    canReset: () => !!uid && petOwnerUid === uid,

    // Weekly Quest — a pet level-up earned by the SIGNED-IN player (pet/index.html
    // grantXp calls this on every level++). Credited to `uid` (the player), not
    // petOwnerUid, so a co-parent's own play counts toward their own quest.
    // Inline write (never import js/weekly-quest.js) so firebase-config.js is
    // never evaluated twice. ISO-week key matches js/games.js lbWeekKey.
    weeklyQuest: (metric) => {
        if (!uid || !metric) return;
        const d = new Date();
        const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const day = date.getDay() === 0 ? 6 : date.getDay() - 1;
        const thursday = new Date(date);
        thursday.setDate(date.getDate() - day + 3);
        const jan1 = new Date(thursday.getFullYear(), 0, 1, 12);
        const week = Math.ceil((((thursday - jan1) / 86400000) + jan1.getDay() + 1) / 7);
        const wk = `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
        update(ref(db3, `weekly_quests/${wk}/${uid}/p`), { [metric]: increment(1) })
            .catch((e) => console.warn('[pet] weekly quest track error:', e));
    }
};

// Flush pending progress when the tab is hidden; when a LINKED (co-parent)
// tab regains focus, pull the partner's latest save — lastSaved decides who wins.
window.addEventListener('pagehide', () => { if (pendingState) pushNow(); });
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        if (pendingState) pushNow();
    } else {
        refreshIfLinked();
    }
});

async function refreshIfLinked() {
    if (!booted || !partnerRec || !petOwnerUid || !window.__petMergeCloud) return;
    let cloud = null;
    try {
        const snap = await get(ref(db3, savePath(petOwnerUid)));
        cloud = snap.val();
    } catch (e) {
        return;                              // offline: keep playing local
    }
    if (!cloud) return;
    if (window.__petMergeCloud(cloud, false)) {
        // Local is ahead → push it up instead of adopting.
        if (window.__petGetState) { pendingState = window.__petGetState(); flushSoon(); }
    } else {
        if (window.__petRefreshUI) window.__petRefreshUI();
        if (window.__petGetState) localStorage.setItem(SAVE_KEY, JSON.stringify(window.__petGetState()));
    }
}

// ── Auth flow ────────────────────────────────────────────────────────────────

async function handleUser(user) {
    if (!user) {
        uid = null;
        showGate();                        // hard gate: sign in required to play
        return;
    }

    uid = user.uid;

    // Co-parent resolution: a link record makes BOTH accounts play the
    // owner's pet at /pets/{owner}. No link → you play your own.
    partnerRec = null;
    try {
        const linkSnap = await get(ref(db3, `pets_link/${uid}`));
        if (linkSnap.exists()) partnerRec = linkSnap.val();
    } catch (e) {
        console.warn('[pet] co-parent link load failed:', e);   // offline → own pet
    }
    petOwnerUid = (partnerRec && partnerRec.owner) ? partnerRec.owner : uid;

    // Shared-device guard keyed by PET owner (not auth uid): a local save
    // belonging to another account's pet must never merge into — or be
    // pushed up to — this pet's path. Missing owner key = legacy save.
    const ownerChanged = syncedPetOwner !== null && syncedPetOwner !== petOwnerUid;
    const localOwner = localStorage.getItem(OWNER_KEY);
    const foreignLocal = !!localOwner && localOwner !== petOwnerUid;
    if (ownerChanged || foreignLocal) {
        localStorage.removeItem(SAVE_KEY);
    }

    let cloud = null;
    try {
        const snap = await get(ref(db3, savePath(petOwnerUid)));
        cloud = snap.val();
    } catch (e) {
        // Offline or transient failure — boot from the local save instead.
        console.warn('[pet] cloud load failed:', e);
    }

    // Merge the cloud save into the inline game state. Returns true when the
    // local save is ahead (offline play) or the pet has no cloud save yet
    // (first sign-in on this device) — in that case push the local save up.
    let mustPush = false;
    if (window.__petMergeCloud) mustPush = window.__petMergeCloud(cloud, ownerChanged || foreignLocal);
    if (mustPush && window.__petGetState) {
        pendingState = window.__petGetState();
        await pushNow();
    }
    if (window.__petRefreshUI) window.__petRefreshUI();

    localStorage.setItem(OWNER_KEY, petOwnerUid);
    syncedPetOwner = petOwnerUid;
    hideGate();
    if (!booted) {
        booted = true;
        gateResolve();
    }
}

// ── Gate UI wiring ───────────────────────────────────────────────────────────

let gateSignUp = false;
const setGateError = (msg) => {
    const el = $('petGateError');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
};
const gateBusy = (busy) => ['petGateGoogle', 'petGateSubmit'].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = busy;
});

function initGate() {
    if (!$('petGatePanel')) return;
    $('petGateGoogle').addEventListener('click', async () => {
        setGateError('');
        gateBusy(true);
        try {
            await signInWithPopup(auth, new GoogleAuthProvider()); // onAuthStateChanged continues
        } catch (e) {
            setGateError(e.message.replace('Firebase: ', ''));
            gateBusy(false);
        }
    });
    $('petGateToggle').addEventListener('click', () => {
        gateSignUp = !gateSignUp;
        $('petGateTitle').textContent = gateSignUp ? 'Create your Pet account' : 'Sign in to Hangout Pet';
        $('petGateSubmit').textContent = gateSignUp ? 'Create Account' : 'Sign In';
        $('petGateToggle').textContent = gateSignUp ? 'Already have an account? Sign in' : 'Need an account? Create one';
        $('petGatePassword').autocomplete = gateSignUp ? 'new-password' : 'current-password';
        setGateError('');
    });
    $('petGateForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        setGateError('');
        const email = $('petGateEmail').value.trim();
        const pass = $('petGatePassword').value;
        if (!email) return setGateError('Enter your email address.');
        if (!pass || pass.length < 6) return setGateError('Passwords must be at least 6 characters.');
        gateBusy(true);
        $('petGateSubmit').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            if (gateSignUp) {
                // Same profile seeding as the main site so new accounts appear everywhere.
                const cred = await createUserWithEmailAndPassword(auth, email, pass);
                const name = `User_${Math.floor(Math.random() * 999)}`;
                const pic = `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(cred.user.uid)}&backgroundColor=transparent`;
                await updateProfile(cred.user, { displayName: name, photoURL: pic });
                await update(ref(db, `users/${cred.user.uid}`), { uid: cred.user.uid, name, pic });
            } else {
                await signInWithEmailAndPassword(auth, email, pass);
            }
            // Success: onAuthStateChanged continues the flow (buttons stay busy
            // until the gate hides; on failure the catch below re-enables them).
        } catch (e) {
            setGateError(e.message.replace('Firebase: ', ''));
            $('petGateSubmit').textContent = gateSignUp ? 'Create Account' : 'Sign In';
            gateBusy(false);
        }
    });
}
initGate();

// ── Co-parenting (window.PetPartner) ─────────────────────────────────────────
// Invite-code model in RTDB 3: the owner generates a single-use 6-char code at
// /pets_invites/{CODE}; the partner's join writes the SAME link record to
// /pets_link/{ownerUid} and /pets_link/{partnerUid}. On every login pet.js
// resolves petOwnerUid from that link, so BOTH accounts load and save
// /pets/{ownerUid} — one shared pet, lastSaved-wins merge on each boot/focus.

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O/1/I

function makeInviteCode() {
    const bytes = new Uint32Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => INVITE_CHARS[b % INVITE_CHARS.length]).join('');
}

const setPartnerError = (msg) => {
    const el = $('partnerError');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('hidden', !msg);
};
const partnerBusy = (busy) => ['btnGenInvite', 'btnJoinInvite', 'btnUnlink'].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = busy;
});

function showInviteRow(show) {
    const row = $('inviteCodeRow');
    if (!row) return;
    row.classList.toggle('hidden', !show);
    row.classList.toggle('flex', show);       // markup keeps items-* classes for flex
}

function renderPartner() {
    const linked = !!partnerRec;
    const isOwner = linked && partnerRec.owner === uid;
    const otherName = linked ? (isOwner ? partnerRec.partnerName : partnerRec.ownerName) : '';

    const ownerBox = $('partnerOwnerBox');
    const joinBox = $('partnerJoinBox');
    const linkedBox = $('partnerLinkedBox');
    if (ownerBox) ownerBox.classList.toggle('hidden', linked);
    if (joinBox) joinBox.classList.toggle('hidden', linked);
    if (linkedBox) linkedBox.classList.toggle('hidden', !linked);
    showInviteRow(false);
    setPartnerError('');

    const nameEl = $('partnerStatusName');
    const hintEl = $('partnerStatusHint');
    if (linked) {
        if (nameEl) nameEl.textContent = `Co-parenting with ${otherName || 'Partner'}`;
        if (hintEl) hintEl.textContent = isOwner
            ? 'Your partner plays this pet from their account too — progress syncs both ways.'
            : `You're helping raise ${partnerRec.ownerName || 'your partner'}'s pet — progress syncs both ways.`;
        const label = $('btnUnlinkLabel');
        if (label) label.textContent = isOwner ? 'Remove Co-Parent' : 'Leave Co-Parenting';
    } else {
        if (nameEl) nameEl.textContent = 'Raising alone';
        if (hintEl) hintEl.textContent = 'Invite a partner to co-raise this pet — it shows on both accounts.';
    }
}

window.PetPartner = {
    open() {
        const modal = $('partnerModal');
        if (!modal) return;
        if (!uid) return;                     // gate is up anyway when signed out
        renderPartner();
        modal.classList.remove('hidden');
    },

    // Owner: mint a single-use invite code.
    async generate() {
        if (!uid || partnerRec) return;
        setPartnerError('');
        partnerBusy(true);
        try {
            const code = makeInviteCode();
            const ownerName = (auth.currentUser && auth.currentUser.displayName) || 'Partner';
            await set(ref(db3, `pets_invites/${code}`), {
                owner: uid,
                ownerName,
                created: Date.now()
            });
            $('inviteCodeText').textContent = code;
            showInviteRow(true);
        } catch (e) {
            console.warn('[pet] invite generate failed:', e);
            setPartnerError('Could not generate a code — try again.');
        }
        partnerBusy(false);
    },

    copyCode() {
        const code = $('inviteCodeText') && $('inviteCodeText').textContent;
        if (!code) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code)
                .then(() => showToast('Invite code copied!', 'success'))
                .catch(() => {});
        }
    },

    // Partner: redeem an owner's code → link BOTH accounts to the shared pet.
    async join() {
        if (!uid || partnerRec) return;
        setPartnerError('');
        const input = $('inviteInput');
        const code = ((input && input.value) || '').trim().toUpperCase();
        if (code.length !== 6 || [...code].some((c) => !INVITE_CHARS.includes(c))) {
            setPartnerError('Enter the 6-character invite code.');
            return;
        }
        partnerBusy(true);
        try {
            const invSnap = await get(ref(db3, `pets_invites/${code}`));
            if (!invSnap.exists()) {
                setPartnerError('Invalid or used code.');
                partnerBusy(false);
                return;
            }
            const inv = invSnap.val();
            if (inv.owner === uid) {
                setPartnerError("That's your own code.");
                partnerBusy(false);
                return;
            }
            // Single-partner rule: refuse if either side is already linked.
            const [ownerLink, myLink] = await Promise.all([
                get(ref(db3, `pets_link/${inv.owner}`)),
                get(ref(db3, `pets_link/${uid}`))
            ]);
            if (ownerLink.exists() || myLink.exists()) {
                setPartnerError('One of the accounts is already co-parenting.');
                partnerBusy(false);
                return;
            }
            const partnerName = (auth.currentUser && auth.currentUser.displayName) || 'Partner';
            const rec = {
                owner: inv.owner,
                ownerName: inv.ownerName || 'Partner',
                partner: uid,
                partnerName,
                since: Date.now()
            };
            await set(ref(db3, `pets_link/${inv.owner}`), rec);
            await set(ref(db3, `pets_link/${uid}`), rec);
            await remove(ref(db3, `pets_invites/${code}`));   // single-use
            if (input) input.value = '';
            partnerRec = rec;
            petOwnerUid = inv.owner;
            showToast(`Co-parenting with ${rec.ownerName}!`, 'success');
            renderPartner();
            // Full reload: cleanly re-boots the game against the shared pet.
            setTimeout(() => location.reload(), 900);
        } catch (e) {
            console.warn('[pet] join failed:', e);
            setPartnerError('Could not join — check your connection and retry.');
        }
        partnerBusy(false);
    },

    // Either side ends it: both link records go away; each returns to their own pet.
    async unlink() {
        if (!partnerRec) return;
        setPartnerError('');
        partnerBusy(true);
        try {
            await Promise.all([
                remove(ref(db3, `pets_link/${partnerRec.owner}`)),
                remove(ref(db3, `pets_link/${partnerRec.partner}`))
            ]);
            partnerRec = null;
            petOwnerUid = uid;
            showToast('Co-parenting ended. Reopening your pet…', 'info');
            setTimeout(() => location.reload(), 900);   // re-resolve cleanly
        } catch (e) {
            console.warn('[pet] unlink failed:', e);
            setPartnerError('Could not update — try again.');
        }
        partnerBusy(false);
    }
};

function initPartner() {
    if (!$('partnerModal')) return;
    $('btnGenInvite').addEventListener('click', () => window.PetPartner.generate());
    $('btnCopyInvite').addEventListener('click', () => window.PetPartner.copyCode());
    $('btnJoinInvite').addEventListener('click', () => window.PetPartner.join());
    $('btnUnlink').addEventListener('click', () => window.PetPartner.unlink());
    const input = $('inviteInput');
    if (input) input.addEventListener('input', () => { input.value = input.value.toUpperCase(); });
}
initPartner();


// Register the auth listener inside DOMContentLoaded so the inline game
// script's own listener (registered during parsing, which loads the
// localStorage save) always runs first — module listeners fire in
// registration order, so hadLocalSave is set before any cloud merge.
window.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, handleUser);
});
