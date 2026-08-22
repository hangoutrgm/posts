import { auth, db, cloudinaryConfig } from '../../js/firebase-config.js';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, updateProfile, signInAnonymously, GoogleAuthProvider, signInWithPopup } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { endBefore, get, limitToLast, onDisconnect, onValue, orderByKey, push, query, ref, remove, runTransaction, set, update, onChildAdded, onChildChanged, onChildRemoved } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-database.js';

// Dynamic settings — loaded from Firebase /settings, falls back to safe defaults
const chatSettings = { chatImageLimit: 10, chatVideoLimit: 3, chatVoiceLimit: 10, chatVideoSizeLimitMB: 20, chatCooldownSec: 60 };
let sitePaused = false; // Site Control (/config): when true, only admins can send messages
onValue(ref(db, 'settings'), (snap) => {
  if (snap.exists()) {
    const s = snap.val();
    chatSettings.chatImageLimit = s.chatImageLimit ?? 10;
    chatSettings.chatVideoLimit = s.chatVideoLimit ?? 3;
    chatSettings.chatVoiceLimit = s.chatVoiceLimit ?? 10;
    chatSettings.chatVideoSizeLimitMB = s.chatVideoSizeLimitMB ?? 20;
    chatSettings.chatCooldownSec = s.chatCooldownSec ?? 60;
    sitePaused = s.pauseChat === true;
  } else {
    sitePaused = false;
  }
});

// Site Control bypass: hardcoded admin UID or isAdmin flag on the user record
function isSiteAdmin() {
  if (!state.user) return false;
  return state.user.uid === 'IrcAY3gUELNjiRUhMkr7muxNIpm2' || state.users[state.user.uid]?.isAdmin === true;
}

const $ = (id) => document.getElementById(id);
const state = {
  user: null, users: {}, inbox: {}, online: {}, clears: {}, typing: {}, messages: {}, activeThreadId: null, activeInboxItem: null,
  activePeerId: null, stopMessages: null, stopInbox: null, stopTyping: null, stopClears: null, stopSeen: null, stopThreadSummaries: {}, signUp: false,
  replyTo: null, pendingImageFile: null, inboxReady: false, messagesLoaded: false, typingTimer: null, typingExpiryTimer: null, peerSeenAt: 0, groupSeenAt: {}, connected: false,
  groupMode: false, groupSelection: [],
  noMoreOldMessages: false, loadingOldMessages: false, streakData: null, stopPostsNotif: null,
  streaks: {}, stopStreak: null, pinnedMessage: null, stopPinnedMessage: null, mediaRecorder: null, audioChunks: [], recTimerInterval: null, recSeconds: 0
};
// Restore users cache immediately so DM names are available before RTDB responds
try { const cu = localStorage.getItem('hangout-users'); if (cu) state.users = JSON.parse(cu); } catch (e) {}
const reactions = { like: '👍', love: '❤️', laugh: '😂', wow: '😮', sad: '😢' };
reactions.angry = '😡';
// Extended emoji picker (invoked via the "+" button in the message menu)
const reactionsMore = ['\u{1F525}','\u{1F389}','\u{1F973}','\u{1F923}','\u{1F605}','\u{1F601}','\u{1F64C}','\u{1F4AF}','\u{1F91D}','\u{1F62D}','\u{1F970}','\u{1F60E}','\u{1F914}','\u{1F634}','\u{1F64F}','\u{1F4AA}','\u{1FA77}','\u{1F44F}','\u{1F433}','\u{1F340}','\u{2B50}','\u{1F440}','\u{1F92F}','\u{1F62C}','\u{1F607}','\u{1F917}'];

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
function openUserProfile(uid) {
  if (!uid) return;
  window.location.href = `../?profile=${encodeURIComponent(uid)}`;
}

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
  if (!item.isGroup && item.peerId === state.user?.uid) return 'Notes (Me)';
  if (!peerIds.length) return 'Empty Group';
  return peerIds.map(uid => (item.nicknames && item.nicknames[uid]) || state.users[uid]?.name || 'Member').join(', ');
}
function renderAvatarHtml(peerIds, item = null) {
  if (item && item.isGroup && item.pic) return `<img class="avatar" src="${escapeHtml(item.pic)}" alt="">`;
  if (item && !item.isGroup && item.peerId === state.user?.uid) return `<div class="avatar" style="background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-size:16px;">📝</div>`;
  if (!peerIds || peerIds.length === 0) return `<img class="avatar" src="${escapeHtml(fallbackAvatar('group'))}" alt="">`;
  if (peerIds.length === 1) return `<img class="avatar" src="${escapeHtml(avatarUrl(state.users[peerIds[0]]))}" alt="">`;
  const count = Math.min(peerIds.length, 4);
  const imgs = peerIds.slice(0, 4).map(uid => `<img src="${escapeHtml(avatarUrl(state.users[uid]))}" alt="">`).join('');
  return `<div class="avatar-collage count-${count}">${imgs}</div>`;
}
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  localStorage.setItem('hangout-chat-theme', dark ? 'dark' : 'light');
  const toggle = $('theme-toggle');
  if (toggle) {
    toggle.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    toggle.setAttribute('aria-label', toggle.title);
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0f1a' : '#6c63ff');
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
    let selected = options.selectedList ? [...options.selectedList] : [];
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
  document.title = unread ? `(${unread > 99 ? '99+' : unread}) Hangout Chat` : 'Hangout Chat';
}

