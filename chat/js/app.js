import { auth, db } from '../../js/firebase-config.js';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, updateProfile } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { get, limitToLast, onDisconnect, onValue, push, query, ref, remove, runTransaction, set, update } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

const $ = (id) => document.getElementById(id);
const state = {
  user: null, users: {}, inbox: {}, online: {}, clears: {}, typing: {}, messages: {}, activeThreadId: null, activeInboxItem: null,
  activePeerId: null, stopMessages: null, stopInbox: null, stopTyping: null, stopClears: null, stopSeen: null, stopThreadSummaries: {}, signUp: false,
  replyTo: null, pendingImageFile: null, inboxReady: false, messagesLoaded: false, typingTimer: null, typingExpiryTimer: null, peerSeenAt: 0, groupSeenAt: {}, connected: false,
  groupMode: false, groupSelection: []
};
const reactions = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', sad: '😢' };
reactions.angry = '😡';
const fallbackAvatar = (seed = 'hangout') => `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}&backgroundColor=transparent`;
const presenceSessionId = `chat_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;

function escapeHtml(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function linkifyText(value = '') {
  return escapeHtml(value).replace(/https?:\/\/[^\s<]+/gi, (url) => {
    const href = url.replace(/[),.!?]+$/, ''); const trailing = url.slice(href.length);
    return `<a class="message-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trailing}`;
  });
}
function avatarUrl(user = {}) { const url = String(user.pic || user.photoURL || ''); return /^(https?:|data:image\/)/i.test(url) ? url : fallbackAvatar(user.uid || user.name || 'hangout'); }
function formatTime(timestamp) { if (!timestamp) return ''; const date = new Date(timestamp); return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function showToast(message) { const toast = $('toast'); toast.textContent = message; toast.classList.remove('hidden'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add('hidden'), 3500); }
function isOnline(uid) { const presence = state.online[uid]; return presence === true || Boolean(presence && typeof presence === 'object' && Object.keys(presence).length); }
function threadIdFor(peerId) { return `dm_${[state.user.uid, peerId].sort().join('_')}`; }
function normalStatus(uid) { return `<i class="online-dot${isOnline(uid) ? ' online' : ''}"></i>${isOnline(uid) ? 'Online' : 'Offline'}`; }

function getNickname(uid) {
  if (state.activeThreadId && state.inbox[state.activeThreadId]?.nicknames?.[uid]) return state.inbox[state.activeThreadId].nicknames[uid];
  return state.users[uid]?.name || 'Hangout member';
}
function getThreadPeers(item) {
  if (item.isGroup) return Object.keys(item.members || {}).filter(uid => uid !== state.user?.uid);
  return item.peerId ? [item.peerId] : [];
}
function getThreadName(item, peerIds) {
  if (item.isGroup && item.name) return item.name;
  if (!peerIds.length) return 'Empty Group';
  return peerIds.map(uid => (item.nicknames && item.nicknames[uid]) || state.users[uid]?.name || 'Member').join(', ');
}
function renderAvatarHtml(peerIds) {
  if (!peerIds || peerIds.length === 0) return `<img class="avatar" src="${escapeHtml(fallbackAvatar('group'))}" alt="">`;
  if (peerIds.length === 1) return `<img class="avatar" src="${escapeHtml(avatarUrl(state.users[peerIds[0]]))}" alt="">`;
  const count = Math.min(peerIds.length, 4);
  const imgs = peerIds.slice(0, 4).map(uid => `<img src="${escapeHtml(avatarUrl(state.users[uid]))}" alt="">`).join('');
  return `<div class="avatar-collage count-${count}">${imgs}</div>`;
}
function applyTheme(theme) {
  const dark = theme === 'dark'; document.documentElement.classList.toggle('dark', dark); localStorage.setItem('hangout-chat-theme', dark ? 'dark' : 'light');
  const toggle = $('theme-toggle'); if (toggle) { toggle.textContent = dark ? '☀' : '☾'; toggle.title = dark ? 'Switch to light theme' : 'Switch to dark theme'; toggle.setAttribute('aria-label', toggle.title); }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1320' : '#1877f2');
}
applyTheme(localStorage.getItem('hangout-chat-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

function showAppModal(options = {}) {
  return new Promise((resolve) => {
    const modal = $('app-modal');
    if (modal.open) modal.close();
    $('app-modal-title').textContent = options.title || 'Confirm';
    const confirmBtn = $('app-modal-confirm');
    const cancelBtn = $('app-modal-cancel');
    confirmBtn.textContent = options.confirmText || 'Confirm';
    cancelBtn.textContent = options.cancelText || 'Cancel';
    confirmBtn.className = `app-modal-btn ${options.danger ? 'danger' : 'primary'}`;
    let html = '';
    if (options.message) html += `<p class="app-modal-message">${escapeHtml(options.message)}</p>`;
    if (options.textarea) html += `<textarea id="app-modal-input" class="app-modal-input" rows="6" style="resize:vertical;">${escapeHtml(options.inputValue || '')}</textarea>`;
    else if (options.input) html += `<input id="app-modal-input" class="app-modal-input" type="text" value="${escapeHtml(options.inputValue || '')}" placeholder="${escapeHtml(options.placeholder || '')}">`;
    if (options.memberList) {
      html += `<label class="search-box app-modal-search"><span>⌕</span><input id="app-modal-search-input" type="search" autocomplete="off" placeholder="Search members"></label>`;
      html += `<div id="app-modal-member-list" class="member-select-list"></div>`;
    }
    $('app-modal-body').innerHTML = html;
    let selected = [];
    if (options.memberList) {
      const render = (term = '') => {
        const el = $('app-modal-member-list');
        const list = options.memberList.filter(m => !term || m.name.toLowerCase().includes(term));
        el.innerHTML = list.length ? list.map(m => {
          const on = selected.includes(m.uid);
          const badge = m.isCreator ? `<span class="creator-badge" style="margin-left:auto; font-size:10px; background:var(--primary); color:#fff; padding:2px 6px; border-radius:8px;">Creator</span>` : '';
          const disableCheck = m.uid === options.disabledUid ? ' disabled' : '';
          return `<button class="member-select-item${on ? ' selected' : ''}" data-uid="${escapeHtml(m.uid)}" type="button" ${disableCheck}><img class="avatar" src="${escapeHtml(m.avatar)}" alt=""><span class="member-select-name">${escapeHtml(m.name)}</span>${badge}${options.multiSelect ? `<span class="member-select-check">${on ? '✓' : ''}</span>` : ''}</button>`;
        }).join('') : '<p class="list-empty">No members found.</p>';
        el.querySelectorAll('.member-select-item').forEach(b => b.addEventListener('click', () => {
          const uid = b.dataset.uid;
          if (options.multiSelect) { selected = selected.includes(uid) ? selected.filter(i => i !== uid) : [...selected, uid]; }
          else { selected = selected[0] === uid ? [] : [uid]; }
          render(term);
        }));
      };
      render();
      $('app-modal-search-input')?.addEventListener('input', e => render(e.target.value.trim().toLowerCase()));
    }
    let done = false;
    const finish = (val) => { if (done) return; done = true; modal.close(); resolve(val); };
    confirmBtn.onclick = () => finish((options.input || options.textarea) ? ($('app-modal-input')?.value ?? '') : options.memberList ? selected : true);
    cancelBtn.onclick = () => finish(null);
    $('app-modal-close').onclick = () => finish(null);
    modal.onclose = () => { if (modal.open) return; finish(null); };
    if (options.input || options.textarea) {
      const inp = $('app-modal-input');
      if (inp && options.input) inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); } });
    }
    modal.showModal();
    if (options.input || options.textarea) $('app-modal-input')?.focus();
    else if (options.memberList) $('app-modal-search-input')?.focus();
  });
}

