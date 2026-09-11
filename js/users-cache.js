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
  var KEY = 'hangout-users-cache';
  var TTL_MS = 120000; // 2 minutes

  window.usersCache = {
    read: function () {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (!p || !p.users || typeof p.users !== 'object' || !p.savedAt) return null;
        return p;
      } catch (e) { return null; }
    },
    isFresh: function (cached, now) {
      now = now || Date.now();
      return Boolean(cached && (now - cached.savedAt) < TTL_MS);
    },
    write: function (users) {
      try { localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), users: users || {} })); }
      catch (e) { /* storage quota — skip gracefully */ }
    },
    invalidate: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
    }
  };
})();