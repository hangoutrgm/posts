// ============================================================
// voice-recorder.js — standalone voice message recorder for the
// main site (posts). Mirrors the Hangout Chat voice-recorder
// behavior, backed by getUserMedia + MediaRecorder.
//
//   - Secure context (https / localhost) required for the mic.
//   - 5-minute cap per recording (auto-stops).
//   - If the mic API isn't available (http:// access, old webviews),
//     it falls back to the native audio recorder / file picker.
//
// The host page wires it up with element IDs + hooks:
//   window.VoiceRecorder.init({ barId, timerId, onStop, onCancel })
//   window.VoiceRecorder.start()
//   window.VoiceRecorder.stop()
//   window.VoiceRecorder.cancel()
//   window.VoiceRecorder.isRecording()
// ============================================================

let cfg = {
    barId: null,      // recorder bar element id (shown while recording)
    timerId: null,    // timer span element id (mm:ss)
    maxSeconds: 300,  // auto-stop after this many seconds
    onStop: null,     // async (audioBlob, durationMs) => {}
    onCancel: null    // () => {} (too-short / canceled / empty stop)
};

let mediaRecorder = null;
let recStream = null;
let audioChunks = [];
let recStartTime = 0;
let recSeconds = 0;
let recTimerInterval = null;
let fileInput = null;

const $ = (id) => document.getElementById(id);

// ── Capture quality ──────────────────────────────────────────────
// `getUserMedia({ audio: true })` switches on every WebRTC speech
// enhancement the browser has (echo cancellation, noise suppression,
// auto gain). They are tuned for realtime calls, not for recordings,
// and they audibly colour the result: muffled / "underwater" sibilants,
// a pumping noise floor between phrases and a weak low end. Ask for a
// clean 48 kHz mono capture instead and pin the Opus bitrate so every
// browser produces the same, much cleaner result.
const AUDIO_CONSTRAINTS = {
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: true // keeps the level consistent between devices
};

// Opus first (best speech quality per byte), AAC/mp4 for Safari.
const MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
];

function pickMimeType() {
    for (const type of MIME_CANDIDATES) {
        try { if (MediaRecorder.isTypeSupported?.(type)) return type; } catch (_) { /* ignore */ }
    }
    return '';
}

// Opens the mic with the quality profile above, silently retrying with
// the browser defaults if the device refuses the requested profile.
async function openVoiceStream() {
    if (navigator.mediaDevices?.getUserMedia) {
        try {
            return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        } catch (err) {
            if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
            return navigator.mediaDevices.getUserMedia({ audio: true });
        }
    }
    const legacy = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia).bind(navigator);
    return new Promise((resolve, reject) => legacy({ audio: AUDIO_CONSTRAINTS }, resolve, reject));
}

// 128 kbps Opus (the bitrate Chrome uses by default) with the best
// container the browser supports.
function createRecorder(stream) {
    const mimeType = pickMimeType();
    const options = { audioBitsPerSecond: 128000 };
    if (mimeType) options.mimeType = mimeType;
    try {
        return new MediaRecorder(stream, options);
    } catch (_) {
        return new MediaRecorder(stream); // very old builds reject unknown option keys
    }
}

function resetUi() {
    if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
    const bar = $(cfg.barId);
    if (bar) bar.classList.add('hidden');
    const timer = $(cfg.timerId);
    if (timer) timer.textContent = '00:00';
}

function stopAllTracks() {
    if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
}

function ensureFileFallback() {
    if (fileInput) return fileInput;
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (file && cfg.onStop) await cfg.onStop(file, 0);
    });
    document.body.appendChild(fileInput);
    return fileInput;
}

function hasMicSupport() {
    const hasGetUserMedia = Boolean(
        navigator.mediaDevices?.getUserMedia ||
        navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia
    );
    return hasGetUserMedia && typeof window.MediaRecorder !== 'undefined';
}

export function init(options = {}) {
    cfg = { ...cfg, ...options };
}

export function isRecording() {
    return Boolean(mediaRecorder && mediaRecorder.state !== 'inactive');
}

export function startVoiceRecording() {
    if (isRecording()) return; // already recording — ignore

    // Fallback: no mic support (http:// access / unsupported webviews)
    if (!hasMicSupport()) {
        ensureFileFallback().click();
        return;
    }

    openVoiceStream()
        .then(beginRecording)
        .catch(() => ensureFileFallback().click());
}

function beginRecording(stream) {
    recStream = stream;
    audioChunks = [];

    const recorder = createRecorder(stream);
    mediaRecorder = recorder;

    recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    recorder.onstop = async () => {
        const durationMs = Date.now() - recStartTime;
        const mimeType = recorder.mimeType || 'audio/webm';
        mediaRecorder = null; // allow the next recording to start
        stopAllTracks();
        resetUi();

        if (audioChunks.length === 0 || durationMs < 600) {
            audioChunks = [];
            if (cfg.onCancel) cfg.onCancel();
            return;
        }

        const blob = new Blob(audioChunks, { type: mimeType });
        audioChunks = [];
        if (cfg.onStop) await cfg.onStop(blob, durationMs);
    };

    recorder.start(200);
    recSeconds = 0;
    recStartTime = Date.now();

    const bar = $(cfg.barId);
    if (bar) bar.classList.remove('hidden');
    const timerEl = $(cfg.timerId);
    if (timerEl) timerEl.textContent = '00:00';

    recTimerInterval = setInterval(() => {
        recSeconds++;
        const mins = String(Math.floor(recSeconds / 60)).padStart(2, '0');
        const secs = String(recSeconds % 60).padStart(2, '0');
        const t = $(cfg.timerId);
        if (t) t.textContent = `${mins}:${secs}`;
        if (recSeconds >= cfg.maxSeconds) stopVoiceRecording();
    }, 1000);
}

export function stopVoiceRecording() {
    if (isRecording()) {
        mediaRecorder.stop(); // onstop handles the rest
    } else {
        resetUi();
    }
}

export function cancelVoiceRecording() {
    audioChunks = [];
    if (isRecording()) {
        mediaRecorder.stop(); // onstop sees empty chunks -> resets UI + onCancel
    } else {
        stopAllTracks();
        resetUi();
        if (cfg.onCancel) cfg.onCancel();
    }
}

// Expose to window for inline onclick handlers across the main site.
window.VoiceRecorder = {
    init,
    start: startVoiceRecording,
    stop: stopVoiceRecording,
    cancel: cancelVoiceRecording,
    isRecording
};