function updateUnreadTitle() {
  const unread = Object.values(state.inbox).reduce((total, item) => total + Number(item.unreadCount || 0), 0);
  document.title = unread ? `(${unread > 99 ? '99+' : unread}) Hangout Messenger` : 'Hangout Messenger';
}

function renderConversations() {
  const list = $('conversation-list');
  const term = $('conversation-search').value.trim().toLowerCase();
  const items = Object.entries(state.inbox).map(([id, item]) => ({ id, ...item })).filter((item) => {
    const peerIds = getThreadPeers(item);
    const name = getThreadName(item, peerIds).toLowerCase();
    return !term || `${name} ${item.lastMessage || ''}`.toLowerCase().includes(term);
  }).sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  if (!state.user) { list.innerHTML = ''; return; }
  if (!items.length) { list.innerHTML = '<p class="list-empty">No conversations yet. Tap the compose button to say hello.</p>'; return; }
  list.innerHTML = items.map((item) => {
    const peerIds = getThreadPeers(item);
    const name = getThreadName(item, peerIds);
    const unread = Number(item.unreadCount || 0);
    const preview = item.lastSenderId === state.user.uid ? `You: ${item.lastMessage || ''}` : (item.lastMessage || 'Start chatting');
    const presenceHtml = !item.isGroup && peerIds.length === 1 ? `<i class="conversation-presence${isOnline(peerIds[0]) ? ' online' : ''}" aria-label="${isOnline(peerIds[0]) ? 'Online' : 'Offline'}"></i>` : '';
    return `<button class="conversation${item.id === state.activeThreadId ? ' selected' : ''}${unread ? ' unread' : ''}" data-thread="${escapeHtml(item.id)}"><span class="conversation-avatar">${renderAvatarHtml(peerIds)}${presenceHtml}</span><span class="conversation-copy"><span class="conversation-top"><span class="conversation-name">${escapeHtml(name)}</span><span class="conversation-time">${formatTime(item.lastTimestamp)}</span></span><span class="conversation-preview"><span>${escapeHtml(preview)}</span>${unread ? `<b class="unread-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</span></span></button>`;
  }).join('');
  list.querySelectorAll('.conversation').forEach((button) => button.addEventListener('click', () => {
    const threadId = button.dataset.thread;
    openThread(threadId, state.inbox[threadId]);
  }));
}

function renderPeople() {
  const list = $('people-list');
  const term = $('people-search').value.trim().toLowerCase();
  const people = Object.values(state.users).filter((person) => person.uid && person.uid !== state.user?.uid && (!term || `${person.name || ''}`.toLowerCase().includes(term))).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!people.length) { list.innerHTML = '<p class="list-empty">No matching members found.</p>'; return; }
  list.innerHTML = people.map((person) => {
    const isSelected = state.groupSelection?.includes(person.uid);
    return `<button class="person${isSelected ? ' selected' : ''}" data-user="${escapeHtml(person.uid)}"><img class="avatar" src="${escapeHtml(avatarUrl(person))}" alt=""><span class="person-copy"><span class="person-name">${escapeHtml(person.name || 'Hangout member')}</span><span class="person-status"><i class="online-dot${isOnline(person.uid) ? ' online' : ''}"></i>${person.isBanned ? 'Unavailable' : isOnline(person.uid) ? 'Online' : 'Offline'}</span></span>${state.groupMode ? `<input type="checkbox" style="pointer-events:none; margin-left:auto;" ${isSelected ? 'checked' : ''}>` : ''}</button>`;
  }).join('');
  list.querySelectorAll('.person').forEach((button) => button.addEventListener('click', () => {
    if (state.groupMode) {
      const uid = button.dataset.user;
      if (state.groupSelection.includes(uid)) state.groupSelection = state.groupSelection.filter(id => id !== uid);
      else state.groupSelection.push(uid);
      renderPeople();
    } else {
      startConversation(button.dataset.user);
    }
  }));
}

