// src/client/MicButton.jsx
// 🎤 composer button (slot: conversation.input.left, session scope).
// Click (or hold the PTT hotkey) to record; while the user is still speaking,
// INCREMENTAL STT windows stream the transcript into the composer; on stop a
// final full-recording transcription resolves it into one clean final text.
// The transcript is appended to the composer draft — NOT auto-sent unless
// autoSendTranscript is on.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { decodeBlobToAudioBuffer, encodeWav16kMono, encodeWav16kMonoFromBuffer, pickMimeType } from './encode-wav.js';
import { reconcileWindow, finalizeTranscript } from '../shared/stt-reconcile.js';
import { evaluateAutoSendTick } from '../shared/auto-send.js';
import { microphoneButtonState, canStartRecording } from './composer-microphone.js';
import { Tooltip } from './Tooltip.jsx';
import { AnimatedIcon } from './AnimatedIcon.jsx';
import { ensureOsoundStyles } from './styles.js';

const btnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  outline: 'none',
  boxShadow: 'none',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  padding: '2px 5px',
  lineHeight: 1,
};

// Silence auto-stop tuning (click mode only; PTT stops on key release).
const SILENCE_MS = 2500; // stop after this much continuous quiet
const SILENCE_THRESHOLD = 0.01; // RMS below this counts as quiet
const LEVEL_CHECK_MS = 100; // level poll cadence

// Incremental STT window tuning.
const STT_TIMESLICE_MS = 500;
const STT_WINDOW_SEC = 1.5;
const STT_STRIDE_SEC = 0.5;
const STT_MIN_SLICE_SEC = 0.3;

let beepCtx = null;

/** Short state cue: ding (880 Hz) on start, dong (523 Hz) on stop. */
function beep(freq) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!beepCtx || beepCtx.state === 'closed') beepCtx = new AC();
    if (beepCtx.state === 'suspended') beepCtx.resume().catch(() => {});
    const ctx = beepCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.04;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    /* audio cues are non-fatal */
  }
}