function renderConversations() {
  const list = $('conversation-list');
  const term = $('conversation-search').value.trim().toLowerCase();
  const items = Object.entries(state.inbox).map(([id, item]) => ({ id, ...item })).filter((item) => {
    const peerIds = getThreadPeers(item);
    const name = getThreadName(item, peerIds).toLowerCase();
    return !term || `${name} ${item.lastMessage || ''}`.toLowerCase().includes(term);
  }).sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
  });
  if (!state.user) { list.innerHTML = ''; return; }
  if (!Object.keys(state.inbox).length && !state.inboxReady) {
    list.innerHTML = `<div class="conv-skeleton-list">${Array.from({length:6}, () =>
      `<div class="conv-skeleton-row"><div class="conv-skeleton-avatar skeleton"></div><div class="conv-skeleton-body"><div class="conv-skeleton-name skeleton"></div><div class="conv-skeleton-preview skeleton"></div></div></div>`
    ).join('')}</div>`;
    return;
  }
  if (!items.length) { list.innerHTML = '<p class="list-empty">No conversations yet. Tap the compose button to say hello.</p>'; return; }
  list.innerHTML = items.map((item) => {
    const peerIds = getThreadPeers(item);
    const name = getThreadName(item, peerIds);
    const unread = Number(item.unreadCount || 0);
    const preview = item.lastSenderId === state.user.uid ? `You: ${item.lastMessage || ''}` : (item.lastMessage || 'Start chatting');
    const presenceHtml = !item.isGroup && peerIds.length === 1 ? `<i class="conversation-presence${isOnline(peerIds[0]) ? ' online' : ''}" aria-label="${isOnline(peerIds[0]) ? 'Online' : 'Offline'}"></i>` : '';
    const streak = state.streaks[item.id];
    const streakHtml = streak && streak.count >= 1 ? `<span class="conv-streak-badge">🔥${streak.count}</span>` : '';
    return `<button class="conversation${item.id === state.activeThreadId ? ' selected' : ''}${unread ? ' unread' : ''}" data-thread="${escapeHtml(item.id)}"><span class="conversation-avatar">${renderAvatarHtml(peerIds, item)}${presenceHtml}</span><span class="conversation-copy"><span class="conversation-top"><span class="conversation-name">${item.pinned ? '📌 ' : ''}${escapeHtml(name)}</span>${streakHtml}<span class="conversation-time">${formatTime(item.lastTimestamp)}</span></span><span class="conversation-preview"><span>${escapeHtml(preview)}</span>${unread ? `<b class="unread-badge">${unread > 99 ? '99+' : unread}</b>` : ''}</span></span></button>`;
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
  
  let html = '';
  if (!state.groupMode && (!term || 'notes (me)'.includes(term))) {
    html += `<button class="person" data-user="${escapeHtml(state.user.uid)}"><div class="avatar" style="background:var(--primary); color:white; display:flex; align-items:center; justify-content:center; font-size:16px;">📝</div><span class="person-copy"><span class="person-name">Notes (Me)</span><span class="person-status">Saved Messages</span></span></button>`;
  }
  
  if (!people.length && !html) { list.innerHTML = '<p class="list-empty">No matching members found.</p>'; return; }
  
  html += people.map((person) => {
    const isSelected = state.groupSelection?.includes(person.uid);
    return `<button class="person${isSelected ? ' selected' : ''}" data-user="${escapeHtml(person.uid)}"><img class="avatar" src="${escapeHtml(avatarUrl(person))}" alt=""><span class="person-copy"><span class="person-name">${escapeHtml(person.name || 'Hangout member')}</span><span class="person-status"><i class="online-dot${isOnline(person.uid) ? ' online' : ''}"></i>${person.isBanned ? 'Unavailable' : isOnline(person.uid) ? 'Online' : 'Offline'}</span></span>${state.groupMode ? `<input type="checkbox" style="pointer-events:none; margin-left:auto;" ${isSelected ? 'checked' : ''}>` : ''}</button>`;
  }).join('');
  
  list.innerHTML = html;
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
  
  const avatarHtml = renderAvatarHtml(peerIds, item);
  const wrap = $('chat-avatar-wrap');
  if (wrap) {
    wrap.innerHTML = avatarHtml;
    wrap.title = item.isGroup ? 'Group options' : (peerIds[0] ? `View ${getNickname(peerIds[0])}'s profile` : 'View profile');
    const el = wrap.firstElementChild;
    if (el) { el.classList.add('large'); if (el.tagName === 'IMG') el.classList.add('avatar'); }
  }
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

function replyPreview(replyTo = {}) { 
  if (replyTo.text) return replyTo.text;
  if (replyTo.audio) return 'Voice message';
  if (replyTo.image) {
    if (replyTo.image.includes('/video/upload/') || replyTo.image.match(/\\.(mp4|webm|mov|ogg)$/i)) return 'Video';
    return 'Photo';
  }
  return replyTo.hasImage ? 'Photo' : 'Message'; 
}
function visibleMessages(rawMessages = state.messages) {
  const clearTime = Number(state.clears[state.activeThreadId] || 0);
  return Object.entries(rawMessages || {}).map(([id, message]) => ({ id, ...message })).filter((message) => Number(message.timestamp || 0) > clearTime).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function renderMessages(rawMessages, jumpToLatest = false) {
  if (rawMessages !== undefined) state.messages = rawMessages || {};
  const list = $('message-list');
  const wasNearLatest = list ? (list.scrollHeight - list.scrollTop - list.clientHeight < 250) : false;
  const rows = visibleMessages();
  if (!rows.length) { list.innerHTML = '<p class="list-empty messages-empty">No messages yet. Say hello!</p>'; return; }
  
  const lastMsg = rows[rows.length - 1];
  const isNewArrival = window._lastRenderedMsgId && window._lastRenderedMsgId !== lastMsg.id;
  window._lastRenderedMsgId = lastMsg.id;
  
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
    if (message.isSystem) return `<div id="message-${escapeHtml(message.id)}" class="system-message-row"><span class="system-message-bubble">${escapeHtml(getNickname(message.senderId))} ${escapeHtml(message.text)}</span></div>`;
    const mine = message.senderId === state.user?.uid;
    const reactionSummary = Object.entries(message.reactions || {}).map(([type, people]) => Object.keys(people || {}).length ? `<span class="reaction-chip">${reactions[type] || type || '👍'} ${Object.keys(people).length}</span>` : '').join('');
    let quote = '';
    if (message.replyTo) {
      let mediaPreview = '';
      if (message.replyTo.image) {
        if (message.replyTo.image.includes('/video/upload/') || message.replyTo.image.match(/\\.(mp4|webm|mov|ogg)$/i)) {
          mediaPreview = `<video src="${escapeHtml(message.replyTo.image)}" style="width:24px;height:24px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;display:inline-block;"></video>`;
        } else {
          mediaPreview = `<img src="${escapeHtml(message.replyTo.image)}" style="width:24px;height:24px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;display:inline-block;">`;
        }
      } else if (message.replyTo.audio) {
        mediaPreview = `🎤 `;
      } else if (message.replyTo.hasImage) {
        mediaPreview = `📷 `;
      }
      quote = `<div class="reply-quote" onclick="const e = document.getElementById('message-${message.replyTo.id}'); if(e) e.scrollIntoView({behavior:'smooth', block:'center'});">Reply to ${escapeHtml(getNickname(message.replyTo.senderId))}: <br/> ${mediaPreview}${escapeHtml(replyPreview(message.replyTo))}</div>`;
    }
    const isVoice = Boolean(message.audio || (message.image && (message.image.match(/\.(mp3|wav|ogg|m4a|aac|opus)$/i) || message.image.includes('/video/upload/') && message.audio)));
    let isVid = false;
    let image = '';
    let audioHtml = '';
    if (isVoice) {
      const audioSrc = message.audio || message.image;
      audioHtml = `<audio class="message-audio" controls src="${escapeHtml(audioSrc)}"></audio>`;
    } else if (message.image) {
      isVid = message.image.includes('/video/upload/') || message.image.match(/\\.(mp4|webm|mov|ogg)$/i);
      image = isVid ? `<video class="message-image" src="${escapeHtml(message.image)}" style="max-height:200px; max-width: 100%; border-radius: 8px; margin-top: 4px;"></video>` : `<img class="message-image" src="${escapeHtml(message.image)}" alt="Shared photo">`;
    }
    let messageText = linkifyText(message.text || '');
    if (!messageText && image) {
      messageText = `<div style="font-style:italic; opacity:0.7; font-size:14px; margin-bottom:4px;">Shared a ${isVid ? 'video' : 'photo'}</div>`;
    } else if (!messageText && isVoice) {
      messageText = `<div style="font-style:italic; opacity:0.7; font-size:14px; margin-bottom:4px;">Voice message</div>`;
    }
    
    if (message.isDeleted) {
      quote = '';
      image = '';
      audioHtml = '';
      messageText = '<span style="font-style:italic; opacity:0.6;">🚫 Message deleted</span>';
    }
    
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
    
    const senderNameHtml = (state.activeInboxItem?.isGroup && !mine) ? `<div class="message-sender-name" style="font-size:10.5px; color:var(--ink-muted); margin-bottom:2px; margin-left:6px; font-weight:600;">${escapeHtml(getNickname(message.senderId))}</div>` : '';
    return `<div id="message-${escapeHtml(message.id)}" class="message-row${mine ? ' me' : ''}"><div>${senderNameHtml}<div class="message-bubble" data-message="${escapeHtml(message.id)}"><span class="swipe-reply-hint"><svg viewBox="0 0 24 24"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></span>${quote}${messageText}${image}${audioHtml}</div>${reactionSummary ? `<div class="reaction-summary">${reactionSummary}</div>` : ''}<div class="message-meta"><div class="message-time hidden">${formatTime(message.timestamp)}</div>${message.editedAt ? '<span class="edited-label">Edited</span>' : ''}${seen}</div></div></div>`;
  }).join('');
  // Prepend load-more header
  let header = list.querySelector('.load-more-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'load-more-header';
    list.insertBefore(header, list.firstChild);
  }
  if (state.noMoreOldMessages) {
    header.innerHTML = '<span class="load-more-end">Beginning of conversation</span>';
  } else if (state.loadingOldMessages) {
    header.innerHTML = '<span class="load-more-spinner">Loading older messages…</span>';
  } else {
    header.innerHTML = '';
  }

  wireMessageGestures(rows);
  if (jumpToLatest || wasNearLatest || window._jumpToLatest || isNewArrival) {
    requestAnimationFrame(() => { 
      list.scrollTop = list.scrollHeight; 
      setTimeout(() => list.scrollTop = list.scrollHeight, 100);
    });
    window._jumpToLatest = false;
  }
}

// ── Message Action Menu (long-press / right-click) ──
let menuGuardUntil = 0;             // ignore the release tap that closes a long-press
let menuMoreOpen = false;           // extended emoji picker open state

function closeMessageMenu() {
  $('message-action-menu').classList.add('hidden');
  $('message-action-menu').innerHTML = '';
  menuMoreOpen = false;
}

// Small inline SVG icon set that follows the currentColor theme
const menuSvg = {};
menuSvg.reply = '<svg viewBox="0 0 24 24"><path d="M9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>';
menuSvg.profile = '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
menuSvg.pin = '<svg viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6a3 3 0 0 0-6 0v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24V17z"/><line x1="9" y1="2" x2="15" y2="2"/></svg>';
menuSvg.unpin = '<svg viewBox="0 0 24 24"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="9" y1="2" x2="15" y2="2"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6"/><path d="M9 10.76a2 2 0 0 1-1.11-1.79L6.11 8.08A2 2 0 0 0 5 6.29V6"/></svg>';
menuSvg.copy = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
menuSvg.edit = '<svg viewBox="0 0 24 24"><path d="M4 20h4L20 8a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M15 6l4 4"/></svg>';
menuSvg.delete = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

function showMessageMenu(message, x, y, fromLongPress = false) {
  if (!message) return;
  const menu = $('message-action-menu');

  // Quick-set reaction buttons
  const quickButtons = Object.entries(reactions).map(([type, emoji]) =>
    `<button class="reaction-option" type="button" data-menu-action="react" data-reaction="${type}" aria-label="React ${type}">${emoji}</button>`).join('');

  const senderName = state.users[message.senderId]?.name || getNickname(message.senderId) || 'User';
  const isGroup = state.activeInboxItem?.isGroup || state.activeThreadId?.startsWith('group_');
  const canPin = !isGroup || state.activeInboxItem?.creatorId === state.user?.uid || state.user?.isAdmin;
  const isPinned = state.pinnedMessage?.id === message.id;
  const isMine = message.senderId === state.user?.uid;

  const icon = (svg, action, title, extra = '') =>
    `<button class="menu-icon-btn" type="button" data-menu-action="${action}" title="${title}" aria-label="${title}" ${extra}>${svg}</button>`;

  const profileBtn = icon(menuSvg.profile, 'profile', `View ${escapeHtml(senderName)}'s profile`);
  const replyBtn = icon(menuSvg.reply, 'reply', 'Reply');
  const pinBtn = canPin && !message.isDeleted ? icon(isPinned ? menuSvg.unpin : menuSvg.pin, isPinned ? 'unpin' : 'pin', isPinned ? 'Unpin' : 'Pin') : '';
  const copyBtn = icon(menuSvg.copy, 'copy', 'Copy text');
  const ownerBtns = isMine
    ? icon(menuSvg.edit, 'edit', 'Edit') + icon(menuSvg.delete, 'delete', 'Delete', 'style="--btn-danger:true"')
    : '';
  const moreBtn = `<button class="reaction-option menu-more-btn" type="button" data-menu-action="more" title="More emojis" aria-label="More emojis">+</button>`;

  const pickerHtml = menuMoreOpen
    ? `<div class="menu-emoji-picker">${reactionsMore.filter(e => !Object.values(reactions).includes(e)).map(e =>
        `<button class="reaction-option" type="button" data-menu-action="react" data-reaction="${e}" aria-label="React ${e}">${e}</button>`).join('')}</div>`
    : '';

  menu.innerHTML = `<div class="menu-actions-row">${quickButtons}${moreBtn}</div><div class="menu-separator menu-sep-full"></div><div class="menu-actions-row">${profileBtn}${replyBtn}${pinBtn}${copyBtn}${ownerBtns}</div>${pickerHtml}`;

  menu.classList.remove('hidden');
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;

  // For long-press (mobile), place menu ABOVE the finger to avoid covering the thumb;
  // fall back below/above as needed based on available space.
  const pad = 14;
  let left = Math.max(pad, Math.min(x, window.innerWidth - menuW - pad));
  let top;
  if (fromLongPress) {
    // Try above the finger first
    top = y - menuH - 24;
    if (top < pad) top = Math.min(y + 24, window.innerHeight - menuH - pad);
  } else {
    top = Math.max(pad, Math.min(y, window.innerHeight - menuH - pad));
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(pad, top)}px`;

  menu.querySelectorAll('[data-menu-action]').forEach((button) => button.addEventListener('click', async () => {
    // Guard: ignore the release tap that immediately follows a long-press open
    if (Date.now() < menuGuardUntil) return;
    const action = button.dataset.menuAction;
    if (action === 'react') { await toggleReaction(message.id, button.dataset.reaction); return closeMessageMenu(); }
    if (action === 'more') { menuMoreOpen = !menuMoreOpen; return showMessageMenu(message, x, y, fromLongPress); }
    if (action === 'profile') { closeMessageMenu(); return openUserProfile(message.senderId); }
    if (action === 'reply') { closeMessageMenu(); return setReply(message); }
    if (action === 'pin') { closeMessageMenu(); return await pinMessage(message); }
    if (action === 'unpin') { closeMessageMenu(); return await unpinMessage(); }
    if (action === 'edit') { closeMessageMenu(); return await editMessage(message); }
    if (action === 'delete') { closeMessageMenu(); return await deleteMessage(message); }
    if (action === 'copy') {
      closeMessageMenu();
      try { await navigator.clipboard.writeText(message.text || ''); showToast('Message copied.'); }
      catch (e) { showToast('Could not copy text.'); }
      return;
    }
    closeMessageMenu();
  }));
}

function showHeartAnimation(x, y) {
  const heart = document.createElement('div');
  heart.className = 'heart-tap-anim';
  heart.textContent = '❤️';
  heart.style.left = `${x}px`;
  heart.style.top = `${y}px`;
  document.body.appendChild(heart);
  setTimeout(() => heart.remove(), 700);
}

function openImageViewer(src) {
  const viewer = $('image-viewer');
  const img = $('image-viewer-img');
  const vid = $('image-viewer-video');
  const saveBtn = $('image-viewer-save');
  const isVideo = src.includes('/video/upload/') || /\.(mp4|webm|mov|ogg)$/i.test(src);
  if (isVideo) {
    img.style.display = 'none';
    img.src = '';
    vid.style.display = '';
    vid.src = src;
    vid.play().catch(()=>{}); // Autoplay on open
  } else {
    vid.style.display = 'none';
    vid.src = '';
    vid.pause();
    img.style.display = '';
    img.src = src;
  }
  // Generate unique filename based on current date/time
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const uniqueName = `chat_${dateStr}_${timeStr}`;

  // Reset save button while blob is fetched
  saveBtn.href = '#';
  saveBtn.download = uniqueName;
  // Remove old save listener to avoid stacking
  if (saveBtn._saveHandler) saveBtn.removeEventListener('click', saveBtn._saveHandler);
  saveBtn._saveHandler = () => showToast('✓ Saved!');
  saveBtn.addEventListener('click', saveBtn._saveHandler);

  fetch(src)
    .then(res => res.blob())
    .then(blob => {
      const blobUrl = URL.createObjectURL(blob);
      saveBtn.href = blobUrl;
    })
    .catch(() => {
      // Fallback: direct link (may open new tab for cross-origin)
      saveBtn.href = src;
    });
  viewer.classList.remove('hidden');
}
function closeImageViewer() {
  const saveBtn = $('image-viewer-save');
  if (saveBtn.href && saveBtn.href.startsWith('blob:')) URL.revokeObjectURL(saveBtn.href);
  saveBtn.href = '#';
  $('image-viewer').classList.add('hidden');
  const vid = $('image-viewer-video');
  vid.pause();
  vid.src = '';
  $('image-viewer-img').src = '';
}

function wireMessageGestures(rows) {
  $('message-list').querySelectorAll('.message-bubble').forEach((bubble) => {
    const message = rows.find((row) => row.id === bubble.dataset.message);
    if (!message) return;
    let pressTimer = null;
    let singleTapTimer = null;
    let longPressed = false;
    let isPointerDown = false;
    let lastTapTime = 0;
    let startX = 0;
    let startY = 0;
    let currentX = 0;
    let currentY = 0;
    let isSwiping = false;
    let isPointerCaptured = false;
    let swipeHint = bubble.querySelector('.swipe-reply-hint');

    const cancelLongPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const toggleTimestamp = () => {
      const time = bubble.parentElement?.querySelector('.message-time');
      if (time) time.classList.toggle('hidden');
    };

    bubble.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.message-link') || event.target.classList.contains('message-image') || event.target.tagName === 'AUDIO') return;
      isPointerDown = true;
      startX = event.clientX;
      startY = event.clientY;
      currentX = event.clientX;
      currentY = event.clientY;
      isSwiping = false;
      longPressed = false;

      cancelLongPress();
      try {
        bubble.setPointerCapture(event.pointerId);
        isPointerCaptured = true;
      } catch (_) {}

      pressTimer = setTimeout(() => {
        if (!isSwiping && isPointerDown) {
          longPressed = true;
          if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
          lastTapTime = 0;
          // Guard window so the release tap (that closes the long-press) can't hit a menu button
          menuGuardUntil = Date.now() + 300;
          showMessageMenu(message, event.clientX, event.clientY, true);
        }
      }, 500);
    });

    bubble.addEventListener('pointermove', (event) => {
      if (!isPointerDown || longPressed) return;
      currentX = event.clientX;
      currentY = event.clientY;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;

      // Detect horizontal drag to the right
      if (dx > 8 && Math.abs(dx) > Math.abs(dy) * 0.7) {
        isSwiping = true;
        cancelLongPress();
        if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
        const visualOffset = Math.min(dx * 0.65, 55);
        bubble.style.transition = 'none';
        bubble.style.transform = `translateX(${visualOffset}px)`;
        if (swipeHint) {
          swipeHint.classList.toggle('visible', visualOffset >= 22);
        }
      }
    });

    bubble.addEventListener('pointerup', (event) => {
      if (!isPointerDown) return;
      isPointerDown = false;
      cancelLongPress();
      if (isPointerCaptured) {
        try { bubble.releasePointerCapture(event.pointerId); } catch (_) {}
        isPointerCaptured = false;
      }

      bubble.style.transition = 'transform 0.18s ease-out';

      if (isSwiping) {
        const dx = (event.clientX || currentX) - startX;
        if (dx >= 30) {
          setReply(message);
        }
        bubble.style.transform = '';
        if (swipeHint) swipeHint.classList.remove('visible');
        setTimeout(() => { bubble.style.transition = ''; }, 200);
        isSwiping = false;
        return;
      }

      bubble.style.transform = '';
      if (swipeHint) swipeHint.classList.remove('visible');
      setTimeout(() => { bubble.style.transition = ''; }, 200);

      if (longPressed) {
        longPressed = false;
        return;
      }

      // Check distance moved (must be a clean tap)
      const dist = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (dist > 15) return;

      const now = Date.now();
      if (lastTapTime > 0 && (now - lastTapTime) < 320) {
        // Double-tap confirmed -> Cancel single tap timestamp & React ❤️
        if (singleTapTimer) {
          clearTimeout(singleTapTimer);
          singleTapTimer = null;
        }
        lastTapTime = 0;
        toggleReaction(message.id, 'love');
        showHeartAnimation(event.clientX, event.clientY);
      } else {
        // First tap -> start timer for single tap (toggle timestamp)
        lastTapTime = now;
        if (singleTapTimer) clearTimeout(singleTapTimer);
        singleTapTimer = setTimeout(() => {
          toggleTimestamp();
          singleTapTimer = null;
          lastTapTime = 0;
        }, 320);
      }
    });

    bubble.addEventListener('pointercancel', (event) => {
      isPointerDown = false;
      cancelLongPress();
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
      if (isPointerCaptured) {
        try { bubble.releasePointerCapture(event.pointerId); } catch (_) {}
        isPointerCaptured = false;
      }
      bubble.style.transform = '';
      if (swipeHint) swipeHint.classList.remove('visible');
      isSwiping = false;
    });

    bubble.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      cancelLongPress();
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null; }
      showMessageMenu(message, event.clientX, event.clientY, false);
    });
  });

  // Wire image tap-to-view
  $('message-list').querySelectorAll('img.message-image').forEach((img) => {
    img.addEventListener('click', (e) => { e.stopPropagation(); openImageViewer(img.src); });
  });
  // Wire video tap-to-fullview
  $('message-list').querySelectorAll('video.message-image').forEach((vid) => {
    vid.addEventListener('click', (e) => { 
      e.stopPropagation(); 
      openImageViewer(vid.src);
    });
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
        renderMessages(undefined, false);
      }, (error) => reportRealtimeError('seen receipts', error))
    );
    return;
  }
  state.stopSeen = onValue(ref(db, `chatReads/${state.activePeerId}/${threadId}`), (snapshot) => { state.peerSeenAt = Number(snapshot.val() || 0); renderMessages(undefined, false); }, (error) => reportRealtimeError('seen receipts', error));
}

function watchTyping(threadId) {
  if (state.stopTyping) state.stopTyping(); state.typing = {};
  state.stopTyping = onValue(ref(db, `chatTyping/${threadId}`), (snapshot) => { state.typing = snapshot.val() || {}; updateChatHeader(); });
}
async function loadOlderMessages() {
  if (!state.activeThreadId || state.loadingOldMessages || state.noMoreOldMessages) return;
  const rows = visibleMessages();
  if (!rows.length) return;
  const oldestKey = rows[0].id; // Firebase push keys are time-ordered, no index needed
  state.loadingOldMessages = true;
  renderMessages(undefined, false);
  try {
    const snap = await get(query(ref(db, `chatMessages/${state.activeThreadId}`), orderByKey(), endBefore(oldestKey), limitToLast(25)));
    if (!snap.exists()) {
      state.noMoreOldMessages = true;
    } else {
      const older = snap.val();
      state.messages = { ...older, ...state.messages };
      if (Object.keys(older).length < 25) state.noMoreOldMessages = true;
    }
  } catch (e) {
    console.error('loadOlderMessages error', e);
    state.noMoreOldMessages = true; // prevent infinite retry on error
  }
  state.loadingOldMessages = false;
  const list = $('message-list');
  const prevHeight = list.scrollHeight;
  renderMessages(undefined, false);
  // Preserve scroll position after prepend
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight - prevHeight + list.scrollTop; });
}

function watchPinnedMessage(threadId) {
  if (state.stopPinnedMessage) {
    state.stopPinnedMessage();
    state.stopPinnedMessage = null;
  }
  state.pinnedMessage = null;
  state.stopPinnedMessage = onValue(ref(db, `chatThreads/${threadId}/pinnedMessage`), (snapshot) => {
    state.pinnedMessage = snapshot.val() || null;
    renderPinnedBar();
  });
}

function renderPinnedBar() {
  const bar = $('pinned-message-bar');
  if (!bar) return;
  if (!state.pinnedMessage) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const isGroup = state.activeInboxItem?.isGroup;
  const canUnpin = !isGroup || state.activeInboxItem?.creatorId === state.user?.uid;
  const senderName = getNickname(state.pinnedMessage.senderId);
  const unpinHtml = canUnpin ? `<button id="pinned-bar-unpin-btn" class="pinned-bar-unpin" title="Unpin message" aria-label="Unpin message"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>` : '';

  bar.innerHTML = `
    <div class="pinned-bar-icon"><svg viewBox="0 0 24 24"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6a3 3 0 0 0-6 0v4.76a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24V17z"/><line x1="9" y1="2" x2="15" y2="2"/></svg></div>
    <div class="pinned-bar-content">
      <span class="pinned-bar-title">Pinned Message</span>
      <span class="pinned-bar-text"><strong>${escapeHtml(senderName)}:</strong> ${escapeHtml(state.pinnedMessage.text || 'Message')}</span>
    </div>
    ${unpinHtml}
  `;
  bar.classList.remove('hidden');

  bar.onclick = (e) => {
    if (e.target.closest('#pinned-bar-unpin-btn')) {
      e.stopPropagation();
      unpinMessage();
      return;
    }
    const targetEl = $(`message-${state.pinnedMessage.id}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.querySelector('.message-bubble')?.animate([
        { boxShadow: '0 0 0 4px var(--accent)' },
        { boxShadow: 'var(--shadow-sm)' }
      ], { duration: 1200 });
    } else {
      showToast('Scroll up to load older messages to view this pinned message.');
    }
  };
}