function peerIsTyping() { 
  if (state.activeInboxItem?.isGroup) return Object.keys(state.typing || {}).filter(uid => uid !== state.user?.uid && Number(state.typing[uid]) > Date.now() - 7000);
  return Boolean(state.activePeerId && Number(state.typing[state.activePeerId] || 0) > Date.now() - 7000); 
}
function updateChatHeader() {
  if (!state.activeThreadId || !state.activeInboxItem) return;
  const item = state.activeInboxItem;
  const peerIds = getThreadPeers(item);
  const name = getThreadName(item, peerIds);
  
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = renderAvatarHtml(peerIds);
  const newAvatar = tempDiv.firstChild;
  if (newAvatar.tagName === 'IMG') newAvatar.classList.add('avatar', 'large');
  else if (newAvatar.classList.contains('avatar-collage')) newAvatar.classList.add('large');
  
  const avatarContainer = $('chat-avatar');
  if (avatarContainer) { newAvatar.id = 'chat-avatar'; avatarContainer.replaceWith(newAvatar); }

  $('chat-name').textContent = name;
  
  const typingPeers = item.isGroup ? peerIsTyping() : (peerIsTyping() ? [state.activePeerId] : []);
  if (typingPeers.length > 0) {
    const typistName = typingPeers.length === 1 ? getNickname(typingPeers[0]) : `${typingPeers.length} people`;
    $('chat-status').innerHTML = `<span class="typing-status">${escapeHtml(typistName)} is typing…</span>`;
    clearTimeout(state.typingExpiryTimer);
    state.typingExpiryTimer = setTimeout(updateChatHeader, 7100);
  } else {
    if (item.isGroup) {
      $('chat-status').textContent = `${peerIds.length + 1} members`;
    } else {
      const peer = state.users[peerIds[0]] || {};
      $('chat-status').innerHTML = peer.isBanned ? 'Unavailable' : normalStatus(peerIds[0]);
    }
  }
}

