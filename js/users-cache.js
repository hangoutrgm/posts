// ============================================================
// users-cache.js — tiny shared localStorage cache for the full /users table.
// Loaded as a plain classic script on Posts, Chat, and Treasury pages so they
// share ONE snapshot across page loads (a big RTDB download saver — previously
// each page re-downloaded the whole /users table on every visit).
//
// TTL bounds staleness (~2 min). Each page also keeps a live listener for the
// signed-in user's own record + refreshes on demand (members modal / profile
// views), so nothing users see goes stale for long.
// ============================================================
(function () {
  var KEY = 'hangout-users-cache-v2';
  var TTL_MS = 12 * 60 * 60 * 1000; // 12 hours (optimized for RTDB bandwidth conservation)

  // Clean up legacy or corrupted v1 cache from clients
  try { localStorage.removeItem('hangout-users-cache'); } catch (e) {}

  window.usersCache = {
    read: function () {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (!p || !p.users || typeof p.users !== 'object' || Array.isArray(p.users) || !p.savedAt) return null;
        // Require at least 2 users to guard against single-user cache poisoning
        if (Object.keys(p.users).length < 2) return null;
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