export function MicButton(props) {
  const { useInput, inputActions } = props;
  const [voiceState, setVoiceState] = useState('idle');
  const [config, setConfig] = useState(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const monitorRef = useRef(null); // { ctx, source, timer } silence detector
  const stopRecordingRef = useRef(null);
  // Incremental STT state (plain refs — updated from async callbacks).
  const windowRef = useRef({ inFlight: false, lastWindowEndSec: 0, count: 0, partial: '' });
  const stoppingRef = useRef(false); // true once stop has begun: no more partial draft updates
  const baseDraftRef = useRef(''); // composer draft captured at recording start
  const mimeRef = useRef('audio/webm');
  const voiceStateRef = useRef(voiceState);
  voiceStateRef.current = voiceState;
  const configRef = useRef(config);
  configRef.current = config;
  const inputRef = useRef(null);
  const actionsRef = useRef(null);
  const sendPlanRef = useRef(null); // { seq, draft, rev, startedAt, delayMs, timer, cleanupListeners }
  const planSeq = useRef(0);
  const flashTimerRef = useRef(null);
  const [sendingLeft, setSendingLeft] = useState(null);
  const [cancelledFlash, setCancelledFlash] = useState(false);

  inputRef.current = useInput ? useInput((s) => s) : null;
  actionsRef.current = inputActions;

  useEffect(() => {
    api.getJson('/config').then((j) => setConfig(j.config)).catch(() => setConfig(null));
  }, []);

  /** Debug-gated STT log (config.debugLogging). Errors always log. */
  const sttLog = useCallback((message) => {
    if (configRef.current?.debugLogging) console.log('[O-Sound][STT]', message);
  }, []);

  /** Cancels the active auto-send plan (per-message: only this plan, never a later one). */
  const cancelAutoSend = useCallback((reason, { silent = false } = {}) => {
    const plan = sendPlanRef.current;
    if (!plan) return;
    sendPlanRef.current = null;
    clearTimeout(plan.timer);
    plan.cleanupListeners?.();
    setSendingLeft(null);
    if (!silent) {
      setCancelledFlash(true);
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setCancelledFlash(false), 1600);
    }
    sttLog(`auto-send cancelled: ${reason}`);
  }, [sttLog]);

  /**
   * Starts the auto-send review countdown for the draft just written by a final
   * transcription (2026-09-26, fixed in v0.5.1):
   * Uses `allowCursorRevSync: true` + explicit user-interaction listeners so an
   * active cursor inside the composer when Whisper calls `setDraft(draft)` never
   * false-cancels the countdown, while any genuine user key press, click/selection
   * in the composer, paste/cut, or text edit cancels it immediately.
   * @param {string} draftText - the exact draft this transcription wrote.
   */
  const startAutoSend = useCallback((draftText) => {
    const cfg = configRef.current;
    const delaySec = Math.max(0, Number(cfg?.autoSendDelaySec ?? 4));
    cancelAutoSend('superseded by a new transcription', { silent: true });
    if (delaySec <= 0) {
      setTimeout(() => actionsRef.current?.submit(), 150);
      return;
    }
    const now = Date.now();
    const input = inputRef.current;
    const plan = {
      seq: (planSeq.current += 1),
      draft: draftText,
      rev: input?.draftRev ?? 0,
      startedAt: now,
      delayMs: delaySec * 1000,
      allowCursorRevSync: true,
      userInteracted: false,
      settleUntilMs: now + 600,
      timer: null,
      cleanupListeners: null,
    };

    if (typeof window !== 'undefined') {
      const onUserKeyDown = (e) => {
        // Ignore pure modifier keys unless combined or Escape.
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        plan.userInteracted = true;
        cancelAutoSend('user pressed a key during auto-send review');
      };
      const onUserPointerDown = (e) => {
        const target = e.target;
        if (target && typeof target.closest === 'function') {
          if (target.closest('textarea, input, [contenteditable="true"], [role="textbox"]')) {
            plan.userInteracted = true;
            cancelAutoSend('user clicked inside the composer');
          }
        }
      };
      const onUserEdit = () => {
        plan.userInteracted = true;
        cancelAutoSend('user edited the composer');
      };
      window.addEventListener('keydown', onUserKeyDown, true);
      window.addEventListener('pointerdown', onUserPointerDown, true);
      window.addEventListener('paste', onUserEdit, true);
      window.addEventListener('cut', onUserEdit, true);
      plan.cleanupListeners = () => {
        window.removeEventListener('keydown', onUserKeyDown, true);
        window.removeEventListener('pointerdown', onUserPointerDown, true);
        window.removeEventListener('paste', onUserEdit, true);
        window.removeEventListener('cut', onUserEdit, true);
      };
    }

    sendPlanRef.current = plan;
    setSendingLeft(delaySec);
    sttLog(`auto-send countdown started (${delaySec}s) for "${draftText.slice(0, 60)}"`);
    const tick = () => {
      const current = sendPlanRef.current;
      if (!current || current.seq !== plan.seq) return;
      const verdict = evaluateAutoSendTick({ plan, input: inputRef.current, nowMs: Date.now() });
      if (verdict.action === 'cancel') {
        cancelAutoSend('user interacted with the transcribed message');
        return;
      }
      if (verdict.action === 'send') {
        plan.cleanupListeners?.();
        sendPlanRef.current = null;
        setSendingLeft(null);
        sttLog('auto-send: sending now (no interaction)');
        actionsRef.current?.submit();
        return;
      }
      setSendingLeft(verdict.leftSec);
      plan.timer = setTimeout(tick, 200);
    };
    plan.timer = setTimeout(tick, 200);
  }, [cancelAutoSend, sttLog]);

  const stopMonitor = useCallback(() => {
    const mon = monitorRef.current;
    if (!mon) return;
    monitorRef.current = null;
    clearInterval(mon.timer);
    try {
      mon.source.disconnect();
    } catch {
      /* already disconnected */
    }
    try {
      mon.ctx.close().catch(() => {});
    } catch {
      /* already closed */
    }
  }, []);

  /** Writes the composer draft = base draft (captured at start) + current partial. */
  const updateDraft = useCallback(() => {
    const base = baseDraftRef.current;
    const partial = windowRef.current.partial;
    const text = base ? `${base} ${partial}`.trim() : partial;
    actionsRef.current?.setDraft(text);
  }, []);

  /**
   * The incremental window engine (one in flight at a time).
   */
  const maybeRunWindow = useCallback(async () => {
    const ws = windowRef.current;
    if (stoppingRef.current || ws.inFlight) return;
    const parts = chunksRef.current;
    if (parts.length === 0) return;
    const blob = new Blob(parts, { type: mimeRef.current });
    if (blob.size < 8000) return;
    let decoded;
    try {
      decoded = await decodeBlobToAudioBuffer(blob);
    } catch (err) {
      sttLog(`window decode failed: ${err?.message ?? err}`);
      return;
    }
    const dur = decoded.duration;
    if (dur - ws.lastWindowEndSec < STT_STRIDE_SEC) return;
    const startSec = Math.max(0, dur - STT_WINDOW_SEC);
    if (dur - startSec < STT_MIN_SLICE_SEC) return;
    ws.inFlight = true;
    ws.count += 1;
    const n = ws.count;
    const t0 = Date.now();
    sttLog(`window #${n} [${startSec.toFixed(1)}–${dur.toFixed(1)}s] request start`);
    try {
      const cfg = configRef.current;
      const query = new URLSearchParams();
      if (cfg) {
        if (cfg.whisperLanguage && cfg.whisperLanguage !== 'auto') query.set('language', cfg.whisperLanguage);
        if (cfg.whisperTask) query.set('task', cfg.whisperTask);
        if (cfg.sttWindowModel) query.set('model', cfg.sttWindowModel);
      }
      const wav = await encodeWav16kMonoFromBuffer(decoded, startSec, dur);
      const res = await api.postRaw('/stt', wav, query.toString());
      const raw = res?.text ?? '';
      ws.lastWindowEndSec = dur;
      if (!stoppingRef.current) {
        const before = ws.partial;
        ws.partial = reconcileWindow(before, raw);
        updateDraft();
        sttLog(
          `window #${n} response in ${Date.now() - t0}ms: "${raw}" → partial "${ws.partial}" ` +
            `(was ${before.length} chars, now ${ws.partial.length} chars)`,
        );
      } else {
        sttLog(`window #${n} response in ${Date.now() - t0}ms (stop already in progress — ignored)`);
      }
    } catch (err) {
      console.warn('[O-Sound][STT] window failed:', err);
      sttLog(`window #${n} failed: ${err?.message ?? err}`);
    } finally {
      ws.inFlight = false;
    }
  }, [sttLog, updateDraft]);

  const stopRecording = useCallback(async () => {
    stopMonitor();
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    stoppingRef.current = true;
    setVoiceState('processing');
    beep(523);
    try {
      const blob = await new Promise((resolve) => {
        rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }));
        rec.stop();
      });
      rec.stream.getTracks().forEach((t) => t.stop());
      const ws = windowRef.current;
      if (blob.size === 0) {
        if (ws.partial) {
          updateDraft();
          setVoiceState('success');
        } else {
          setVoiceState('error');
        }
        return;
      }
      let finalText = '';
      try {
        const wav = await encodeWav16kMono(blob);
        const cfg = configRef.current;
        const query = new URLSearchParams();
        if (cfg) {
          if (cfg.whisperLanguage && cfg.whisperLanguage !== 'auto') query.set('language', cfg.whisperLanguage);
          if (cfg.whisperTask) query.set('task', cfg.whisperTask);
        }
        const res = await api.postRaw('/stt', wav, query.toString());
        console.log('[O-Sound] /stt final response:', res);
        finalText = res.text ?? '';
      } catch (err) {
        console.warn('[O-Sound][STT] final pass failed, using incremental partial:', err);
      }
      const text = finalizeTranscript(ws.partial, finalText);
      if (!text) {
        setVoiceState('error');
        return;
      }
      const base = baseDraftRef.current;
      const draft = base ? `${base} ${text}`.trim() : text;
      actionsRef.current?.setDraft(draft);
      sttLog(`final: "${text}" (windows: ${ws.count}, partial was ${ws.partial.length} chars)`);
      setVoiceState('success');
      const cfg = configRef.current;
      if (cfg?.autoSendTranscript) {
        startAutoSend(draft);
      }
    } catch (err) {
      console.error('[O-Sound] STT failed:', err);
      setVoiceState('error');
    }
  }, [stopMonitor, sttLog, updateDraft, startAutoSend]);
  stopRecordingRef.current = stopRecording;

  // Click-mode silence watchdog: auto-stops after SILENCE_MS of quiet.
  const startSilenceMonitor = useCallback(
    (stream) => {
      if (configRef.current?.inputMode === 'push-to-talk') return;
      stopMonitor();
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        let lastLoud = Date.now();
        const timer = setInterval(() => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          if (rms >= SILENCE_THRESHOLD) {
            lastLoud = Date.now();
          } else if (Date.now() - lastLoud >= SILENCE_MS) {
            monitorRef.current = null;
            clearInterval(timer);
            try {
              source.disconnect();
            } catch {
              /* noop */
            }
            try {
              ctx.close().catch(() => {});
            } catch {
              /* noop */
            }
            void stopRecordingRef.current();
          }
        }, LEVEL_CHECK_MS);
        monitorRef.current = { ctx, source, timer };
      } catch {
        /* monitor is optional — manual stop still works */
      }
    },
    [stopMonitor],
  );

  const startRecording = useCallback(async () => {
    if (!canStartRecording(voiceStateRef.current)) return;
    cancelAutoSend('a new recording started', { silent: true });
    // Refresh config best-effort so recent settings changes (autoSendTranscript, filter, etc.) apply immediately.
    api.getJson('/config').then((j) => { if (j?.config) setConfig(j.config); }).catch(() => {});
    const cfg = configRef.current;
    let stream = null;
    try {
      if (cfg?.stopSpeechOnRecording !== false) {
        await api.postJson('/tts/control', { action: 'stopAll' }).catch(() => {});
      }
      const constraints = { audio: { channelCount: 1 } };
      if (cfg && cfg.microphoneDevice && cfg.microphoneDevice !== 'default') {
        constraints.audio.deviceId = cfg.microphoneDevice;
      }
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      const mime = pickMimeType();
      mimeRef.current = mime || 'audio/webm';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      windowRef.current = { inFlight: false, lastWindowEndSec: 0, count: 0, partial: '' };
      stoppingRef.current = false;
      baseDraftRef.current = (inputRef.current?.draft ?? '').trim();
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
          void maybeRunWindow();
        }
      };
      rec.start(STT_TIMESLICE_MS);
      recorderRef.current = rec;
      setVoiceState('recording');
      beep(880);
      startSilenceMonitor(stream);
    } catch (err) {
      console.error('[O-Sound] mic start failed:', err);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setVoiceState('error');
    }
  }, [startSilenceMonitor, maybeRunWindow, cancelAutoSend]);

  // Push-to-talk: hold the configured hotkey to record, release to stop.
  useEffect(() => {
    if (config?.inputMode !== 'push-to-talk') return;
    const key = (config.pushToTalkKey || 'Ctrl+Space').toLowerCase();
    const wantCtrl = key.includes('ctrl');
    const wantShift = key.includes('shift');
    const wantAlt = key.includes('alt');
    const wantMeta = key.includes('meta');
    const base = key.replace(/(ctrl|shift|alt|meta)\+/, '');
    const onKeyDown = (e) => {
      if (e.repeat) return;
      const matches =
        e.ctrlKey === wantCtrl && e.shiftKey === wantShift && e.altKey === wantAlt && e.metaKey === wantMeta;
      if (!matches) return;
      const k = (e.key || '').toLowerCase();
      if (base === 'space' ? k === ' ' : k === base) {
        e.preventDefault();
        void startRecording();
      }
    };
    const onKeyUp = (e) => {
      const k = (e.key || '').toLowerCase();
      const isKey = base === 'space' ? k === ' ' : k === base;
      if (isKey && voiceStateRef.current === 'recording') {
        void stopRecording();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [config?.inputMode, config?.pushToTalkKey, startRecording, stopRecording]);

  useEffect(
    () => () => {
      stoppingRef.current = true;
      stopMonitor();
      const rec = recorderRef.current;
      if (rec) {
        rec.onstop = null;
        rec.stop();
        rec.stream.getTracks().forEach((t) => t.stop());
        recorderRef.current = null;
      }
      const plan = sendPlanRef.current;
      if (plan) {
        clearTimeout(plan.timer);
        plan.cleanupListeners?.();
        sendPlanRef.current = null;
      }
      clearTimeout(flashTimerRef.current);
    },
    [stopMonitor],
  );

  const view = microphoneButtonState(voiceState, config?.inputMode ?? 'click');
  const busy = voiceState === 'recording' || voiceState === 'processing';
  const counting = sendingLeft !== null && !busy;
  const title = counting
    ? `O-Sound: sending in ${sendingLeft}s — click to cancel auto-send`
    : cancelledFlash && !busy
      ? 'O-Sound: auto-send cancelled'
      : busy
        ? voiceState === 'recording'
          ? 'O-Sound: recording… speak now, click to stop'
          : 'O-Sound: transcribing your speech…'
        : voiceState === 'error'
          ? 'O-Sound: voice input error or no speech detected — click to retry'
          : 'O-Sound: click to dictate — speak and I\'ll type it (Whisper)';
  const iconName = busy
    ? voiceState === 'recording' ? 'micRecording' : 'processing'
    : counting ? 'processing' : cancelledFlash ? 'cancelled' : view.iconName || 'mic';
  const iconLive = busy || counting || cancelledFlash;
  ensureOsoundStyles();
  return (
    <Tooltip label={title} side="right">
      <button
        type="button"
        className="osound-mic-btn"
        aria-label={title}
        disabled={view.disabled && !counting}
        style={{ ...btnStyle, opacity: view.disabled && !counting ? 0.5 : 1 }}
        onClick={() => {
          if (sendPlanRef.current) {
            cancelAutoSend('user clicked the mic button');
            return;
          }
          if (voiceState === 'recording') void stopRecording();
          else void startRecording();
        }}
      >
        <AnimatedIcon name={iconName} size={18} live={iconLive} />
      </button>
    </Tooltip>
  );
}