function replyPreview(replyTo = {}) { return replyTo.text || (replyTo.hasImage ? 'Photo' : 'Message'); }
function visibleMessages(rawMessages = state.messages) {
  const clearTime = Number(state.clears[state.activeThreadId] || 0);
  return Object.entries(rawMessages || {}).map(([id, message]) => ({ id, ...message })).filter((message) => Number(message.timestamp || 0) > clearTime).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function renderMessages(rawMessages, jumpToLatest = false) {
  state.messages = rawMessages || {};
  const list = $('message-list');
  const wasNearLatest = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const rows = visibleMessages();
  if (!rows.length) { list.innerHTML = '<p class="list-empty messages-empty">No messages yet. Say hello!</p>'; return; }
  const latestSeenMessageId = [...rows].reverse().find((message) => message.senderId === state.user?.uid && Number(message.timestamp || 0) <= state.peerSeenAt)?.id;
  const groupLatestSeen = {};
  if (state.activeInboxItem?.isGroup) {
    Object.entries(state.groupSeenAt || {}).forEach(([uid, time]) => {
      if (uid === state.user?.uid) return;
      const msg = [...rows].reverse().find(m => Number(m.timestamp || 0) <= time);
      if (msg) {
        if (!groupLatestSeen[msg.id]) groupLatestSeen[msg.id] = [];
        groupLatestSeen[msg.id].push(uid);
      }
    });
  }
  list.innerHTML = rows.map((message) => {
    if (message.isSystem) return `<div class="message-row system" style="text-align:center; font-size:12px; color:var(--muted); margin: 8px 0; width: 100%; justify-content: center;">${escapeHtml(getNickname(message.senderId))} ${escapeHtml(message.text)}</div>`;
    const mine = message.senderId === state.user?.uid;
    const reactionSummary = Object.entries(message.reactions || {}).map(([type, people]) => Object.keys(people || {}).length ? `<span class="reaction-chip">${reactions[type] || ''} ${Object.keys(people).length}</span>` : '').join('');
    const quote = message.replyTo ? `<div class="reply-quote">Reply to ${escapeHtml(getNickname(message.replyTo.senderId))}: ${escapeHtml(replyPreview(message.replyTo))}</div>` : '';
    const image = message.image ? `<img class="message-image" src="${escapeHtml(message.image)}" alt="Shared photo">` : '';
    
    let seen = '';
    if (state.activeInboxItem?.isGroup) {
      const viewers = groupLatestSeen[message.id];
      if (viewers && viewers.length) {
        const avatars = viewers.map(uid => `<img class="avatar micro" src="${escapeHtml(avatarUrl(state.users[uid]))}" title="${escapeHtml(getNickname(uid))}" style="width:14px; height:14px; border-radius:50%; margin-right:2px; object-fit:cover;">`).join('');
        seen = `<span class="seen-label group-seen" style="display:flex; align-items:center; margin-left:4px;" title="Seen by ${escapeHtml(viewers.map(uid => getNickname(uid)).join(', '))}">${avatars}</span>`;
      }
    } else {
      seen = mine && message.id === latestSeenMessageId ? '<span class="seen-label">Seen</span>' : '';
    }
    
    const senderNameHtml = (state.activeInboxItem?.isGroup && !mine) ? `<div class="message-sender-name" style="font-size:10px; color:var(--muted); margin-bottom:2px; margin-left:4px;">${escapeHtml(getNickname(message.senderId))}</div>` : '';
    return `<div class="message-row${mine ? ' me' : ''}"><div>${senderNameHtml}<div class="message-bubble" data-message="${escapeHtml(message.id)}">${quote}${linkifyText(message.text || '')}${image}</div><div class="message-meta"><div class="message-time hidden">${formatTime(message.timestamp)}</div>${message.editedAt ? '<span class="edited-label">Edited</span>' : ''}${seen}</div>${reactionSummary ? `<div class="reaction-summary">${reactionSummary}</div>` : ''}</div></div>`;
  }).join('');
  wireMessageGestures(rows);
  if (jumpToLatest || wasNearLatest) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function closeMessageMenu() { $('message-action-menu').classList.add('hidden'); $('message-action-menu').innerHTML = ''; }
function showMessageMenu(message, x, y) {
  if (!message) return;
  const menu = $('message-action-menu');
  const reactionButtons = Object.entries(reactions).map(([type, emoji]) => `<button class="reaction-option" type="button" data-menu-action="react" data-reaction="${type}" aria-label="React ${type}">${emoji}</button>`).join('');
  menu.innerHTML = `${reactionButtons}<span class="menu-separator"></span><button type="button" data-menu-action="reply">Reply</button>${message.senderId === state.user?.uid ? '<button type="button" data-menu-action="edit">Edit</button>' : ''}`;
  menu.classList.remove('hidden');
  menu.style.left = `${Math.max(12, Math.min(x, window.innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = `${Math.max(12, Math.min(y, window.innerHeight - menu.offsetHeight - 12))}px`;
  menu.querySelectorAll('[data-menu-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.menuAction;
    if (action === 'react') await toggleReaction(message.id, button.dataset.reaction);
    if (action === 'reply') setReply(message);
    if (action === 'edit') await editMessage(message);
    closeMessageMenu();
  }));
}

function wireMessageGestures(rows) {
  $('message-list').querySelectorAll('.message-bubble').forEach((bubble) => {
    const message = rows.find((row) => row.id === bubble.dataset.message); let pressTimer; let pressed = false;
    const cancel = () => { clearTimeout(pressTimer); pressTimer = null; };
    bubble.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.message-link')) return;
      pressed = true; pressTimer = setTimeout(() => { if (pressed) showMessageMenu(message, event.clientX, event.clientY); }, 500);
    });
    bubble.addEventListener('click', (event) => {
      if (event.target.closest('.message-link')) return;
      const meta = bubble.nextElementSibling;
      if (meta && meta.classList.contains('message-meta')) {
        const time = meta.querySelector('.message-time');
        if (time) time.classList.toggle('hidden');
      }
    });
    bubble.addEventListener('pointerup', cancel); bubble.addEventListener('pointercancel', cancel); bubble.addEventListener('pointerleave', cancel);
    bubble.addEventListener('contextmenu', (event) => { event.preventDefault(); cancel(); showMessageMenu(message, event.clientX, event.clientY); });
    bubble.addEventListener('click', (event) => { if (pressed) event.preventDefault(); });
  });
}

async function markThreadRead(threadId = state.activeThreadId) {
  if (!state.user || !threadId) return;
  markThreadSeen(threadId);
  if (!state.inbox[threadId]?.unreadCount) return;
  try { await update(ref(db, `chatInboxes/${state.user.uid}/${threadId}`), { unreadCount: 0 }); } catch { /* A brief offline state should not block reading. */ }
}

function markThreadSeen(threadId = state.activeThreadId) {
  if (!state.user || !threadId) return;
  set(ref(db, `chatReads/${state.user.uid}/${threadId}`), Date.now()).catch(() => {});
}
function watchSeen(threadId) {
  if (state.stopSeen) {
    if (typeof state.stopSeen === 'function') state.stopSeen();
    else if (Array.isArray(state.stopSeen)) state.stopSeen.forEach(fn => fn());
  }
  state.stopSeen = null; state.peerSeenAt = 0; state.groupSeenAt = {};
  if (state.activeInboxItem?.isGroup) {
    const peerIds = getThreadPeers(state.activeInboxItem);
    state.stopSeen = peerIds.map(uid => 
      onValue(ref(db, `chatReads/${uid}/${threadId}`), (snapshot) => {
        state.groupSeenAt[uid] = Number(snapshot.val() || 0);
        renderMessages(state.messages);
      }, (error) => reportRealtimeError('seen receipts', error))
    );
    return;
  }
  state.stopSeen = onValue(ref(db, `chatReads/${state.activePeerId}/${threadId}`), (snapshot) => { state.peerSeenAt = Number(snapshot.val() || 0); renderMessages(state.messages); }, (error) => reportRealtimeError('seen receipts', error));
}

function watchTyping(threadId) {
  if (state.stopTyping) state.stopTyping(); state.typing = {};
  state.stopTyping = onValue(ref(db, `chatTyping/${threadId}`), (snapshot) => { state.typing = snapshot.val() || {}; updateChatHeader(); });
}
function openThread(threadId, inboxItem) {
  if (!state.user) return showAuth();
  state.activeThreadId = threadId; 
  state.activeInboxItem = inboxItem || state.inbox[threadId] || {};
  state.activePeerId = state.activeInboxItem.isGroup ? null : state.activeInboxItem.peerId;
  $('empty-state').classList.add('hidden'); $('active-chat').classList.remove('hidden'); updateChatHeader(); renderConversations(); markThreadRead(threadId);
  if (state.stopMessages) state.stopMessages();
  state.messages = {}; state.messagesLoaded = false; $('message-list').innerHTML = '<p class="list-empty messages-empty">Loading recent messages…</p>';
  state.stopMessages = onValue(query(ref(db, `chatMessages/${threadId}`), limitToLast(60)), (snapshot) => { const firstLoad = !state.messagesLoaded; state.messagesLoaded = true; renderMessages(snapshot.val(), firstLoad); markThreadSeen(threadId); });
  watchTyping(threadId); watchSeen(threadId); $('message-input').focus();
}

async function startConversation(peerId) {
  if (!state.user) return showAuth(); const peer = state.users[peerId]; if (!peer || peer.isBanned) return showToast('This member is unavailable.');
  const threadId = threadIdFor(peerId);
  try {
    const threadRef = ref(db, `chatThreads/${threadId}`); const snapshot = await get(threadRef); const now = Date.now();
    if (!snapshot.exists()) await set(threadRef, { members: { [state.user.uid]: true, [peerId]: true }, createdAt: now, lastMessage: 'Start a conversation', lastTimestamp: now, lastSenderId: state.user.uid });
    const thread = snapshot.val() || {}; const summary = { peerId, lastMessage: thread.lastMessage || 'Start a conversation', lastTimestamp: thread.lastTimestamp || now, lastSenderId: thread.lastSenderId || state.user.uid, unreadCount: 0 };
    await set(ref(db, `chatInboxes/${state.user.uid}/${threadId}`), summary);
    try { await runTransaction(ref(db, `chatInboxes/${peerId}/${threadId}`), (current) => current || { ...summary, peerId: state.user.uid }); } catch (error) { console.warn('Conversation was created, but the recipient inbox entry could not be created yet:', error); }
    $('people-dialog').close(); openThread(threadId, summary);
  } catch (error) { console.error('Could not start conversation:', error); showToast(`Could not start chat: ${error.message.replace('Firebase: ', '')}`); }
}

async function startGroupConversation(peerIds) {
  if (!state.user) return showAuth();
  const threadId = `group_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
  try {
    const members = { [state.user.uid]: true };
    peerIds.forEach(id => members[id] = true);
    const now = Date.now();
    await set(ref(db, `chatThreads/${threadId}`), { members, isGroup: true, creatorId: state.user.uid, createdAt: now, lastMessage: 'Group created', lastTimestamp: now, lastSenderId: state.user.uid });
    const summary = { isGroup: true, members, lastMessage: 'Group created', lastTimestamp: now, lastSenderId: state.user.uid, unreadCount: 0, creatorId: state.user.uid };
    await set(ref(db, `chatInboxes/${state.user.uid}/${threadId}`), summary);
    peerIds.forEach(id => runTransaction(ref(db, `chatInboxes/${id}/${threadId}`), (current) => current || summary).catch(()=>{}));
    
    $('people-dialog').close();
    state.groupMode = false;
    state.groupSelection = [];
    $('group-action-bar').classList.add('hidden');
    $('toggle-group-mode').textContent = 'Create Group';
    openThread(threadId, summary);
  } catch (error) { showToast(`Could not start group chat: ${error.message}`); }
}

function compressImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return Promise.reject(new Error('Choose a JPG, PNG, or WebP image.'));
  if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error('Choose an image smaller than 10 MB.'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read that image.')); reader.onload = () => {
      const image = new Image(); image.onerror = () => reject(new Error('Could not process that image.')); image.onload = () => {
        const maxSide = 720; const scale = Math.min(1, maxSide / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); const output = canvas.toDataURL('image/jpeg', 0.55);
        if (output.length > 850000) reject(new Error('That image is still too large after compression. Try a smaller one.')); else resolve(output);
      }; image.src = reader.result;
    }; reader.readAsDataURL(file);
  });
}

