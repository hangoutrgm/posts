// =========================================================
// Hangout Music — YouTube Audio Engine
// A thin wrapper around the YouTube IFrame Player API that plays
// invisible (1px x 1px) audio-only video and exposes simple transport
// methods the custom glass UI can drive:
//   play(videoId) · toggle() · seekTo(sec) · setVolume(0-100) · setMuted()
// It also emits a tick callback so the custom seekbar can follow the
// playhead, and fires onEnded so the queue can auto-advance.
// =========================================================

const YT_API_SRC = 'https://www.youtube.com/iframe_api';

// Mirrors window.YT.PlayerState without requiring the API to be loaded yet.
export const PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5
};

let apiPromise = null;

/**
 * Injects the YouTube IFrame API script exactly once and resolves with
 * window.YT as soon as it is usable. Safe to call many times.
 *
 * Note: YouTube's player bootstraps its own ad/TVHTML5 module, which requests
 * `googleads.g.doubleclick.net/pagead/id`. With an ad-blocker, a filtering DNS
 * (Pi-hole / hosts file) or off-network DNS, that shows up in the console as
 * `net::ERR_NAME_NOT_RESOLVED`. It is emitted by YouTube's code, not ours, and
 * playback is unaffected — no action needed (and no legitimate way to suppress it).
 * @returns {Promise<any>}
 */
export function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    // The API calls this global when it finishes booting. Chain any handler
    // another script (or a previous instance) may already have installed.
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') { try { previous(); } catch (_) {} }
      resolve(window.YT);
    };

    if (!document.querySelector(`script[src="${YT_API_SRC}"]`)) {
      const tag = document.createElement('script');
      tag.src = YT_API_SRC;
      tag.async = true;
      tag.onerror = () => reject(new Error('Could not load the YouTube IFrame API'));
      document.head.appendChild(tag);
    }

    // Safety net: the ready callback may have fired before we subscribed.
    let tries = 0;
    const poll = setInterval(() => {
      tries += 1;
      if (window.YT && window.YT.Player) {
        clearInterval(poll);
        resolve(window.YT);
      } else if (tries > 60) {
        clearInterval(poll);
        reject(new Error('YouTube IFrame API timed out'));
      }
    }, 250);
  });

  return apiPromise;
}

/**
 * Controller for one hidden audio-only YouTube player instance.
 */
export class YouTubeAudioPlayer {
  /**
   * @param {object} [options]
   * @param {string} [options.mountId]  id of the element the API will replace
   * @param {() => void} [options.onReady]
   * @param {(state:number, target:YouTubeAudioPlayer) => void} [options.onStateChange]
   * @param {() => void} [options.onEnded]
   * @param {(code:number) => void} [options.onError]
   * @param {(seconds:number, duration:number) => void} [options.onTime]
   * @param {(duration:number) => void} [options.onDuration]
   * @param {number} [options.volume]  0-100, default 80
   */
  constructor(options = {}) {
    this.mountId = options.mountId || 'yt-player-mount';
    this.onReady = options.onReady || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onEnded = options.onEnded || (() => {});
    this.onError = options.onError || (() => {});
    this.onTime = options.onTime || (() => {});
    this.onDuration = options.onDuration || (() => {});

    this.player = null;
    this.ready = false;
    this.playing = false;
    this.volume = this._clampVolume(options.volume ?? 100);
    this.muted = false;

    this._videoId = null;
    this._duration = 0;
    this._lastDuration = 0;
    this._tickTimer = null;
    this._dragging = false; // set while the user scrubs the seekbar
    this._initPromise = null; // memoized so init() never builds a second player
  }

  _clampVolume(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /**
   * Boots the API + player. Resolves once the player is ready to accept
   * commands. Call again to await readiness; it will not double-init.
   * @returns {Promise<YouTubeAudioPlayer>}
   */
  async init() {
    if (this.ready) return this;
    if (this._initPromise) return this._initPromise;
    await loadYouTubeAPI();

    this._initPromise = new Promise((resolve) => {
      this.player = new window.YT.Player(this.mountId, {
        height: '1',
        width: '1',
        videoId: '',
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            this.ready = true;
            if (typeof this.player.setVolume === 'function') this.player.setVolume(this.volume);
            if (typeof this.player.unMute === 'function') this.player.unMute();
            this.onReady(this);
            resolve(this);
          },
          onStateChange: (event) => this._handleState(event),
          onError: (event) => this.onError(event && event.data)
        }
      });
    });

