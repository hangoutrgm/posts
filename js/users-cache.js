// ============================================================
// Cloudinary Media Optimization Utilities
// Injects on-the-fly transformations (f_auto, q_auto, width limits, video posters)
// to dramatically slash bandwidth usage without visual degradation.
// ============================================================
(function () {
  function optimizeCloudinaryUrl(url, opts) {
    if (!url || typeof url !== 'string') return url || '';
    if (!url.includes('res.cloudinary.com')) return url;
    
    opts = opts || {};

    const isVideo = opts.isVideo || url.includes('/video/upload/') || /\.(mp4|webm|mov|ogg|m4v)(\?|#|$)/i.test(url);

    // 1. VIDEO POSTER / THUMBNAIL FRAME (frame ~2s in as an ultra-compact JPEG).
    //    Reading a couple of seconds in avoids the dark/faded first frame (so_0)
    //    becoming the preview. Cloudinary clamps gracefully on shorter videos.
    if (isVideo && (opts.asPoster || opts.asThumbnail)) {
      if (url.includes('/video/upload/so_')) return url;
      const w = opts.width || (opts.asThumbnail ? 120 : 640);
      const h = opts.height || (opts.asThumbnail ? 120 : 0);
      const crop = opts.crop || (opts.asThumbnail ? 'c_fill' : 'c_limit');
      const parts = ['so_2', 'f_jpg', 'q_auto', 'w_' + w];
      if (h) parts.push('h_' + h);
      parts.push(crop);
      const transform = parts.join(',');

      return url
        .replace('/video/upload/', '/video/upload/' + transform + '/')
        .replace(/\.(mp4|webm|mov|ogg|m4v)(\?|#|$)/i, '.jpg$2');
    }

    // 2. VIDEO STREAMING (Compressed 720p / auto quality)
    if (isVideo) {
      if (url.includes('/video/upload/q_auto') || url.includes(',q_auto') || url.includes('f_mp4')) return url;
      const w = opts.width || 720;
      const transform = 'f_mp4,q_auto,w_' + w + ',c_limit';
      return url.replace('/video/upload/', '/video/upload/' + transform + '/');
    }

    // 3. AVATARS / PROFILE PICTURES (Face-centered crop, auto WebP/AVIF format)
    if (opts.isAvatar) {
      if (url.includes('/image/upload/f_auto') || url.includes(',f_auto') || url.includes('g_face')) return url;
      const size = opts.width || 120;
      const transform = 'f_auto,q_auto,w_' + size + ',h_' + size + ',c_fill,g_face';
      return url.replace('/image/upload/', '/image/upload/' + transform + '/');
    }

    // 4. REGULAR IMAGES (Posts, comments, covers, full screen preview)
    if (url.includes('/image/upload/f_auto') || url.includes(',f_auto')) return url;
    const w = opts.width || 1080;
    const transform = 'f_auto,q_auto,w_' + w + ',c_limit';
    return url.replace('/image/upload/', '/image/upload/' + transform + '/');
  }

  window.optMedia = optimizeCloudinaryUrl;
  window.optAvatar = function (url, size) {
    if (!url) return '';
    return optimizeCloudinaryUrl(url, { isAvatar: true, width: size || 120 });
  };
  window.optVideoPoster = function (url, width) {
    if (!url) return '';
    return optimizeCloudinaryUrl(url, { asPoster: true, width: width || 640 });
  };
  window.optVideoThumb = function (url, size) {
    if (!url) return '';
    return optimizeCloudinaryUrl(url, { asThumbnail: true, width: size || 100, height: size || 100 });
  };
  window.optVideo = function (url, width) {
    if (!url) return '';
    return optimizeCloudinaryUrl(url, { isVideo: true, width: width || 720 });
  };
})();

// ============================================================
// users-cache.js — tiny shared localStorage cache for the full /users table.
// Loaded as a plain classic script on Posts, Chat, and Treasury pages so they
// share ONE snapshot across page loads (a big RTDB download saver — previously
// each page re-downloaded the whole /users table on every visit).
// ============================================================
(function () {
  var KEY = 'hangout-users-cache-v2';
  var TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (optimized for RTDB bandwidth conservation)

  // Clean up legacy or corrupted v1 cache from clients
  try { localStorage.removeItem('hangout-users-cache'); } catch (e) {}

  function sanitizeUsers(users) {
    if (!users || typeof users !== 'object' || Array.isArray(users)) return users;
    for (var uid in users) {
      if (!users[uid]) continue;
      if (users[uid].pic && typeof users[uid].pic === 'string') {
        users[uid].pic = window.optAvatar(users[uid].pic, 150);
      }
      if (users[uid].cover && typeof users[uid].cover === 'string') {
        users[uid].cover = window.optMedia(users[uid].cover, { width: 1080 });
      }
    }
    return users;
  }

  window.usersCache = {
    read: function () {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (!p || !p.users || typeof p.users !== 'object' || Array.isArray(p.users) || !p.savedAt) return null;
        // Require at least 2 users to guard against single-user cache poisoning
        if (Object.keys(p.users).length < 2) return null;
        sanitizeUsers(p.users);
        return p;
      } catch (e) { return null; }
    },
    isFresh: function (cached, now) {
      now = now || Date.now();
      if (!cached || !cached.users || typeof cached.users !== 'object' || Array.isArray(cached.users)) return false;
      if (Object.keys(cached.users).length < 2) return false;
      return Boolean((now - cached.savedAt) < TTL_MS);
    },
    write: function (users) {
      if (!users || typeof users !== 'object' || Array.isArray(users)) return;
      var count = Object.keys(users).length;
      if (count < 2) return; // Never overwrite the full cache with an empty or 1-user stub
      sanitizeUsers(users);
      try {
        localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), users: users }));
      } catch (e) { /* storage quota — skip gracefully */ }
    },
    updateUser: function (uid, userData) {
      if (!uid || !userData) return;
      try {
        var current = window.usersCache.read();
        // Do NOT create or corrupt cache if there is no valid multi-user cache in storage
        if (!current || !current.users || Object.keys(current.users).length < 2) return;
        if (userData.pic && typeof userData.pic === 'string') {
          userData.pic = window.optAvatar(userData.pic, 150);
        }
        if (userData.cover && typeof userData.cover === 'string') {
          userData.cover = window.optMedia(userData.cover, { width: 1080 });
        }
        current.users[uid] = Object.assign({}, current.users[uid] || {}, userData);
        localStorage.setItem(KEY, JSON.stringify({
          savedAt: current.savedAt || Date.now(),
          users: current.users
        }));
      } catch (e) {}
    },
    invalidate: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
    }
  };

  // Provide global bridge for modules calling window.writeUsersCache
  window.writeUsersCache = function (users) {
    if (window.usersCache && window.usersCache.write) {
      window.usersCache.write(users);
    }
  };
})();