async function useUploadQuota() {
  const day = new Date().toISOString().slice(0, 10); const result = await runTransaction(ref(db, `chatUploadQuota/${state.user.uid}/${day}`), (count) => (Number(count || 0) >= 3 ? undefined : Number(count || 0) + 1));
  if (!result.committed) throw new Error('Daily photo limit reached (3 uploads). Try again tomorrow.');
}

function clearAttachment() { $('image-input').value = ''; state.pendingImageFile = null; }
function resetComposer() { $('message-input').value = ''; $('message-input').style.height = ''; clearAttachment(); clearReply(); setTyping(false); $('message-input').focus(); }
async function updateConversationSummaries(preview, timestamp) {
  const own = { ...(state.inbox[state.activeThreadId] || {}), lastMessage: preview, lastTimestamp: timestamp, lastSenderId: state.user.uid, unreadCount: 0 };
  if (!state.activeInboxItem?.isGroup) own.peerId = state.activePeerId;
  delete own.name; delete own.nicknames; delete own.creatorId;
  await update(ref(db), {
    [`chatThreads/${state.activeThreadId}/lastMessage`]: preview, [`chatThreads/${state.activeThreadId}/lastTimestamp`]: timestamp, [`chatThreads/${state.activeThreadId}/lastSenderId`]: state.user.uid,
    [`chatInboxes/${state.user.uid}/${state.activeThreadId}`]: own
  });
  const peerIds = getThreadPeers(state.activeInboxItem);
  const isGroup = state.activeInboxItem?.isGroup;
  peerIds.forEach(id => {
    runTransaction(ref(db, `chatInboxes/${id}/${state.activeThreadId}`), (current) => {
      const base = { ...(current || own) };
      if (isGroup) { base.isGroup = true; base.members = state.activeInboxItem.members || own.members || {}; delete base.peerId; }
      else { base.peerId = state.user.uid; }
      base.lastMessage = preview; base.lastTimestamp = timestamp; base.lastSenderId = state.user.uid;
      base.unreadCount = Math.min(Number(base.unreadCount || 0) + 1, 99);
      return base;
    }).catch(()=>{});
  });
}
async function sendMessage(event) {
  event.preventDefault(); if (!state.user || !state.activeThreadId) return;
  const input = $('message-input'); const text = input.value.trim(); const file = state.pendingImageFile; if (!text && !file) return;
  const button = $('send-button'); button.disabled = true;
  try {
    const image = file ? await compressImage(file) : null; if (image) await useUploadQuota();
    const timestamp = Date.now(); const payload = { senderId: state.user.uid, text, timestamp };
    if (image) payload.image = image;
    if (state.replyTo) payload.replyTo = { id: state.replyTo.id, senderId: state.replyTo.senderId, text: (state.replyTo.text || '').slice(0, 120), hasImage: Boolean(state.replyTo.image) };
    await push(ref(db, `chatMessages/${state.activeThreadId}`), payload);
    resetComposer();
    try { await updateConversationSummaries(text || '📷 Photo', timestamp); } catch (error) { console.error('Message was sent, but its inbox summary failed:', error); }
  } catch (error) {
    if (file && /Daily photo limit reached/.test(error.message)) { clearAttachment(); showToast('Daily photo limit reached. The photo was removed—your text is ready to send.'); }
    else showToast(`Could not send: ${error.message.replace('Firebase: ', '')}`);
  }
  button.disabled = false;
}

async function toggleReaction(messageId, reaction) {
  if (!state.user || !state.activeThreadId) return;
  const current = Boolean(state.messages[messageId]?.reactions?.[reaction]?.[state.user.uid]);
  const updates = Object.fromEntries(Object.keys(reactions).map((type) => [`${type}/${state.user.uid}`, current || type !== reaction ? null : true]));
  try { await update(ref(db, `chatMessages/${state.activeThreadId}/${messageId}/reactions`), updates); } catch (error) { showToast(`Could not react: ${error.message.replace('Firebase: ', '')}`); }
}
function setReply(message) { if (!message) return; state.replyTo = message; $('reply-banner-text').textContent = `Replying to ${getNickname(message.senderId)}: ${replyPreview(message)}`; $('reply-banner').classList.remove('hidden'); $('message-input').focus(); }
function clearReply() { state.replyTo = null; $('reply-banner').classList.add('hidden'); }
async function editMessage(message) {
  if (!state.user || !state.activeThreadId || message.senderId !== state.user.uid) return;
  const newText = await showAppModal({ title: 'Edit Message', textarea: true, inputValue: message.text, confirmText: 'Save' });
  if (newText === null || newText.trim() === message.text) return;
  if (!newText.trim()) return showToast('Message cannot be empty.');
  try {
    await update(ref(db, `chatMessages/${state.activeThreadId}/${message.id}`), { text: newText.trim(), editedAt: Date.now() });
    updateConversationSummaries(newText.trim(), Date.now());
    showToast('Message edited.');
  } catch (err) { showToast('Could not edit message.'); }
}