async function pinMessage(message) {
  if (!state.user || !state.activeThreadId) return;
  const isGroup = state.activeInboxItem?.isGroup;
  if (isGroup && state.activeInboxItem?.creatorId !== state.user.uid) {
    return showToast('Only the group creator can pin messages.');
  }
  let previewText = message.text;
  if (!previewText) {
    if (message.audio) previewText = '🎤 Voice message';
    else if (message.image) previewText = '📷 Photo/Video';
    else previewText = 'Message';
  }
  const pinnedData = {
    id: message.id,
    senderId: message.senderId,
    text: previewText.slice(0, 150),
    timestamp: message.timestamp || Date.now()
  };
  try {
    await set(ref(db, `chatThreads/${state.activeThreadId}/pinnedMessage`), pinnedData);
    showToast('Message pinned.');
  } catch (err) {
    showToast(`Could not pin message: ${err.message}`);
  }
}

async function unpinMessage() {
  if (!state.user || !state.activeThreadId) return;
  const isGroup = state.activeInboxItem?.isGroup;
  if (isGroup && state.activeInboxItem?.creatorId !== state.user.uid) {
    return showToast('Only the group creator can unpin messages.');
  }
  try {
    await set(ref(db, `chatThreads/${state.activeThreadId}/pinnedMessage`), null);
    showToast('Message unpinned.');
  } catch (err) {
    showToast(`Could not unpin message: ${err.message}`);
  }
}