    return this._initPromise;
  }

  _handleState(event) {
    const state = event && event.data;
    this.playing = state === PLAYER_STATE.PLAYING;

    if (state === PLAYER_STATE.PLAYING) {
      this._syncDuration();
      this._startTicker();
    } else {
      this._stopTicker();
      this._syncDuration();
      if (!this._dragging) {
        const t = this.getCurrentTime();
        this.onTime(t, this._duration);
      }
    }

    if (state === PLAYER_STATE.ENDED) this.onEnded();
    this.onStateChange(state, this);
  }

  _syncDuration() {
    const d = this.getDuration();
    if (d && Math.abs(d - this._lastDuration) > 0.5) {
      this._lastDuration = d;
      this._duration = d;
      this.onDuration(d);
    }
  }

  _startTicker() {
    this._stopTicker();
    // 250ms keeps the bar smooth without hammering the API.
    this._tickTimer = setInterval(() => {
      if (this._dragging) return;
      this.onTime(this.getCurrentTime(), this._duration);
    }, 250);
  }

  _stopTicker() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
  }

  /** Current video id (or null). */
  getVideoId() { return this._videoId; }

  /**
   * Loads and starts a video; no-op if it is already the active one.
   * @param {string} videoId
   * @param {number} [startSeconds] start offset — used to resume the last session
   */
  play(videoId, startSeconds = 0) {
    if (!this.ready || !videoId) return;
    const offset = Math.max(0, Number(startSeconds) || 0);
    if (this._videoId === videoId) {
      if (offset > 0) this.seekTo(offset);
      if (typeof this.player.playVideo === 'function') this.player.playVideo();
      return;
    }
    this._videoId = videoId;
    this._duration = 0;
    this._lastDuration = 0;
    if (typeof this.player.loadVideoById !== 'function') return;
    if (offset > 0) this.player.loadVideoById({ videoId, startSeconds: offset });
    else this.player.loadVideoById(videoId);
  }

  /** Cues a video without autoplaying it. */
  cue(videoId) {
    if (!this.ready || !videoId) return;
    this._videoId = videoId;
    this._duration = 0;
    this._lastDuration = 0;
    if (typeof this.player.cueVideoById === 'function') this.player.cueVideoById(videoId);
  }

  playVideo() { if (this.ready && this.player.playVideo) this.player.playVideo(); }
  pauseVideo() { if (this.ready && this.player.pauseVideo) this.player.pauseVideo(); }

  /** Toggles play/pause, resuming the current track when paused. */
  toggle() {
    if (!this.ready) return;
    if (this.playing) this.pauseVideo();
    else this.playVideo();
  }

  /** @param {number} seconds */
  seekTo(seconds) {
    if (!this.ready || typeof this.player.seekTo !== 'function') return;
    const target = Math.max(0, Math.min(seconds, this._duration || seconds));
    this.player.seekTo(target, true);
    this.onTime(target, this._duration);
  }

  /** @param {number} v 0-100 */
  setVolume(v) {
    this.volume = this._clampVolume(v);
    if (this.ready && this.player.setVolume) this.player.setVolume(this.volume);
    return this.volume;
  }

  getVolume() { return this.volume; }

  setMuted(flag) {
    this.muted = Boolean(flag);
    if (!this.ready) return this.muted;
    if (this.muted && this.player.mute) this.player.mute();
    if (!this.muted && this.player.unMute) this.player.unMute();
    return this.muted;
  }

  getCurrentTime() {
    if (!this.ready || typeof this.player.getCurrentTime !== 'function') return 0;
    const t = this.player.getCurrentTime();
    return Number.isFinite(t) ? t : 0;
  }

  getDuration() {
    if (!this.ready || typeof this.player.getDuration !== 'function') return 0;
    const d = this.player.getDuration();
    return Number.isFinite(d) ? d : 0;
  }

  /** Freeze bar updates while the user drags the scrubber. */
  beginScrub() { this._dragging = true; }
  endScrub() { this._dragging = false; }

  /**
   * Re-syncs internal state after the tab was backgrounded, where browsers
   * throttle timers (the UI ticker effectively stops). Playback itself is never
   * interrupted — this only refreshes our view of it.
   * @returns {boolean} whether the player is currently playing
   */
  resync() {
    if (!this.ready) return false;
    this._syncDuration();
    if (this.player && typeof this.player.getPlayerState === 'function') {
      this.playing = this.player.getPlayerState() === PLAYER_STATE.PLAYING;
    }
    if (this.playing) this._startTicker();
    else this._stopTicker();
    return this.playing;
  }

  destroy() {
    this._stopTicker();
    try { if (this.player && this.player.destroy) this.player.destroy(); } catch (_) {}
    this.player = null;
    this.ready = false;
    this.playing = false;
    this._videoId = null;
  }
}

export default YouTubeAudioPlayer;