function setTyping(active) {
  if (!state.user || !state.activeThreadId) return;
  const path = ref(db, `chatTyping/${state.activeThreadId}/${state.user.uid}`);
  (active ? set(path, Date.now()) : remove(path)).catch(() => {});
}
function noteTyping() { setTyping(true); clearTimeout(state.typingTimer); state.typingTimer = setTimeout(() => setTyping(false), 1600); }
function closeActiveChat() {
  setTyping(false); clearTimeout(state.typingTimer); if (state.stopMessages) state.stopMessages(); if (state.stopTyping) state.stopTyping();
  state.stopMessages = null; state.stopTyping = null;
  if (state.stopSeen) {
    if (typeof state.stopSeen === 'function') state.stopSeen();
    else if (Array.isArray(state.stopSeen)) state.stopSeen.forEach(fn => fn());
  }
  state.stopSeen = null; state.activeThreadId = null; state.activePeerId = null; state.activeInboxItem = null; state.messages = {}; state.messagesLoaded = false; state.typing = {}; state.peerSeenAt = 0; state.groupSeenAt = {}; clearReply(); closeMessageMenu();
  $('active-chat').classList.add('hidden'); $('empty-state').classList.remove('hidden'); renderConversations();
}
async function clearChatForMe() {
  if (!state.user || !state.activeThreadId) return;
  try { await set(ref(db, `chatClears/${state.user.uid}/${state.activeThreadId}`), Date.now()); $('conversation-dialog').close(); renderMessages(state.messages); showToast('Messages cleared for you.'); } catch (error) { showToast(`Could not clear messages: ${error.message.replace('Firebase: ', '')}`); }
}
async function removeConversation() {
  if (!state.user || !state.activeThreadId) return;
  $('conversation-dialog').close();
  const confirmed = await showAppModal({ title: 'Remove Conversation', message: 'Remove this conversation from your inbox? Your messages will remain for the other member.', confirmText: 'Remove', danger: true });
  if (!confirmed) return;
  try { const threadId = state.activeThreadId; await set(ref(db, `chatClears/${state.user.uid}/${threadId}`), Date.now()); await remove(ref(db, `chatInboxes/${state.user.uid}/${threadId}`)); closeActiveChat(); showToast('Conversation removed. Its old messages will stay cleared if you chat again.'); } catch (error) { showToast(`Could not remove conversation: ${error.message.replace('Firebase: ', '')}`); }
}

function showAuth() { $('auth-dialog').showModal(); }
function syncAuthUi() { $('signed-out-card').classList.toggle('hidden', Boolean(state.user)); renderConversations(); }
function startOwnPresence() {
  if (!state.user || !state.connected) return;
  const ownPresence = ref(db, `presence/${state.user.uid}/${presenceSessionId}`);
  onDisconnect(ownPresence).remove().catch(() => {});
  set(ownPresence, true).catch(() => {});
}
function stopOwnPresence(user = state.user) {
  if (user) remove(ref(db, `presence/${user.uid}/${presenceSessionId}`)).catch(() => {});
}
function reportRealtimeError(scope, error) {
  console.error(`Realtime ${scope} listener failed:`, error);
  showToast('Live updates disconnected. Refresh the page and check your connection.');
}
function stopThreadSummaryWatchers() {
  Object.values(state.stopThreadSummaries).forEach((stop) => stop());
  state.stopThreadSummaries = {};
}
function syncThreadSummaryWatchers() {
  const threadIds = new Set(Object.keys(state.inbox));
  Object.entries(state.stopThreadSummaries).forEach(([threadId, stop]) => {
    if (!threadIds.has(threadId)) { stop(); delete state.stopThreadSummaries[threadId]; }
  });
  threadIds.forEach((threadId) => {
    if (state.stopThreadSummaries[threadId]) return;
    state.stopThreadSummaries[threadId] = onValue(ref(db, `chatThreads/${threadId}`), (snapshot) => {
      const thread = snapshot.val(); const current = state.inbox[threadId];
      if (!thread || !current || Number(thread.lastTimestamp || 0) < Number(current.lastTimestamp || 0)) return;
      const next = { ...current, lastMessage: thread.lastMessage || '', lastTimestamp: thread.lastTimestamp || 0, lastSenderId: thread.lastSenderId || '', nicknames: thread.nicknames || {}, members: thread.members || {}, creatorId: thread.creatorId || current.creatorId || '', name: thread.name || current.name || '' };
      if (next.lastMessage === current.lastMessage && next.lastTimestamp === current.lastTimestamp && next.lastSenderId === current.lastSenderId && JSON.stringify(next.nicknames) === JSON.stringify(current.nicknames || {}) && next.name === (current.name || '') && JSON.stringify(next.members) === JSON.stringify(current.members || {})) return;
      state.inbox = { ...state.inbox, [threadId]: next };
      if (state.activeThreadId === threadId) { state.activeInboxItem = next; updateChatHeader(); renderMessages(state.messages); }
      renderConversations();
    }, (error) => reportRealtimeError('conversation summary', error));
  });
}
function handleInbox(snapshot) {
  const previous = state.inbox; const next = snapshot.val() || {};
  Object.keys(next).forEach(id => {
    if (previous[id]) {
      if (previous[id].name !== undefined) next[id].name = previous[id].name;
      if (previous[id].creatorId !== undefined) next[id].creatorId = previous[id].creatorId;
      if (previous[id].members !== undefined) next[id].members = previous[id].members;
      if (previous[id].nicknames !== undefined) next[id].nicknames = previous[id].nicknames;
    }
  });
  state.inbox = next;
  if (state.inboxReady && state.user) Object.entries(next).forEach(([threadId, item]) => {
    const before = previous[threadId];
    if (item.lastSenderId !== state.user.uid && Number(item.lastTimestamp || 0) > Number(before?.lastTimestamp || 0)) showToast(`New message from ${state.users[item.peerId]?.name || 'a member'}`);
  });
  state.inboxReady = true; syncThreadSummaryWatchers(); renderConversations(); updateUnreadTitle(); markThreadRead();
}