function resetVoiceRecorderUi() {
  if (state.recTimerInterval) {
    clearInterval(state.recTimerInterval);
    state.recTimerInterval = null;
  }
  state.recSeconds = 0;
  state.recStartTime = 0;
  $('voice-recorder-bar')?.classList.add('hidden');
  $('composer-input-row')?.classList.remove('hidden');
  const timerEl = $('voice-rec-timer');
  if (timerEl) timerEl.textContent = '00:00';
}

async function startVoiceRecording() {
  if (!state.user || !state.activeThreadId) return;
  if (state.users[state.user.uid]?.isBanned) return showToast('You are banned from using Hangout Chat.');
  if (state.activeThreadId === 'global_announcements' && !state.users[state.user.uid]?.isAdmin && !state.users[state.user.uid]?.isCreator) {
    return showToast('Only admins can send messages in Global Announcements.');
  }

  // Pre-check daily voice limit
  const limit = chatSettings.chatVoiceLimit;
  const day = new Date().toISOString().slice(0, 10);
  const currentQuotaSnap = await get(ref(db, `chatVoiceUploadQuota/${state.user.uid}/${day}`)).catch(() => null);
  const currentCount = Number(currentQuotaSnap?.val() || 0);
  if (currentCount >= limit) {
    return showToast(`Daily voice message limit reached (${limit} recordings). Try again tomorrow.`);
  }

  // Check if live MediaRecorder + getUserMedia is supported in this context (requires secure context https or localhost)
  const hasGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia || navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
  const hasMediaRecorder = typeof window.MediaRecorder !== 'undefined';

  if (!hasGetUserMedia || !hasMediaRecorder) {
    // Universal fallback for non-secure contexts (e.g. http:// IP access) or unsupported webviews:
    // Open native audio recorder / file picker directly
    showToast('Opening audio recorder…');
    $('voice-file-input')?.click();
    return;
  }

  try {
    let stream;
    if (navigator.mediaDevices?.getUserMedia) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } else {
      const legacyGetUserMedia = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia).bind(navigator);
      stream = await new Promise((resolve, reject) => legacyGetUserMedia({ audio: true }, resolve, reject));
    }

    state.audioChunks = [];
    let options = {};
    if (MediaRecorder.isTypeSupported?.('audio/webm;codecs=opus')) options = { mimeType: 'audio/webm;codecs=opus' };
    else if (MediaRecorder.isTypeSupported?.('audio/webm')) options = { mimeType: 'audio/webm' };
    else if (MediaRecorder.isTypeSupported?.('audio/mp4')) options = { mimeType: 'audio/mp4' };
    else if (MediaRecorder.isTypeSupported?.('audio/ogg;codecs=opus')) options = { mimeType: 'audio/ogg;codecs=opus' };

    state.mediaRecorder = new MediaRecorder(stream, options);
    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = async () => {
      const durationMs = Date.now() - (state.recStartTime || 0);
      stream.getTracks().forEach(track => track.stop());
      resetVoiceRecorderUi();

      if (state.audioChunks.length === 0 || durationMs < 600) {
        state.audioChunks = [];
        showToast('Voice message was too short.');
        return;
      }

      const mimeType = state.mediaRecorder?.mimeType || 'audio/webm';
      const audioBlob = new Blob(state.audioChunks, { type: mimeType });
      state.audioChunks = [];
      await sendVoiceMessage(audioBlob);
    };

    state.mediaRecorder.start(200);
    state.recSeconds = 0;
    state.recStartTime = Date.now();
    $('composer-input-row')?.classList.add('hidden');
    $('voice-recorder-bar')?.classList.remove('hidden');

    state.recTimerInterval = setInterval(() => {
      state.recSeconds++;
      const mins = String(Math.floor(state.recSeconds / 60)).padStart(2, '0');
      const secs = String(state.recSeconds % 60).padStart(2, '0');
      const timerEl = $('voice-rec-timer');
      if (timerEl) timerEl.textContent = `${mins}:${secs}`;
      if (state.recSeconds >= 300) {
        stopVoiceRecording();
      }
    }, 1000);

  } catch (err) {
    console.warn('Live mic stream unavailable, falling back to audio input:', err);
    $('voice-file-input')?.click();
    resetVoiceRecorderUi();
  }
}

function stopVoiceRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  } else {
    resetVoiceRecorderUi();
  }
}

function cancelVoiceRecording() {
  state.audioChunks = [];
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
  resetVoiceRecorderUi();
  showToast('Voice recording canceled.');
}

async function sendVoiceMessage(audioBlob) {
  if (!state.user || !state.activeThreadId) return;
  // Site Control: chat paused — only admins can send voice messages
  if (sitePaused && !isSiteAdmin()) {
    showToast('Chat is temporarily paused by the admin.');
    return;
  }
  // Cooldown gate (settings.chatCooldownSec)
  if (!(await checkChatCooldown())) return;
  try {
    await useVoiceUploadQuota();
  } catch (quotaErr) {
    showToast(quotaErr.message);
    return;
  }
  showToast('Uploading voice message…');
  try {
    const audioUrl = await uploadToCloudinary(audioBlob, null, state.user.uid);
    const timestamp = Date.now();
    const payload = {
      senderId: state.user.uid,
      timestamp,
      text: '',
      audio: audioUrl,
      image: audioUrl
    };
    if (state.replyTo) {
      payload.replyTo = {
        id: state.replyTo.id,
        senderId: state.replyTo.senderId,
        text: (state.replyTo.text || '').slice(0, 120),
        hasImage: Boolean(state.replyTo.image),
        image: state.replyTo.image || null,
        audio: state.replyTo.audio || null
      };
    }
    window._jumpToLatest = true;
    await push(ref(db, `chatMessages/${state.activeThreadId}`), payload);
    clearReply();
    updateStreak(state.activeThreadId);
    try { await updateConversationSummaries('🎤 Voice message', timestamp); } catch (err) { console.error('Summary update error:', err); }
  } catch (err) {
    showToast(`Could not send voice message: ${err.message}`);
  }
}

function openThread(threadId, inboxItem) {
  if (!state.user) return showAuth();
  state.activeThreadId = threadId;
  state.activeInboxItem = inboxItem || state.inbox[threadId] || {};
  state.activePeerId = state.activeInboxItem.isGroup ? null : state.activeInboxItem.peerId;
  state.noMoreOldMessages = false;
  state.loadingOldMessages = false;
  $('empty-state').classList.add('hidden'); $('active-chat').classList.remove('hidden'); updateChatHeader(); renderConversations(); markThreadRead(threadId);
  if (state.stopMessages) state.stopMessages();
  state.messages = {}; state.messagesLoaded = false;
  $('message-list').innerHTML = `<div class="msg-skeleton-list">
    <div class="msg-skeleton-row"><div class="msg-skeleton-avatar skeleton"></div><div class="msg-skeleton-body"><div class="msg-skeleton-bubble skeleton"></div><div class="msg-skeleton-time skeleton"></div></div></div>
    <div class="msg-skeleton-row me"><div class="msg-skeleton-body"><div class="msg-skeleton-bubble skeleton"></div><div class="msg-skeleton-time skeleton"></div></div></div>
    <div class="msg-skeleton-row"><div class="msg-skeleton-avatar skeleton"></div><div class="msg-skeleton-body"><div class="msg-skeleton-bubble short skeleton"></div><div class="msg-skeleton-time skeleton"></div></div></div>
    <div class="msg-skeleton-row me"><div class="msg-skeleton-body"><div class="msg-skeleton-bubble skeleton"></div><div class="msg-skeleton-bubble short skeleton"></div><div class="msg-skeleton-time skeleton"></div></div></div>
    <div class="msg-skeleton-row"><div class="msg-skeleton-avatar skeleton"></div><div class="msg-skeleton-body"><div class="msg-skeleton-bubble skeleton"></div><div class="msg-skeleton-time skeleton"></div></div></div>
  </div>`;
  state.stopMessages = onValue(query(ref(db, `chatMessages/${threadId}`), limitToLast(30)), (snapshot) => {
    const firstLoad = !state.messagesLoaded;
    state.messagesLoaded = true;
    const fresh = snapshot.val() || {};
    state.messages = { ...state.messages, ...fresh };
    renderMessages(undefined, firstLoad);
    markThreadSeen(threadId);
  });
  // Scroll-up to load older messages
  const list = $('message-list');
  list._scrollHandler && list.removeEventListener('scroll', list._scrollHandler);
  list._scrollHandler = () => { if (list.scrollTop < 80) loadOlderMessages(); };
  list.addEventListener('scroll', list._scrollHandler);
  watchStreak(threadId);
  watchPinnedMessage(threadId);
  watchTyping(threadId); watchSeen(threadId); syncThreadSummaryWatchers(); 
  
  if (threadId === 'global_announcements' && !state.users[state.user.uid]?.isAdmin && !state.users[state.user.uid]?.isCreator) {
    $('message-form').classList.add('hidden');
  } else if (state.users[state.user.uid]?.isBanned) {
    $('message-form').classList.add('hidden');
    let banBar = $('chat-ban-bar');
    if (!banBar) {
      banBar = document.createElement('div');
      banBar.id = 'chat-ban-bar';
      banBar.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px;background:rgba(239,68,68,0.1);border-top:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:13px;font-weight:600;';
      banBar.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> You are banned from Hangout Chat.';
      $('message-form').parentNode.appendChild(banBar);
    }
    banBar.style.display = 'flex';
  } else {
    $('message-form').classList.remove('hidden');
    const banBar = $('chat-ban-bar');
    if (banBar) banBar.style.display = 'none';
    $('message-input').focus();
  }
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
    const isPublic = $('make-public-group').checked;
    await set(ref(db, `chatThreads/${threadId}`), { members, isGroup: true, isPublic, creatorId: state.user.uid, createdAt: now, lastMessage: 'Group created', lastTimestamp: now, lastSenderId: state.user.uid });
    const summary = { isGroup: true, isPublic, members, lastMessage: 'Group created', lastTimestamp: now, lastSenderId: state.user.uid, unreadCount: 0, creatorId: state.user.uid };
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
        const maxSide = 1280; const scale = Math.min(1, maxSide / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height); const output = canvas.toDataURL('image/jpeg', 0.78);
        if (output.length > 2000000) reject(new Error('That image is still too large after compression. Try a smaller one.')); else resolve(output);
      }; image.src = reader.result;
    }; reader.readAsDataURL(file);
  });
}