onValue(ref(db, 'users'), (snapshot) => { const raw = snapshot.val() || {}; state.users = Object.fromEntries(Object.entries(raw).map(([uid, profile]) => [uid, { ...(profile || {}), uid }])); renderConversations(); renderPeople(); updateChatHeader(); }, (error) => reportRealtimeError('member list', error));
onValue(ref(db, 'presence'), (snapshot) => { state.online = snapshot.val() || {}; renderConversations(); renderPeople(); updateChatHeader(); }, (error) => reportRealtimeError('presence', error));
onValue(ref(db, '.info/connected'), (snapshot) => { state.connected = snapshot.val() === true; if (state.connected) startOwnPresence(); });
onAuthStateChanged(auth, (user) => {
  const previousUser = state.user; if (previousUser && previousUser.uid !== user?.uid) stopOwnPresence(previousUser);
  state.user = user; if (state.stopInbox) state.stopInbox(); if (state.stopClears) state.stopClears(); stopThreadSummaryWatchers(); state.inbox = {}; state.clears = {}; state.inboxReady = false;
  if (user) {
    startOwnPresence();
    state.stopInbox = onValue(ref(db, `chatInboxes/${user.uid}`), handleInbox, (error) => reportRealtimeError('conversation list', error));
    state.stopClears = onValue(ref(db, `chatClears/${user.uid}`), (snapshot) => { state.clears = snapshot.val() || {}; if (state.activeThreadId) renderMessages(state.messages); }, (error) => reportRealtimeError('message clears', error));
  } else closeActiveChat();
  syncAuthUi(); updateUnreadTitle();
});

$('new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth()); $('empty-new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth()); $('show-auth-button').addEventListener('click', showAuth);
$('theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'));
$('conversation-search').addEventListener('input', renderConversations); $('people-search').addEventListener('input', renderPeople); $('message-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`; if (event.target.value.trim()) noteTyping(); else setTyping(false); });
$('message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { 
  if (window.innerWidth < 768 || matchMedia('(pointer: coarse)').matches) return;
  event.preventDefault(); $('message-form').requestSubmit(); 
} });
$('send-button').addEventListener('mousedown', e => e.preventDefault());
$('send-button').addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); if (!$('send-button').disabled) $('message-form').requestSubmit(); }, { passive: false });
$('image-input').addEventListener('change', (event) => { const file = event.target.files[0]; state.pendingImageFile = file || null; if (file) showToast(`Photo ready: ${file.name}. Limit: 3 uploads daily.`); });
$('cancel-reply-button').addEventListener('click', clearReply);
$('mobile-back-button').addEventListener('click', closeActiveChat);
$('conversation-options-button').addEventListener('click', () => {
  const isGroup = state.activeInboxItem?.isGroup;
  const isCreator = isGroup && state.activeInboxItem?.creatorId === state.user?.uid;
  $('set-nickname-button').classList.toggle('hidden', !!isGroup);
  $('rename-group-button').classList.toggle('hidden', !isCreator);
  $('add-member-button').classList.toggle('hidden', !isCreator);
  $('kick-member-button').classList.toggle('hidden', !isCreator);
  $('leave-group-button').classList.toggle('hidden', !isGroup);
  $('conversation-dialog').showModal();
});
$('close-conversation-dialog').addEventListener('click', () => $('conversation-dialog').close());
$('clear-chat-button').addEventListener('click', clearChatForMe);
$('remove-conversation-button').addEventListener('click', removeConversation);
$('rename-group-button')?.addEventListener('click', renameGroup);
$('add-member-button')?.addEventListener('click', addMember);
$('kick-member-button')?.addEventListener('click', kickMember);
$('leave-group-button')?.addEventListener('click', leaveGroup);
$('close-auth-button').addEventListener('click', () => $('auth-dialog').close());

$('toggle-group-mode')?.addEventListener('click', () => {
  state.groupMode = !state.groupMode;
  state.groupSelection = [];
  $('group-action-bar').classList.toggle('hidden', !state.groupMode);
  $('toggle-group-mode').textContent = state.groupMode ? 'Cancel' : 'Create Group';
  renderPeople();
});
$('start-group-btn')?.addEventListener('click', () => {
  if (state.groupSelection.length > 0) startGroupConversation(state.groupSelection);
});
$('set-nickname-button')?.addEventListener('click', async () => {
  if (!state.user || !state.activeThreadId || state.activeInboxItem?.isGroup) return;
  const peerIds = getThreadPeers(state.activeInboxItem);
  if (!peerIds.length) return;
  const targetUid = peerIds[0]; const targetUser = state.users[targetUid];
  if (!targetUser) return;
  const newNickname = await showAppModal({ title: 'Set Nickname', message: `Set a nickname for ${targetUser.name}. Leave blank to reset.`, input: true, inputValue: state.activeInboxItem.nicknames?.[targetUid] || '' });
  if (newNickname === null) return;
  try {
    await update(ref(db, `chatThreads/${state.activeThreadId}/nicknames`), { [targetUid]: newNickname.trim() || null });
    showToast('Nickname updated.');
  } catch (err) { showToast('Could not update nickname.'); }
});

async function renameGroup() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  if (state.activeInboxItem.creatorId !== state.user.uid) return showToast('Only the group creator can rename the group.');
  const current = state.activeInboxItem.name || getThreadName(state.activeInboxItem, getThreadPeers(state.activeInboxItem));
  $('conversation-dialog').close();
  const newName = await showAppModal({ title: 'Rename Group', message: 'Enter a new name for this group chat.', input: true, inputValue: current, placeholder: 'Group name', confirmText: 'Rename' });
  if (newName === null || !newName.trim()) return;
  try {
    await update(ref(db, `chatThreads/${state.activeThreadId}`), { name: newName.trim() });
    showToast('Group renamed.');
  } catch (err) { showToast(`Could not rename group: ${err.message}`); }
}

async function kickMember() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  if (state.activeInboxItem.creatorId !== state.user.uid) return showToast('Only the group creator can view/kick members here.');
  const allIds = Object.keys(state.activeInboxItem.members || {});
  if (allIds.length <= 1) return showToast('No other members to kick.');
  const memberList = allIds.map(id => ({ uid: id, name: state.users[id]?.name || 'Member', avatar: avatarUrl(state.users[id]), isCreator: id === state.activeInboxItem.creatorId }));
  $('conversation-dialog').close();
  const selected = await showAppModal({ title: 'Show / Kick Member', message: 'Select a member to remove from this group.', memberList, disabledUid: state.user.uid, multiSelect: false, confirmText: 'Kick', danger: true });
  if (!selected || !selected.length) return;
  const targetUid = selected[0]; const targetName = state.users[targetUid]?.name || 'this member';
  const confirmed = await showAppModal({ title: 'Confirm Kick', message: `Are you sure you want to kick ${targetName} from the group?`, confirmText: 'Kick', danger: true });
  if (!confirmed) return;
  try {
    await remove(ref(db, `chatThreads/${state.activeThreadId}/members/${targetUid}`));
  } catch (err) { return showToast(`Failed to remove member: ${err.message}`); }
  
  remove(ref(db, `chatInboxes/${targetUid}/${state.activeThreadId}`)).catch(e => console.warn('Ignored inbox remove error:', e));
  
  try {
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `kicked ${targetName}.`, timestamp: Date.now(), isSystem: true });
  } catch (err) { console.warn('Failed to send kick system message:', err); }
  
  showToast(`${targetName} was kicked.`);
}

async function addMember() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  if (state.activeInboxItem.creatorId !== state.user.uid) return showToast('Only the group creator can add members.');
  const currentMembers = Object.keys(state.activeInboxItem.members || {});
  const nonMembers = Object.values(state.users).filter(u => u.uid && !currentMembers.includes(u.uid) && !u.isBanned);
  if (!nonMembers.length) return showToast('No available members to add.');
  const memberList = nonMembers.map(u => ({ uid: u.uid, name: u.name || 'Member', avatar: avatarUrl(u) }));
  $('conversation-dialog').close();
  const selected = await showAppModal({ title: 'Add Members', message: 'Select members to add to this group.', memberList, multiSelect: true, confirmText: 'Add' });
  if (!selected || !selected.length) return;
  try {
    await Promise.all(selected.map(uid => set(ref(db, `chatThreads/${state.activeThreadId}/members/${uid}`), true)));
    const updatedMembers = { ...(state.activeInboxItem.members || {}) };
    selected.forEach(uid => updatedMembers[uid] = true);
    const summary = { isGroup: true, members: updatedMembers, lastMessage: state.activeInboxItem.lastMessage || 'Added to group', lastTimestamp: state.activeInboxItem.lastTimestamp || Date.now(), lastSenderId: state.activeInboxItem.lastSenderId || state.user.uid, unreadCount: 1, name: state.activeInboxItem.name || '', creatorId: state.activeInboxItem.creatorId || state.user.uid };
    for (const uid of selected) { await runTransaction(ref(db, `chatInboxes/${uid}/${state.activeThreadId}`), (current) => current || summary).catch(() => {}); }
    const addedNames = selected.map(uid => state.users[uid]?.name || 'a member').join(', ');
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `added ${addedNames}.`, timestamp: Date.now(), isSystem: true });
    showToast(`${selected.length} member${selected.length > 1 ? 's' : ''} added.`);
  } catch (err) { showToast(`Could not add members: ${err.message}`); }
}

async function leaveGroup() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  $('conversation-dialog').close();
  const confirmed = await showAppModal({ title: 'Leave Group', message: 'Are you sure you want to leave this group chat?', confirmText: 'Leave', danger: true });
  if (!confirmed) return;
  try {
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `left the group.`, timestamp: Date.now(), isSystem: true });
    await update(ref(db), { [`chatThreads/${state.activeThreadId}/members/${state.user.uid}`]: null });
    await remove(ref(db, `chatInboxes/${state.user.uid}/${state.activeThreadId}`));
    closeActiveChat();
    showToast('You have left the group.');
  } catch (err) { showToast(`Could not leave group: ${err.message}`); }
}
$('auth-toggle').addEventListener('click', () => { state.signUp = !state.signUp; $('auth-title').textContent = state.signUp ? 'Create account' : 'Sign in'; $('auth-submit').textContent = state.signUp ? 'Create account' : 'Sign in'; $('auth-toggle').textContent = state.signUp ? 'Already have an account? Sign in' : 'Need an account? Create one'; $('auth-password').autocomplete = state.signUp ? 'new-password' : 'current-password'; });
$('auth-form').addEventListener('submit', async (event) => { event.preventDefault(); const email = $('auth-email').value.trim(); const password = $('auth-password').value; const error = $('auth-error'); error.classList.add('hidden'); try { const result = state.signUp ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password); if (state.signUp) { const name = `User_${Math.floor(Math.random() * 999)}`; const pic = fallbackAvatar(result.user.uid); await updateProfile(result.user, { displayName: name, photoURL: pic }); await update(ref(db, `users/${result.user.uid}`), { uid: result.user.uid, name, pic }); } $('auth-dialog').close(); } catch (err) { error.textContent = err.message.replace('Firebase: ', ''); error.classList.remove('hidden'); } });
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#message-action-menu') && !event.target.closest('.message-bubble')) closeMessageMenu(); });
window.addEventListener('pagehide', () => setTyping(false));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => { document.body.style.height = `${window.visualViewport.height}px`; });
  document.body.style.height = `${window.visualViewport.height}px`;
}