function uploadToCloudinary(fileOrBase64, onProgress, folder = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/auto/upload`;
    const formData = new FormData();
    formData.append('file', fileOrBase64);
    formData.append('upload_preset', cloudinaryConfig.uploadPreset);
    if (folder) {
      formData.append('folder', `users/${folder}`);
    }
    
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          onProgress(percent);
        }
      };
    }
    
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          resolve(data.secure_url);
        } catch (err) {
          reject(new Error('Invalid response from Cloudinary'));
        }
      } else {
        reject(new Error('Failed to upload media to Cloudinary'));
      }
    };
    
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
}

async function useUploadQuota() {
  const limit = chatSettings.chatImageLimit;
  const day = new Date().toISOString().slice(0, 10); const result = await runTransaction(ref(db, `chatUploadQuota/${state.user.uid}/${day}`), (count) => (Number(count || 0) >= limit ? undefined : Number(count || 0) + 1));
  if (!result.committed) throw new Error(`Daily photo limit reached (${limit} uploads). Try again tomorrow.`);
}
async function useVideoUploadQuota() {
  const limit = chatSettings.chatVideoLimit;
  const day = new Date().toISOString().slice(0, 10); const result = await runTransaction(ref(db, `chatVideoUploadQuota/${state.user.uid}/${day}`), (count) => (Number(count || 0) >= limit ? undefined : Number(count || 0) + 1));
  if (!result.committed) throw new Error(`Daily video limit reached (${limit} uploads). Try again tomorrow.`);
}
async function useVoiceUploadQuota() {
  const limit = chatSettings.chatVoiceLimit;
  const day = new Date().toISOString().slice(0, 10); const result = await runTransaction(ref(db, `chatVoiceUploadQuota/${state.user.uid}/${day}`), (count) => (Number(count || 0) >= limit ? undefined : Number(count || 0) + 1));
  if (!result.committed) throw new Error(`Daily voice message limit reached (${limit} recordings). Try again tomorrow.`);
}

function clearAttachment() { 
  $('image-input').value = ''; 
  state.pendingImageFile = null; 
  $('media-preview-banner').classList.add('hidden');
  $('media-preview-content').innerHTML = '';
}
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
// ==========================================
// STREAK SYSTEM (v4.8)
// ==========================================
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function thisMonthStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

function watchStreak(threadId) {
  if (state.stopStreak) {
    state.stopStreak();
    state.stopStreak = null;
  }
  if (!state.user || !threadId) return;
  const isGroup = Boolean(state.activeInboxItem?.isGroup || state.inbox[threadId]?.isGroup || threadId.startsWith('group_') || threadId === 'global_announcements');
  const streakRef = ref(db, isGroup ? `chatStreaks/${threadId}/groupStreak` : `chatStreaks/${threadId}/${state.user.uid}`);
  
  state.stopStreak = onValue(streakRef, (snap) => {
    state.streakData = snap.val() || null;
    state.streaks[threadId] = state.streakData;
    renderStreakBadge();
    renderConversations();
  });
}

function renderStreakBadge() {
  const badge = $('streak-badge');
  const restoreBtn = $('streak-restore-btn');
  if (!badge) return;
  const data = state.streakData;
  if (!data || !data.count || data.count < 1) {
    badge.classList.add('hidden');
    if (restoreBtn) restoreBtn.classList.add('hidden');
    return;
  }
  badge.textContent = `🔥 ${data.count}`;
  badge.classList.remove('hidden');
  const today = todayStr(); const yesterday = yesterdayStr();
  const lastDate = data.lastDate || '';
  // Streak is "restorable" if it just broke today (previousCount saved) OR if lastDate is stale (missed yesterday)
  const justBroke = data.brokenDate === today && data.previousCount > 1;
  const stale = lastDate !== today && lastDate !== yesterday;
  const broken = justBroke || stale;
  const month = thisMonthStr();
  const restoresLeft = (data.restoreMonth === month ? (3 - (data.restoreCount || 0)) : 3);
  if (restoreBtn) {
    if (broken && restoresLeft > 0) {
      restoreBtn.classList.remove('hidden');
      restoreBtn.title = `Restore streak (${restoresLeft} left this month)`;
      restoreBtn.textContent = `🔥 Restore (${restoresLeft} left)`;
    } else {
      restoreBtn.classList.add('hidden');
    }
  }
}

async function updateStreak(threadId) {
  if (!state.user || !threadId) return;
  const isGroup = Boolean(state.activeInboxItem?.isGroup || state.inbox[threadId]?.isGroup || threadId.startsWith('group_') || threadId === 'global_announcements');
  const streakRef = ref(db, isGroup ? `chatStreaks/${threadId}/groupStreak` : `chatStreaks/${threadId}/${state.user.uid}`);
  try {
    const snap = await get(streakRef);
    const data = snap.val() || {};
    const today = todayStr();
    const yesterday = yesterdayStr();
    const lastDate = data.lastDate || '';
    let count = data.count || 0;
    if (lastDate === today) return; // Already counted today for this group/conversation

    const update_data = { lastDate: today, lastSenderId: state.user.uid };
    if (lastDate === yesterday) {
      count += 1; // Extend streak
    } else {
      // Reset streak, but save previous if > 1
      if (count > 1) {
        update_data.previousCount = count;
        update_data.brokenDate = today;
      }
      count = 1; 
    }
    update_data.count = count;
    
    await set(streakRef, { ...data, ...update_data });
    state.streakData = { ...data, ...update_data };
    state.streaks[threadId] = state.streakData;
    renderStreakBadge();
    renderConversations();
  } catch (err) {
    console.warn('Could not update streak:', err);
  }
}

async function restoreStreak() {
  if (!state.user || !state.activeThreadId) return;
  const today = todayStr(); const month = thisMonthStr();
  const data = state.streakData || {};
  const restoreCount = (data.restoreMonth === month ? (data.restoreCount || 0) : 0);
  if (restoreCount >= 3) return showToast('You have used all 3 streak restores for this month.');
  const confirmed = await showAppModal({ title: 'Restore Streak 🔥', message: `Restore your streak? You have ${3 - restoreCount} restore${3 - restoreCount === 1 ? '' : 's'} left this month.`, confirmText: 'Restore', danger: false });
  if (!confirmed) return;
  const isGroup = Boolean(state.activeInboxItem?.isGroup || state.inbox[state.activeThreadId]?.isGroup || state.activeThreadId.startsWith('group_'));
  const streakRef = ref(db, isGroup ? `chatStreaks/${state.activeThreadId}/groupStreak` : `chatStreaks/${state.activeThreadId}/${state.user.uid}`);
  const newData = { ...data, lastDate: today, restoreCount: restoreCount + 1, restoreMonth: month };
  
  if (newData.previousCount) {
    newData.count = newData.previousCount;
    delete newData.previousCount;
    delete newData.brokenDate;
  }
  
  await set(streakRef, newData).catch(() => {});
  state.streakData = newData;
  state.streaks[state.activeThreadId] = newData;
  renderStreakBadge();
  showToast('🔥 Streak restored!');
}

// Cooldown gate for sending chat messages — text, media and voice (settings.chatCooldownSec). 0 = disabled.
// Timer stored in RTDB (users/{uid}/lastChatAt) so it applies per-account across devices.
async function checkChatCooldown() {
  const cd = Number(chatSettings.chatCooldownSec ?? 0);
  if (!cd || cd <= 0 || !state.user) return true;
  try {
    const snap = await get(ref(db, `users/${state.user.uid}/lastChatAt`));
    const waitMs = cd * 1000 - (Date.now() - Number(snap.val() || 0));
    if (waitMs > 0) {
      showToast(`Please wait ${Math.ceil(waitMs / 1000)}s before sending again.`);
      return false;
    }
    update(ref(db, `users/${state.user.uid}`), { lastChatAt: Date.now() });
    return true;
  } catch (e) { return true; } // fail-open on read errors
}

async function sendMessage(event) {
  event.preventDefault(); if (!state.user || !state.activeThreadId) return;

  // Ban check — blocked users cannot send messages
  if (state.users[state.user.uid]?.isBanned) {
    return showToast('You are banned from using Hangout Chat.');
  }

  // Site Control: chat paused — only admins can send messages
  if (sitePaused && !isSiteAdmin()) {
    return showToast('Chat is temporarily paused by the admin.');
  }

  if (state.activeThreadId === 'global_announcements') {
    // If the user's uid is not the 'admin' or whatever role allows sending announcements, block it.
    // For now we'll allow it only if state.users[state.user.uid].isAdmin is true, or similar logic.
    // Since we don't have a strict admin flag, we'll allow sending only if the user is designated as admin.
    if (!state.users[state.user.uid]?.isAdmin && !state.users[state.user.uid]?.isCreator) {
      return showToast('Only admins can send messages in Global Announcements.');
    }
  }
  const input = $('message-input'); const text = input.value.trim(); const file = state.pendingImageFile; if (!text && !file) return;
  // Cooldown gate (settings.chatCooldownSec)
  if (!(await checkChatCooldown())) return;
  const button = $('send-button'); 
  button.disabled = true;
  const originalButtonHtml = button.innerHTML;
  
  try {
    let image = null;
    const progressCallback = (percent) => { button.innerHTML = `<span style="font-size:10px">${percent}%</span>`; };
    if (file) {
      button.innerHTML = '<span style="font-size:10px">0%</span>';
      if (file.type.startsWith('video/')) {
        image = await uploadToCloudinary(file, progressCallback, state.user.uid);
        await useVideoUploadQuota();
      } else {
        const base64Img = await compressImage(file);
        image = await uploadToCloudinary(base64Img, progressCallback, state.user.uid);
        await useUploadQuota();
      }
    }
    button.innerHTML = originalButtonHtml;
    const timestamp = Date.now(); const payload = { senderId: state.user.uid, text, timestamp };
    if (image) payload.image = image;
    if (state.replyTo) payload.replyTo = { id: state.replyTo.id, senderId: state.replyTo.senderId, text: (state.replyTo.text || '').slice(0, 120), hasImage: Boolean(state.replyTo.image), image: state.replyTo.image || null };
    window._jumpToLatest = true;
    await push(ref(db, `chatMessages/${state.activeThreadId}`), payload);
    resetComposer();
    updateStreak(state.activeThreadId);
    try { await updateConversationSummaries(text || (file?.type.startsWith('video/') ? '🎥 Video' : '📷 Photo'), timestamp); } catch (error) { console.error('Message was sent, but its inbox summary failed:', error); }
  } catch (error) {
    button.innerHTML = originalButtonHtml;
    if (file && /limit reached/.test(error.message)) { clearAttachment(); showToast(error.message + ' The media was removed—your text is ready to send.'); }
    else showToast(`Could not send: ${error.message.replace('Firebase: ', '')}`);
  }
  button.disabled = false;
}

async function toggleReaction(messageId, reaction) {
  if (!state.user || !state.activeThreadId) return;
  const currentReactions = state.messages[messageId]?.reactions || {};
  const current = Boolean(currentReactions[reaction]?.[state.user.uid]);
  
  const updates = {};
  // Clear any existing reactions by this user on this message (both standard and custom emoji)
  Object.keys(currentReactions).forEach((key) => {
    if (currentReactions[key]?.[state.user.uid]) {
      updates[`${key}/${state.user.uid}`] = null;
    }
  });
  // Clear standard reaction slots for this user as well to be completely robust
  Object.keys(reactions).forEach((type) => {
    updates[`${type}/${state.user.uid}`] = null;
  });

  // If adding/changing reaction (and it wasn't already active), set it to true
  if (!current) {
    updates[`${reaction}/${state.user.uid}`] = true;
  }

  try { 
    await update(ref(db, `chatMessages/${state.activeThreadId}/${messageId}/reactions`), updates); 
  } catch (error) { 
    showToast(`Could not react: ${error.message.replace('Firebase: ', '')}`); 
  }
}
function setReply(message) { 
  if (!message) return; 
  state.replyTo = message; 
  let mediaHtml = '';
  if (message.image) {
    if (message.image.includes('/video/upload/') || message.image.match(/\\.(mp4|webm|mov|ogg)$/i)) mediaHtml = `<video src="${escapeHtml(message.image)}" style="width:20px;height:20px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;display:inline-block;"></video>`;
    else mediaHtml = `<img src="${escapeHtml(message.image)}" style="width:20px;height:20px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;display:inline-block;">`;
  }
  $('reply-banner-text').innerHTML = `Replying to ${getNickname(message.senderId)}: <br/> ${mediaHtml}${escapeHtml(replyPreview(message))}`; 
  $('reply-banner').classList.remove('hidden'); 
  $('message-input').focus(); 
}
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

async function deleteMessage(message) {
  const confirmDelete = await showAppModal({
    title: 'Delete Message',
    message: 'Are you sure you want to delete this message?',
    confirmText: 'Delete',
    danger: true
  });
  if (!confirmDelete) return;
  try {
    await update(ref(db, `chatMessages/${state.activeThreadId}/${message.id}`), { isDeleted: true });
    showToast('Message deleted.');
  } catch (err) {
    showToast('Could not delete message. Check permissions.');
  }
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
  if (state.stopPinnedMessage) { state.stopPinnedMessage(); state.stopPinnedMessage = null; }
  state.pinnedMessage = null;
  if (state.stopStreak) { state.stopStreak(); state.stopStreak = null; }
  const pinnedBar = $('pinned-message-bar');
  if (pinnedBar) { pinnedBar.classList.add('hidden'); pinnedBar.innerHTML = ''; }
  resetVoiceRecorderUi();
  const attachMenu = $('attach-menu');
  if (attachMenu) attachMenu.classList.add('hidden');
  if (state.stopSeen) {
    if (typeof state.stopSeen === 'function') state.stopSeen();
    else if (Array.isArray(state.stopSeen)) state.stopSeen.forEach(fn => fn());
  }
  // Remove scroll listener
  const list = $('message-list');
  if (list._scrollHandler) { list.removeEventListener('scroll', list._scrollHandler); list._scrollHandler = null; }
  state.stopSeen = null; state.activeThreadId = null; state.activePeerId = null; state.activeInboxItem = null; state.messages = {}; state.messagesLoaded = false; state.typing = {}; state.peerSeenAt = 0; state.groupSeenAt = {}; state.streakData = null; state.noMoreOldMessages = false; state.loadingOldMessages = false; clearReply(); closeMessageMenu();
  const badge = $('streak-badge'); if (badge) badge.classList.add('hidden');
  const restoreBtn = $('streak-restore-btn'); if (restoreBtn) restoreBtn.classList.add('hidden');
  syncThreadSummaryWatchers();
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
function saveInboxCache() {
  if (state.user) localStorage.setItem(`hangout-inbox-${state.user.uid}`, JSON.stringify(state.inbox));
}

function syncThreadSummaryWatchers() {
  const threadIds = new Set(Object.keys(state.inbox));
  if (state.activeThreadId) threadIds.add(state.activeThreadId);
  Object.entries(state.stopThreadSummaries).forEach(([threadId, stop]) => {
    if (!threadIds.has(threadId)) { stop(); delete state.stopThreadSummaries[threadId]; }
  });
  threadIds.forEach((threadId) => {
    if (state.stopThreadSummaries[threadId]) return;
    state.stopThreadSummaries[threadId] = onValue(ref(db, `chatThreads/${threadId}`), (snapshot) => {
      const thread = snapshot.val(); const current = state.inbox[threadId];
      if (!thread || !current) return;
      const next = { ...current, lastMessage: thread.lastMessage || '', lastTimestamp: thread.lastTimestamp || 0, lastSenderId: thread.lastSenderId || '', nicknames: thread.nicknames || {}, members: thread.members || {}, creatorId: thread.creatorId || current.creatorId || '', name: thread.name || current.name || '', pic: thread.pic || current.pic || '' };
      if (next.lastMessage === current.lastMessage && next.lastTimestamp === current.lastTimestamp && next.lastSenderId === current.lastSenderId && JSON.stringify(next.nicknames) === JSON.stringify(current.nicknames || {}) && next.name === (current.name || '') && JSON.stringify(next.members) === JSON.stringify(current.members || '') && next.pic === (current.pic || '')) return;
      state.inbox = { ...state.inbox, [threadId]: next };
      if (state.activeThreadId === threadId) { state.activeInboxItem = next; updateChatHeader(); renderMessages(state.messages); }
      saveInboxCache();
      renderConversations();
    }, (error) => reportRealtimeError('conversation summary', error));
  });
}


async function loadAllStreaks() {
  if (!state.user) return;
  const threadIds = Object.keys(state.inbox);
  const results = await Promise.all(
    threadIds.map(tid => {
      const isGroup = state.inbox[tid]?.isGroup;
      const refPath = isGroup ? `chatStreaks/${tid}/groupStreak` : `chatStreaks/${tid}/${state.user.uid}`;
      return get(ref(db, refPath))
        .then(snap => ({ tid, data: snap.val() }))
        .catch(() => ({ tid, data: null }));
    })
  );
  results.forEach(({ tid, data }) => { if (data) state.streaks[tid] = data; });
  renderConversations();
}

function handleInbox(snapshot) {
  const previous = state.inbox; const next = snapshot.val() || {};
  Object.keys(next).forEach(id => {
    if (previous[id]) {
      if (previous[id].name !== undefined) next[id].name = previous[id].name;
      if (previous[id].pic !== undefined) next[id].pic = previous[id].pic;
      if (previous[id].creatorId !== undefined) next[id].creatorId = previous[id].creatorId;
      if (previous[id].members !== undefined) next[id].members = previous[id].members;
      if (previous[id].nicknames !== undefined) next[id].nicknames = previous[id].nicknames;
      if (previous[id].metadataLoaded !== undefined) next[id].metadataLoaded = previous[id].metadataLoaded;
    }
  });
  if (!next['global_announcements']) {
    next['global_announcements'] = {
      isGroup: true,
      name: '📢 Global Announcements',
      pic: 'https://api.dicebear.com/7.x/bottts/svg?seed=announcements&backgroundColor=transparent',
      lastMessage: 'Welcome to Announcements',
      lastTimestamp: 0,
      unreadCount: 0,
      members: {},
      creatorId: 'admin' // Placeholder, normally you would set your actual admin UID here
    };
  }
  state.inbox = next;
  saveInboxCache();
  if (state.inboxReady && state.user) Object.entries(next).forEach(([threadId, item]) => {
    const before = previous[threadId];
    if (item.lastSenderId !== state.user.uid && Number(item.lastTimestamp || 0) > Number(before?.lastTimestamp || 0)) showToast(`New message from ${state.users[item.peerId]?.name || 'a member'}`);
  });
  const firstLoad = !state.inboxReady;
  state.inboxReady = true;
  if (firstLoad) loadAllStreaks(); 
  syncThreadSummaryWatchers(); 
  renderConversations(); 
  updateUnreadTitle(); 
  markThreadRead();
}

// Debounced save so rapid child events don't thrash localStorage
let _saveUsersTimer = null;
function saveUsersCache() {
  clearTimeout(_saveUsersTimer);
  _saveUsersTimer = setTimeout(() => {
    try { localStorage.setItem('hangout-users', JSON.stringify(state.users)); } catch (e) {}
  }, 500);
}

get(ref(db, 'users')).then((snapshot) => {
  const raw = snapshot.val() || {};
  state.users = Object.fromEntries(Object.entries(raw).map(([uid, profile]) => [uid, { ...(profile || {}), uid }]));
  saveUsersCache(); // persist full list for next page load
  renderConversations();
  renderPeople();
  updateChatHeader();

  const usersRef = ref(db, 'users');
  onChildChanged(usersRef, (childSnap) => {
    const uid = childSnap.key;
    state.users[uid] = { ...(childSnap.val() || {}), uid };
    saveUsersCache();
    renderConversations();
    renderPeople();
    updateChatHeader();
  });
  onChildAdded(usersRef, (childSnap) => {
    const uid = childSnap.key;
    if (!state.users[uid]) {
      state.users[uid] = { ...(childSnap.val() || {}), uid };
      saveUsersCache();
      renderConversations();
      renderPeople();
    }
  });
  onChildRemoved(usersRef, (childSnap) => {
    delete state.users[childSnap.key];
    saveUsersCache();
    renderConversations();
    renderPeople();
  });
}).catch((error) => reportRealtimeError('member list', error));
onValue(ref(db, 'presence'), (snapshot) => { state.online = snapshot.val() || {}; renderConversations(); renderPeople(); updateChatHeader(); }, (error) => reportRealtimeError('presence', error));
onValue(ref(db, '.info/connected'), (snapshot) => { state.connected = snapshot.val() === true; if (state.connected) startOwnPresence(); });
let checkedInvite = false;
onAuthStateChanged(auth, async (user) => {
  const previousUser = state.user; if (previousUser && previousUser.uid !== user?.uid) stopOwnPresence(previousUser);
  state.user = user; if (state.stopInbox) state.stopInbox(); if (state.stopClears) state.stopClears(); if (state.stopPostsNotif) { state.stopPostsNotif(); state.stopPostsNotif = null; } stopThreadSummaryWatchers(); state.inbox = {}; state.clears = {}; state.inboxReady = false;
  // Restore cached inbox immediately so the first render shows correct GC names & nicknames (no flicker)
  if (user) {
    try {
      const cached = localStorage.getItem(`hangout-inbox-${user.uid}`);
      if (cached) { state.inbox = JSON.parse(cached); renderConversations(); }
    } catch (e) {}
  }
  
  if (!checkedInvite) {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteThreadId = urlParams.get('invite');
    if (inviteThreadId) {
      if (!user) {
        const choice = await showAppModal({ title: 'Group Invite', message: 'You have been invited to a group chat. Would you like to sign in to your account or continue as a Guest?', confirmText: 'Continue as Guest', cancelText: 'Sign in' });
        if (choice) {
          try { await signInAnonymously(auth); } catch (e) { showToast('Guest sign-in failed'); }
        } else {
          $('auth-dialog').showModal();
        }
        return; // wait for next auth state change
      } else {
        checkedInvite = true;
        window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
        try {
          if (user.isAnonymous && !state.users[user.uid]) {
             const name = `Guest_${Math.floor(Math.random() * 9999)}`;
             const pic = fallbackAvatar(user.uid);
             await update(ref(db, `users/${user.uid}`), { uid: user.uid, name, pic });
             state.users[user.uid] = { uid: user.uid, name, pic };
          }
          const snapshot = await get(ref(db, `chatThreads/${inviteThreadId}`));
          const thread = snapshot.val();
          if (!thread || !thread.isGroup || !thread.isPublic) {
            showToast('Invalid or expired invite link.');
          } else {
            await set(ref(db, `chatThreads/${inviteThreadId}/members/${user.uid}`), true);
            const summary = { isGroup: true, isPublic: true, members: { ...thread.members, [user.uid]: true }, lastMessage: thread.lastMessage || 'Joined via invite', lastTimestamp: thread.lastTimestamp || Date.now(), lastSenderId: thread.lastSenderId || user.uid, unreadCount: 0, creatorId: thread.creatorId, name: thread.name || '' };
            await set(ref(db, `chatInboxes/${user.uid}/${inviteThreadId}`), summary);
            await push(ref(db, `chatMessages/${inviteThreadId}`), { senderId: user.uid, text: 'joined via invite link.', timestamp: Date.now(), isSystem: true });
            setTimeout(() => openThread(inviteThreadId, summary), 500); // give time for inbox listener to catch up
            showToast('Joined the group chat!');
          }
        } catch (err) { showToast(`Could not join: ${err.message}`); }
      }
    } else {
      checkedInvite = true;
    }
  }
  if (user) {
    startOwnPresence();
    state.stopInbox = onValue(ref(db, `chatInboxes/${user.uid}`), handleInbox, (error) => reportRealtimeError('conversation list', error));
    state.stopClears = onValue(ref(db, `chatClears/${user.uid}`), (snapshot) => { state.clears = snapshot.val() || {}; if (state.activeThreadId) renderMessages(undefined, false); }, (error) => reportRealtimeError('message clears', error));
    // Mirror Hangout Posts notification badge on the back button (limited to latest 50)
    state.stopPostsNotif = onValue(query(ref(db, `notifications/${user.uid}`), limitToLast(50)), (snapshot) => {
      const notifs = snapshot.val() || {};
      const unread = Object.values(notifs).filter(n => !n.read).length;
      const badge = $('back-notif-badge');
      if (!badge) return;
      if (unread > 0) { badge.textContent = unread > 99 ? '99+' : unread; badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    });
  } else closeActiveChat();
  syncAuthUi(); updateUnreadTitle();
});

$('new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth()); $('empty-new-chat-button').addEventListener('click', () => state.user ? $('people-dialog').showModal() : showAuth()); $('show-auth-button').addEventListener('click', showAuth);
$('theme-toggle').addEventListener('click', () => applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'));
$('conversation-search').addEventListener('input', renderConversations); $('people-search').addEventListener('input', renderPeople); $('message-form').addEventListener('submit', sendMessage);
$('message-input').addEventListener('input', (event) => { 
  const list = $('message-list');
  const wasNearLatest = list ? list.scrollHeight - list.scrollTop - list.clientHeight < 90 : false;
  
  const composer = event.target.closest('.composer');
  if (composer) composer.style.minHeight = `${composer.offsetHeight}px`;

  event.target.style.height = '1px'; 
  event.target.style.height = `${Math.min(event.target.scrollHeight, 130)}px`; 

  if (composer) composer.style.minHeight = '';

  if (wasNearLatest) list.scrollTop = list.scrollHeight;
  if (event.target.value.trim()) noteTyping(); else setTyping(false); 
});

// Mobile keyboard auto-scroll fix
const resizeObserver = new ResizeObserver(() => {
  const list = $('message-list');
  if (list && list.lastElementChild && !$('chat-view').classList.contains('hidden')) {
    // If we are near the bottom, stay at the bottom when keyboard opens
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 150) {
      list.scrollTop = list.scrollHeight;
    }
  }
});
if ($('message-list')) resizeObserver.observe($('message-list'));
$('message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { 
  if (window.innerWidth < 768 || matchMedia('(pointer: coarse)').matches) return;
  event.preventDefault(); $('message-form').requestSubmit(); 
} });
$('send-button').addEventListener('mousedown', e => e.preventDefault());
$('send-button').addEventListener('touchstart', e => { if (e.cancelable) e.preventDefault(); if (!$('send-button').disabled) $('message-form').requestSubmit(); }, { passive: false });
$('image-input').addEventListener('change', (event) => { 
  const file = event.target.files[0]; 

  // Ban check — banned users cannot attach media
  if (state.users[state.user?.uid]?.isBanned) {
    showToast('You are banned from using Hangout Chat.');
    event.target.value = '';
    return;
  }

  if (file && file.type.startsWith('video/') && file.size > chatSettings.chatVideoSizeLimitMB * 1024 * 1024) {
    showToast(`Video is too large. Max size is ${chatSettings.chatVideoSizeLimitMB}MB.`);
    event.target.value = '';
    return;
  }
  
  state.pendingImageFile = file || null; 
  
  if (file) {
    showToast(`Media ready: ${file.name}. Limit: ${chatSettings.chatImageLimit} images or ${chatSettings.chatVideoLimit} videos daily.`);
    
    $('media-preview-content').innerHTML = '';
    if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.style.maxHeight = '100px';
        video.style.borderRadius = '8px';
        $('media-preview-content').appendChild(video);
    } else {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.maxHeight = '100px';
        img.style.borderRadius = '8px';
        $('media-preview-content').appendChild(img);
    }
    $('media-preview-banner').classList.remove('hidden');
  } else {
    clearAttachment();
  }
});
$('group-photo-input')?.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  if (state.activeInboxItem.creatorId !== state.user.uid) return showToast('Only the creator can set the group photo.');
  try {
    const base64Img = await compressImage(file);
    const b64 = await uploadToCloudinary(base64Img, null, state.user.uid);
    await update(ref(db, `chatThreads/${state.activeThreadId}`), { pic: b64 });
    showToast('Group photo updated.');
    $('conversation-dialog').close();
  } catch (err) { showToast('Could not update photo.'); }
  event.target.value = '';
});
$('cancel-reply-button').addEventListener('click', clearReply);
$('cancel-media-button')?.addEventListener('click', clearAttachment);
$('mobile-back-button').addEventListener('click', closeActiveChat);
$('conversation-options-button').addEventListener('click', () => {
  const isGroup = state.activeInboxItem?.isGroup;
  const isCreator = isGroup && state.activeInboxItem?.creatorId === state.user?.uid;
  const isModerator = isCreator || (isGroup && !!state.activeInboxItem?.moderators?.[state.user?.uid]);
  
  $('set-nickname-button').classList.toggle('hidden', !!isGroup);
  $('set-my-nickname-button').classList.toggle('hidden', !isGroup);
  $('rename-group-button').classList.toggle('hidden', !isCreator);
  $('set-group-photo-button').classList.toggle('hidden', !isCreator);
  $('add-member-button').classList.toggle('hidden', !isModerator);
  $('show-members-button').classList.toggle('hidden', !isGroup);
  $('manage-moderators-button').classList.toggle('hidden', !isCreator);
  $('kick-member-button').classList.toggle('hidden', !isModerator);
  $('transfer-ownership-button').classList.toggle('hidden', !isCreator);
  $('leave-group-button').classList.toggle('hidden', !isGroup);
  $('copy-invite-link-button').classList.toggle('hidden', !state.activeInboxItem?.isPublic);
  $('pin-conversation-text').textContent = state.activeInboxItem?.pinned ? 'Unpin Conversation' : 'Pin Conversation';
  $('conversation-dialog').showModal();
});
$('close-conversation-dialog').addEventListener('click', () => $('conversation-dialog').close());
$('clear-chat-button').addEventListener('click', clearChatForMe);
$('remove-conversation-button').addEventListener('click', removeConversation);
$('pin-conversation-button').addEventListener('click', async () => {
  if (!state.user || !state.activeThreadId) return;
  const current = !!state.activeInboxItem?.pinned;
  try {
    await update(ref(db, `chatInboxes/${state.user.uid}/${state.activeThreadId}`), { pinned: !current });
    $('conversation-dialog').close();
    showToast(current ? 'Conversation unpinned.' : 'Conversation pinned.');
  } catch (err) { showToast('Could not pin conversation.'); }
});
$('rename-group-button')?.addEventListener('click', renameGroup);
$('add-member-button')?.addEventListener('click', addMember);
$('show-members-button')?.addEventListener('click', showMembers);
$('kick-member-button')?.addEventListener('click', kickMember);
$('manage-moderators-button')?.addEventListener('click', manageModerators);
$('transfer-ownership-button')?.addEventListener('click', transferOwnership);
$('leave-group-button')?.addEventListener('click', leaveGroup);
$('copy-invite-link-button')?.addEventListener('click', () => {
  const link = `${window.location.origin}${window.location.pathname}?invite=${state.activeThreadId}`;
  navigator.clipboard.writeText(link).then(() => showToast('Invite link copied to clipboard!')).catch(() => showToast('Failed to copy link.'));
  $('conversation-dialog').close();
});
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

$('set-my-nickname-button')?.addEventListener('click', async () => {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  $('conversation-dialog').close();
  const currentNick = state.activeInboxItem.nicknames?.[state.user.uid] || '';
  const newNickname = await showAppModal({ title: 'Set My Nickname', message: `Set how you appear in this group. Leave blank to reset.`, input: true, inputValue: currentNick });
  if (newNickname === null) return;
  try {
    await update(ref(db, `chatThreads/${state.activeThreadId}/nicknames`), { [state.user.uid]: newNickname.trim() || null });
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

async function showMembers() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  $('conversation-dialog').close();
  const peerIds = Object.keys(state.activeInboxItem.members || {});
  const list = peerIds.map(uid => ({ uid, name: getNickname(uid), avatar: avatarUrl(state.users[uid]), isCreator: uid === state.activeInboxItem.creatorId })).sort((a, b) => b.isCreator - a.isCreator || a.name.localeCompare(b.name));
  await showAppModal({ title: 'Group Members', memberList: list, cancelText: 'Close', confirmText: 'OK' });
}

async function kickMember() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  const isCreator = state.activeInboxItem.creatorId === state.user.uid;
  const isModerator = isCreator || !!state.activeInboxItem.moderators?.[state.user.uid];
  if (!isModerator) return showToast('Only the group creator or a moderator can kick members.');
  const allIds = Object.keys(state.activeInboxItem.members || {});
  if (allIds.length <= 1) return showToast('No other members to kick.');
  
  // Exclude creator from being kicked. If current user is only a moderator, also exclude other moderators.
  const mods = state.activeInboxItem.moderators || {};
  let memberList = allIds.map(id => ({ uid: id, name: state.users[id]?.name || 'Member', avatar: avatarUrl(state.users[id]), isCreator: id === state.activeInboxItem.creatorId, isMod: !!mods[id] }));
  
  // Filter out creator and, if not creator, other moderators.
  memberList = memberList.filter(m => {
    if (m.isCreator) return false; // Never kick creator
    if (!isCreator && m.isMod) return false; // Mods can't kick other mods
    return true;
  });
  
  if (!memberList.length) return showToast('No eligible members to kick.');
  
  $('conversation-dialog').close();
  const selected = await showAppModal({ title: 'Kick Member', message: 'Select a member to remove from this group.', memberList, disabledUid: state.user.uid, multiSelect: false, confirmText: 'Kick', danger: true });
  if (!selected || !selected.length) return;
  const targetUid = selected[0]; const targetName = state.users[targetUid]?.name || 'this member';
  const confirmed = await showAppModal({ title: 'Confirm Kick', message: `Are you sure you want to kick ${targetName} from the group?`, confirmText: 'Kick', danger: true });
  if (!confirmed) return;
  try {
    const updates = { [`chatThreads/${state.activeThreadId}/members/${targetUid}`]: null };
    if (mods[targetUid]) updates[`chatThreads/${state.activeThreadId}/moderators/${targetUid}`] = null;
    await update(ref(db), updates);
  } catch (err) { return showToast(`Failed to remove member: ${err.message}`); }
  
  remove(ref(db, `chatInboxes/${targetUid}/${state.activeThreadId}`)).catch(e => console.warn('Ignored inbox remove error:', e));
  
  try {
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `kicked ${targetName}.`, timestamp: Date.now(), isSystem: true });
  } catch (err) { console.warn('Failed to send kick system message:', err); }
  
  showToast(`${targetName} was kicked.`);
}

async function addMember() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  const isCreator = state.activeInboxItem.creatorId === state.user.uid;
  const isModerator = isCreator || !!state.activeInboxItem.moderators?.[state.user.uid];
  if (!isModerator) return showToast('Only the group creator or a moderator can add members.');
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
    const summary = { isGroup: true, members: updatedMembers, lastMessage: state.activeInboxItem.lastMessage || 'Added to group', lastTimestamp: state.activeInboxItem.lastTimestamp || Date.now(), lastSenderId: state.activeInboxItem.lastSenderId || state.user.uid, unreadCount: 1, name: state.activeInboxItem.name || '', creatorId: state.activeInboxItem.creatorId || state.user.uid, moderators: state.activeInboxItem.moderators || null };
    for (const uid of selected) { await runTransaction(ref(db, `chatInboxes/${uid}/${state.activeThreadId}`), (current) => current || summary).catch(() => {}); }
    const addedNames = selected.map(uid => state.users[uid]?.name || 'a member').join(', ');
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `added ${addedNames}.`, timestamp: Date.now(), isSystem: true });
    showToast(`${selected.length} member${selected.length > 1 ? 's' : ''} added.`);
  } catch (err) { showToast(`Could not add members: ${err.message}`); }
}

async function manageModerators() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  if (state.activeInboxItem.creatorId !== state.user.uid) return showToast('Only the group creator can manage moderators.');
  const allIds = Object.keys(state.activeInboxItem.members || {}).filter(id => id !== state.user.uid);
  if (!allIds.length) return showToast('No other members to manage.');
  const currentMods = state.activeInboxItem.moderators || {};
  const memberList = allIds.map(id => ({ uid: id, name: getNickname(id), avatar: avatarUrl(state.users[id]), isCreator: false }));
  $('conversation-dialog').close();
  const selected = await showAppModal({ title: 'Manage Moderators', message: 'Select members to make them moderators. Uncheck to remove moderator status.', memberList, multiSelect: true, confirmText: 'Save', selectedList: Object.keys(currentMods) });
  if (!selected) return; // cancelled
  const newMods = {};
  selected.forEach(uid => newMods[uid] = true);
  const modsValue = Object.keys(newMods).length ? newMods : null;
  try {
    await update(ref(db, `chatThreads/${state.activeThreadId}`), { moderators: modsValue });
    
    const addedMods = selected.filter(uid => !currentMods[uid]);
    const removedMods = Object.keys(currentMods).filter(uid => !newMods[uid]);
    
    if (addedMods.length > 0) {
      const addedNames = addedMods.map(uid => state.users[uid]?.name || 'a member').join(', ');
      await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `made ${addedNames} a moderator.`, timestamp: Date.now(), isSystem: true });
    }
    if (removedMods.length > 0) {
      const removedNames = removedMods.map(uid => state.users[uid]?.name || 'a member').join(', ');
      await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `removed moderator status from ${removedNames}.`, timestamp: Date.now(), isSystem: true });
    }
    
    const memberIds = Object.keys(state.activeInboxItem.members || {});
    memberIds.forEach(uid => {
      runTransaction(ref(db, `chatInboxes/${uid}/${state.activeThreadId}`), (current) => {
        if (!current) return current;
        current.moderators = modsValue;
        return current;
      }).catch(()=>{});
    });
    
    showToast('Moderators updated.');
  } catch (err) { showToast(`Could not update moderators: ${err.message}`); }
}

async function transferOwnership() {
  if (!state.user || !state.activeThreadId || !state.activeInboxItem?.isGroup) return;
  if (state.activeInboxItem.creatorId !== state.user.uid) return showToast('Only the group creator can transfer ownership.');
  const allIds = Object.keys(state.activeInboxItem.members || {}).filter(id => id !== state.user.uid);
  if (!allIds.length) return showToast('No other members to transfer to.');
  const memberList = allIds.map(id => ({ uid: id, name: getNickname(id), avatar: avatarUrl(state.users[id]), isCreator: false }));
  $('conversation-dialog').close();
  const selected = await showAppModal({ title: 'Transfer Ownership', message: 'Select a member to become the new group creator. You will lose creator privileges.', memberList, multiSelect: false, confirmText: 'Transfer', danger: true });
  if (!selected || !selected.length) return;
  const targetUid = selected[0];
  const targetName = state.users[targetUid]?.name || 'a member';
  const confirmed = await showAppModal({ title: 'Confirm Transfer', message: `Are you sure you want to make ${targetName} the new creator? You will no longer be able to manage this group as the creator.`, confirmText: 'Confirm', danger: true });
  if (!confirmed) return;
  try {
    await update(ref(db, `chatThreads/${state.activeThreadId}`), { creatorId: targetUid });
    await push(ref(db, `chatMessages/${state.activeThreadId}`), { senderId: state.user.uid, text: `transferred group ownership to ${targetName}.`, timestamp: Date.now(), isSystem: true });
    
    const memberIds = Object.keys(state.activeInboxItem.members || {});
    memberIds.forEach(uid => {
      runTransaction(ref(db, `chatInboxes/${uid}/${state.activeThreadId}`), (current) => {
        if (!current) return current;
        current.creatorId = targetUid;
        return current;
      }).catch(()=>{});
    });
    
    showToast(`Ownership transferred to ${targetName}.`);
  } catch (err) { showToast(`Transfer failed: ${err.message}`); }
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
document.addEventListener('pointerdown', (event) => { 
  if (!event.target.closest('#message-action-menu') && !event.target.closest('.message-bubble')) closeMessageMenu(); 
  if (!event.target.closest('.attach-menu-wrap')) {
    $('attach-menu')?.classList.add('hidden');
  }
});
window.addEventListener('pagehide', () => setTyping(false));
if (window.visualViewport) {
  const applyViewport = () => {
    const vv = window.visualViewport;
    const shell = document.querySelector('.app-shell');
    if (!shell) return;
    // Clamp the shell to the exact visible height and shift it to follow the visual viewport
    shell.style.height = `${vv.height}px`;
    // On Android Chrome the layout viewport doesn't shrink; offsetTop accounts for any scroll
    shell.style.transform = `translateY(${vv.offsetTop}px)`;
  };
  window.visualViewport.addEventListener('resize', applyViewport);
  window.visualViewport.addEventListener('scroll', applyViewport);
}
// Image viewer close handlers (v4.4)
$('image-viewer-close').addEventListener('click', closeImageViewer);
$('image-viewer-backdrop').addEventListener('click', closeImageViewer);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeImageViewer(); });
// Streak restore button (v4.8)
$('streak-restore-btn')?.addEventListener('click', restoreStreak);

// Attach menu & voice recorder event listeners
$('attach-plus-button')?.addEventListener('click', (e) => {
  e.stopPropagation();
  $('attach-menu')?.classList.toggle('hidden');
});
$('attach-media-item')?.addEventListener('click', () => {
  $('attach-menu')?.classList.add('hidden');
  $('image-input')?.click();
});
$('attach-voice-item')?.addEventListener('click', () => {
  $('attach-menu')?.classList.add('hidden');
  startVoiceRecording();
});
$('attach-game-item')?.addEventListener('click', () => {
  $('attach-menu')?.classList.add('hidden');
  showToast('🎮 Hangout Mini-Games are coming in the next update!');
});

$('voice-rec-stop')?.addEventListener('click', stopVoiceRecording);
$('voice-rec-cancel')?.addEventListener('click', cancelVoiceRecording);

// ── Google Sign-In ──
$('google-login-btn')?.addEventListener('click', async () => {
  const error = $('auth-error'); error.classList.add('hidden');
  const btn = $('google-login-btn'); const originalHtml = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Connecting…';
  try {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    // First-time Google users get a profile created from their Google account
    const userSnap = await get(ref(db, `users/${result.user.uid}`));
    if (!userSnap.exists()) {
      const name = result.user.displayName || `User_${Math.floor(Math.random() * 999)}`;
      const pic = result.user.photoURL || fallbackAvatar(result.user.uid);
      await updateProfile(result.user, { displayName: name, photoURL: pic });
      await update(ref(db, `users/${result.user.uid}`), { uid: result.user.uid, name, pic });
    }
    $('auth-dialog').close();
  } catch (err) {
    error.textContent = err.code === 'auth/account-exists-with-different-credential'
      ? 'This email already has an account with a password. Sign in with email/password instead.'
      : err.code === 'auth/popup-closed-by-user'
        ? 'Google sign-in was closed before finishing.'
        : err.code === 'auth/unauthorized-domain'
          ? 'This domain is not authorized for Google sign-in.'
          : err.message.replace('Firebase: ', '');
    error.classList.remove('hidden');
  } finally { btn.innerHTML = originalHtml; btn.disabled = false; }
});

$('voice-file-input')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.user || !state.activeThreadId) return;
  event.target.value = '';
  await sendVoiceMessage(file);
});

// Header avatar click -> redirect to profile view
$('chat-avatar-wrap')?.addEventListener('click', () => {
  if (!state.activeInboxItem) return;
  if (state.activeInboxItem.isGroup) {
    $('conversation-options-button')?.click();
    return;
  }
  const peerIds = getThreadPeers(state.activeInboxItem);
  const peerId = peerIds[0] || (state.activeInboxItem.peerId === state.user?.uid ? state.user?.uid : state.activeInboxItem.peerId);
  if (peerId) openUserProfile(peerId);
});



