// src/client/SettingsCard.jsx
// Settings → Voice card (slot: settings.section). Renders every field of
// OSoundConfigSchema plus runtime/model/voice management, live diagnostics,
// capped concurrent download queue status, smart filter word-to-JSON editor,
// Switch.svg toggles, and the voice queue panel.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { WHISPER_LANGUAGES } from '../stt/languages.js';
import { DEFAULT_TTS_FILTER } from '../tts/tts-filter.js';
import { DEFAULT_STT_FILTER, addWordsToFilterRules } from '../stt/stt-filter.js';
import { AnimatedIcon } from './AnimatedIcon.jsx';
import { ensureOsoundStyles } from './styles.js';

const box = {
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};
const h3 = {
  margin: '0 0 8px',
  fontSize: 13,
  fontWeight: 600,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};
const row = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12, flexWrap: 'wrap' };
const label = { minWidth: 150, color: 'var(--dsw-alias-label-secondary, inherit)', opacity: 0.85, display: 'inline-flex', alignItems: 'center', gap: 5 };
const input = {
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
  borderRadius: 4,
  color: 'inherit',
  colorScheme: 'light dark',
  padding: '2px 6px',
  fontSize: 12,
};
const btn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
  borderRadius: 4,
  color: 'inherit',
  cursor: 'pointer',
  fontSize: 12,
  padding: '3px 8px',
  lineHeight: 1.2,
};
const ok = { color: 'var(--dsw-alias-state-success-primary, #4caf7d)' };
const warn = { color: 'var(--dsw-alias-state-warning-primary, #e0a13d)' };
const err = { color: 'var(--dsw-alias-state-error-primary, #e06c5a)' };

const DIAGNOSTIC_ROWS = [
  ['platform', 'Platform (Windows)'],
  ['whisperRuntime', 'Whisper runtime'],
  ['whisperModel', 'Whisper model'],
  ['piperRuntime', 'Piper runtime'],
  ['piperVoice', 'Piper voice'],
  ['microphone', 'Microphone'],
  ['audioOutput', 'Audio output'],
  ['catalogue', 'Piper voice catalogue'],
];

const QUICK_STT_PRESETS = [
  'music',
  'noise',
  'applause',
  'laughter',
  'silence',
  'blank_audio',
  'cough',
  'sigh',
  'inaudible',
];

function probeMic() {
  return navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((s) => {
      s.getTracks().forEach((t) => t.stop());
      return true;
    })
    .catch(() => false);
}

function probeOut() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  return Promise.resolve(ac.close()).then(() => true, () => false);
}

// Hover tooltip: dynamically chooses left/right side based on available viewport width.
function Tip({ label: tipText, children, side }) {
  const [show, setShow] = useState(false);
  const [resolved, setResolved] = useState('left');
  const ref = useRef(null);
  if (!tipText) return children;
  const enter = () => {
    if (side) {
      setResolved(side);
    } else {
      const r = ref.current ? ref.current.getBoundingClientRect() : null;
      setResolved(r && r.left < window.innerWidth - r.right ? 'right' : 'left');
    }
    setShow(true);
  };
  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={enter}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show ? (
        <span
          style={{
            position: 'absolute',
            ...(resolved === 'right' ? { left: 'calc(100% + 8px)' } : { right: 'calc(100% + 8px)' }),
            top: '50%',
            transform: 'translateY(-50%)',
            whiteSpace: 'nowrap',
            background: 'var(--dsw-alias-bg-layer-1, rgba(24,24,24,0.96))',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
            borderRadius: 4,
            padding: '3px 8px',
            fontSize: 11,
            lineHeight: 1.3,
            color: 'var(--dsw-alias-label-primary, #eee)',
            zIndex: 60,
            pointerEvents: 'none',
            boxShadow: '0 2px 10px rgba(0,0,0,0.45)',
          }}
        >
          {tipText}
        </span>
      ) : null}
    </span>
  );
}

// Switch.svg toggle component replacing native tick-box checkboxes in Settings UI.
function SwitchToggle({ checked, onChange, children, disabled = false }) {
  ensureOsoundStyles();
  const isOn = Boolean(checked);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      disabled={disabled}
      className="osound-switch-btn"
      onClick={() => {
        if (!disabled) onChange(!isOn);
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="osound-switch-svg"
        aria-hidden="true"
      >
        <rect className="osound-sw-border" x="1.5" y="6" width="21" height="12" rx="6" stroke="currentColor" strokeWidth="1.7" />
        <rect className="osound-sw-track" x="1.5" y="6" width="21" height="12" rx="6" />
        <circle className="osound-sw-knob" cx="7.5" cy="12" r="3.6" fill="currentColor" />
      </svg>
      {children ? <span>{children}</span> : null}
    </button>
  );
}

// Dark-themed dropdown with AnimatedIcon carets and selection checkmarks.
function DarkSelect({ value, onChange, options, placeholder = 'Select…', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const selected = options.find((o) => o.value === value);
  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 120 }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={selected ? selected.label : placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '3px 8px',
          background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16))',
          color: 'var(--dsw-alias-label-primary, #e6e6f0)',
          borderRadius: 4,
          border: `1px solid ${open ? 'var(--dsw-alias-border-l1, rgba(128,128,128,0.55))' : 'var(--dsw-alias-border-l2, rgba(128,128,128,0.35))'}`,
          fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
        </span>
        <AnimatedIcon name={open ? 'caretUp' : 'caretDown'} size={12} style={{ opacity: 0.75 }} />
      </button>
      {open ? (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 3px)',
            left: 0,
            right: 0,
            maxHeight: 240,
            overflowY: 'auto',
            background: 'var(--dsw-alias-bg-layer-1, #171922)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 80,
            padding: 3,
          }}
        >
          {options.map((o) => {
            const isSel = o.value === value;
            const isHov = hover === o.value;
            return (
              <div
                key={o.value}
                role="option"
                aria-selected={isSel}
                onClick={() => {
                  if (o.disabled) return;
                  onChange(o.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHover(o.value)}
                onMouseLeave={() => setHover((h) => (h === o.value ? null : h))}
                style={{
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-primary, #e6e6f0)',
                  background: isHov ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.22))' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  cursor: o.disabled ? 'default' : 'pointer',
                  opacity: o.disabled ? 0.45 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
                {isSel ? <AnimatedIcon name="checkOk" size={12} style={ok} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Readable short badge label for a filter rule in the chip list. */
function summarizeRule(rule, idx) {
  if (!rule || typeof rule !== 'object') return `Rule #${idx + 1}`;
  const v = String(rule.value ?? '');
  if (rule.kind === 'literal') return `"${v}"`;
  // Detect single-word auto-tag rule created by wordToSttTagRule
  const m = v.match(/^\(\?:\\\(\|\\\[|\\\{\|\\\*\|（\|【\)\\s\*(.+?)\\s\*\(\?:\\\)\|l?\\\]|\\\}\|\\\*\|）\|】\)$/);
  if (m) {
    const word = m[1].replace(/\\s\+/g, ' ').replace(/\\(.)/g, '$1');
    return `(${word}) / [${word}]`;
  }
  if (v.includes('blank_audio') && v.startsWith('\\(')) return '(common tags…)';
  if (v.includes('blank_audio') && v.startsWith('[\\[{]')) return '[common tags…]';
  if (v.includes('音楽')) return '（CJK/multilingual tags…）';
  if (v.includes('♪')) return '♪ musical notes';
  if (v.startsWith('\\*')) return '*action tags…*';
  if (v.includes('nospeech')) return '<|whisper tokens|>';
  if (v.includes('Amara')) return 'Subtitle watermarks';
  return v.length > 26 ? `/${v.slice(0, 24)}…/` : `/${v}/`;
}

// Upgraded FilterRulesEditor (v0.5.1):
//  * Quick-add input: type a word or comma-separated words (e.g. "music, noise" or "(music)")
//    and press Enter or click "+ Add" — it auto-builds the filter rule, appends it to the
//    JSON array, and immediately saves/applies it!
//  * Preset tag pills (for STT) & active rule chips (click × to remove).
//  * Synced JSON textarea for full power-user editing + Default / Apply buttons.
function FilterRulesEditor({ label: title, tip, rules, defaults, onApply, mode = 'tts' }) {
  const [text, setText] = useState(() => JSON.stringify(rules ?? [], null, 2));
  const [quickInput, setQuickInput] = useState('');
  const [quickMode, setQuickMode] = useState(mode === 'stt' ? 'tag' : 'literal');
  const [error, setError] = useState(null);

  useEffect(() => {
    setText(JSON.stringify(rules ?? [], null, 2));
    setError(null);
  }, [rules]);

  const currentRules = Array.isArray(rules) ? rules : [];

  const handleQuickAdd = (rawText = quickInput) => {
    const trimmed = String(rawText ?? '').trim();
    if (!trimmed) return;
    let baseRules = currentRules;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) baseRules = parsed;
    } catch {
      /* fall back to currentRules */
    }
    const nextRules = addWordsToFilterRules(baseRules, trimmed, quickMode, '');
    setText(JSON.stringify(nextRules, null, 2));
    setError(null);
    if (rawText === quickInput) setQuickInput('');
    onApply(nextRules);
  };

  const handleRemoveRule = (index) => {
    const nextRules = currentRules.filter((_, i) => i !== index);
    setText(JSON.stringify(nextRules, null, 2));
    setError(null);
    onApply(nextRules);
  };

  const apply = () => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(`Invalid JSON: ${e.message}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setError('Rules must be a JSON array of {kind: "literal"|"regex", value, replacement?}.');
      return;
    }
    setError(null);
    onApply(parsed);
  };

  return (
    <>
      <div style={row}>
        <Tip label={mode === 'stt' ? 'Type any word (e.g. music, noise, cough) — auto-adds (word), [word], *word* to the filter JSON and saves immediately' : 'Type characters or words to strip before Piper speaks and click + Add'}>
          <span style={label}>Quick add {mode === 'stt' ? 'tag / word' : 'filter'}</span>
        </Tip>
        <input
          style={{ ...input, flex: 1, minWidth: 160 }}
          placeholder={mode === 'stt' ? 'Type word(s), e.g. music, noise, applause, laughter…' : 'Type symbol or word, e.g. *, #, ~…'}
          value={quickInput}
          onChange={(e) => setQuickInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleQuickAdd();
            }
          }}
        />
        <div style={{ width: 145, flexShrink: 0 }}>
          <DarkSelect
            value={quickMode}
            onChange={setQuickMode}
            options={
              mode === 'stt'
                ? [
                    { value: 'tag', label: 'Tag (word) [word]' },
                    { value: 'literal', label: 'Exact literal' },
                    { value: 'regex', label: 'Regex pattern' },
                  ]
                : [
                    { value: 'literal', label: 'Exact literal' },
                    { value: 'tag', label: 'Tag (word) [word]' },
                    { value: 'regex', label: 'Regex pattern' },
                  ]
            }
          />
        </div>
        <Tip label="Add to filter JSON and apply immediately">
          <button type="button" style={btn} onClick={() => handleQuickAdd()}>
            <AnimatedIcon name="checkOk" size={13} /> + Add
          </button>
        </Tip>
      </div>

      {mode === 'stt' ? (
        <div style={{ ...row, gap: 4, marginBottom: 6 }}>
          <span style={{ ...label, minWidth: 150, fontSize: 11, opacity: 0.7 }}>Quick tags</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
            {QUICK_STT_PRESETS.map((word) => (
              <Tip key={word} label={`Auto-add (${word}), [${word}], *${word}* to filter`}>
                <button
                  type="button"
                  style={{ ...btn, padding: '1px 6px', fontSize: 11, opacity: 0.85 }}
                  onClick={() => handleQuickAdd(word)}
                >
                  + ({word})
                </button>
              </Tip>
            ))}
          </div>
        </div>
      ) : null}

      {currentRules.length > 0 ? (
        <div style={{ ...row, gap: 4, marginBottom: 6 }}>
          <span style={{ ...label, minWidth: 150, fontSize: 11, opacity: 0.7 }}>Active rules ({currentRules.length})</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1 }}>
            {currentRules.map((r, idx) => (
              <span
                key={`${idx}-${r.value}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 11,
                  background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.16))',
                  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
                }}
                title={`${r.kind}: ${r.value}`}
              >
                <span>{summarizeRule(r, idx)}</span>
                <button
                  type="button"
                  aria-label="Remove rule"
                  onClick={() => handleRemoveRule(idx)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 11,
                    opacity: 0.7,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div style={row}>
        <Tip label={tip}>
          <span style={label}>{title}</span>
        </Tip>
        <textarea
          style={{ ...input, flex: 1, minWidth: 260, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div style={row}>
        {error ? <span style={{ ...err, fontSize: 11 }}>{error}</span> : null}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <Tip label="Restore the built-in default rules for this filter">
            <button
              type="button"
              style={btn}
              onClick={() => {
                setText(JSON.stringify(defaults, null, 2));
                setError(null);
                onApply(defaults);
              }}
            >
              <AnimatedIcon name="resetDefault" size={13} /> Default
            </button>
          </Tip>
          <Tip label="Apply these rules (invalid or dangerous regex rules are disabled automatically, with a report)">
            <button type="button" style={btn} onClick={apply}>
              <AnimatedIcon name="checkOk" size={13} /> Apply rules
            </button>
          </Tip>
        </span>
      </div>
    </>
  );
}

export function SettingsCard() {
  ensureOsoundStyles();
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [diag, setDiag] = useState(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [models, setModels] = useState(null);
  const [piper, setPiper] = useState(null);
  const [search, setSearch] = useState('');
  const [needsFallback, setNeedsFallback] = useState(false);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  // Tracks client-initiated downloads (`whisper-model:<id>`, `piper-voice:<key>`, `runtime:<kind>`)
  // alongside server status polling (`status.downloads.items`), so multiple downloads can run
  // concurrently (capped by the host DownloadQueue) with live downloading/queued indicators.
  const [localDownloads, setLocalDownloads] = useState({});
  const prevVolumeRef = useRef(1.0);

  const flash = useCallback((msg, isErr = false) => {
    setNotice({ msg, isErr });
    setTimeout(() => setNotice(null), 6000);
  }, []);

  const load = useCallback(() => {
    api.getJson('/config').then((j) => setConfig(j.config)).catch(() => {});
    api.getJson('/status').then(setStatus).catch(() => {});
    api.getJson('/models/whisper').then(setModels).catch(() => {});
    api.getJson('/models/piper').then(setPiper).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const anyDownloadActive =
    Object.keys(localDownloads).length > 0 ||
    (status?.downloads?.activeCount ?? 0) > 0 ||
    (status?.downloads?.queuedCount ?? 0) > 0;

  // Poll status (faster 1s cadence while downloads are active/queued so progress and queue state update snappily).
  useEffect(() => {
    const intervalMs = anyDownloadActive ? 1000 : 2500;
    const t = setInterval(() => {
      api.getJson('/status').then(setStatus).catch(() => {});
      if (anyDownloadActive) {
        api.getJson('/models/whisper').then(setModels).catch(() => {});
        api.getJson('/models/piper').then(setPiper).catch(() => {});
      }
    }, intervalMs);
    return () => clearInterval(t);
  }, [anyDownloadActive]);

  const refreshDiag = useCallback(async () => {
    setDiagBusy(true);
    try {
      const [mic, out] = await Promise.all([probeMic(), probeOut()]);
      const j = await api.getJson(`/diagnostics?mic=${mic ? 1 : 0}&out=${out ? 1 : 0}`).catch(() => null);
      setDiag(j?.report ?? null);
    } finally {
      setDiagBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshDiag();
  }, [refreshDiag, status?.runtimes?.whisper, status?.runtimes?.piper, config?.whisperModel, config?.piperVoiceKey]);

  const patch = useCallback(
    async (p) => {
      try {
        const j = await api.postJson('/config', p);
        setConfig(j.config);
        if (j.errors?.length) flash(`Dropped invalid values: ${j.errors.join('; ')}`, true);
        load();
      } catch (e) {
        flash(e.message, true);
      }
    },
    [load, flash],
  );

  const run = useCallback(
    async (actionLabel, fn) => {
      setBusy(actionLabel);
      try {
        await fn();
      } catch (e) {
        flash(e.message, true);
      } finally {
        setBusy(null);
        load();
        void refreshDiag();
      }
    },
    [load, refreshDiag, flash],
  );

  // Starts a download without locking out other downloads: multiple items can be
  // clicked at once, and the host's DownloadQueue caps active concurrency and queues
  // the rest in FIFO order.
  const startDownload = useCallback(
    async (queueKey, fn) => {
      setLocalDownloads((prev) => ({ ...prev, [queueKey]: 'downloading' }));
      // Trigger a quick status refresh so active vs queued state appears immediately.
      setTimeout(() => {
        api.getJson('/status').then(setStatus).catch(() => {});
      }, 150);
      try {
        await fn();
      } catch (e) {
        if (!/cancelled/i.test(e.message ?? '')) {
          flash(e.message, true);
        }
      } finally {
        setLocalDownloads((prev) => {
          const next = { ...prev };
          delete next[queueKey];
          return next;
        });
        load();
        void refreshDiag();
      }
    },
    [load, refreshDiag, flash],
  );

  // Resolves the live state ('downloading' | 'queued' | null) and progress % for a queue key.
  const getDownloadInfo = (queueKey, fallbackState = null) => {
    const serverEntry = status?.downloads?.items?.[queueKey];
    if (serverEntry) {
      return { state: serverEntry.state, percent: serverEntry.percent ?? 0 };
    }
    if (fallbackState) {
      return { state: fallbackState, percent: 0 };
    }
    if (localDownloads[queueKey]) {
      // If the server already reports activeCount >= maxConcurrent and this item isn't in active, show queued
      const maxC = status?.downloads?.maxConcurrent ?? 2;
      const actC = status?.downloads?.activeCount ?? 0;
      return { state: actC >= maxC ? 'queued' : 'downloading', percent: 0 };
    }
    return { state: null, percent: 0 };
  };

  // --- Voice preview (▶) ---
  const [previewing, setPreviewing] = useState(null);
  const [previewPlaying, setPreviewPlaying] = useState(null);
  const previewRef = useRef({ audio: null, url: null, key: null });

  const stopPreview = useCallback(() => {
    const p = previewRef.current;
    if (p.audio) {
      p.audio.onended = null;
      p.audio.onerror = null;
      p.audio.onplaying = null;
      try { p.audio.pause(); } catch { /* already stopped */ }
    }
    if (p.url) URL.revokeObjectURL(p.url);
    previewRef.current = { audio: null, url: null, key: null };
    setPreviewing(null);
    setPreviewPlaying(null);
  }, []);

  const playPreview = useCallback(async (v) => {
    stopPreview();
    previewRef.current = { audio: null, url: null, key: v.key };
    setPreviewPlaying(null);
    setPreviewing(v.key);
    try {
      const buf = await api.postBytes('/models/piper/preview', { key: v.key });
      const blob = new Blob([buf], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewRef.current = { audio, url, key: v.key };
      const finish = (isErr) => {
        if (previewRef.current.audio === audio) stopPreview();
        if (isErr) flash('Could not play the preview audio.', true);
      };
      audio.onended = () => finish(false);
      audio.onerror = () => finish(true);
      audio.onplaying = () => {
        if (previewRef.current.audio === audio) {
          setPreviewing(null);
          setPreviewPlaying(v.key);
        }
      };
      await audio.play();
    } catch (e) {
      stopPreview();
      flash(`Preview failed: ${e.message}`, true);
    }
  }, [stopPreview, flash]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  if (!config) return <div style={box}>Loading O-Sound…</div>;

  const installedVoiceKeys = new Set((piper?.installed ?? []).filter((v) => v.installed).map((v) => v.key));
  const filteredVoices = (piper?.voices ?? []).filter((v) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return v.name.toLowerCase().includes(q) || v.locale.toLowerCase().includes(q) || v.language.toLowerCase().includes(q) || v.region.toLowerCase().includes(q);
  });
  const selectedVoice = (piper?.voices ?? []).find((v) => v.key === config.piperVoiceKey);
  const speakingJobs = (status?.ttsJobs ?? []).filter((j) => j.state === 'generating' || j.state === 'playing' || j.state === 'paused');
  const queuedJobs = (status?.ttsJobs ?? []).filter((j) => j.state === 'idle');

  const whisperRtDl = getDownloadInfo('runtime:whisper', status?.runtimes?.whisperDownloadState ?? null);
  const piperRtDl = getDownloadInfo('runtime:piper', status?.runtimes?.piperDownloadState ?? null);
  const activeDlCount = status?.downloads?.activeCount ?? 0;
  const queuedDlCount = status?.downloads?.queuedCount ?? 0;

  return (
    <div>
      <div style={row}>
        <strong style={{ fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <AnimatedIcon name="mic" size={16} /> {`O-Sound`} — local voice (Whisper STT + Piper TTS)
        </strong>
        {activeDlCount + queuedDlCount > 0 ? (
          <span style={{ fontSize: 11, ...ok, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AnimatedIcon name="download" size={13} live={true} style={ok} />
            {activeDlCount} downloading{queuedDlCount > 0 ? `, ${queuedDlCount} queued` : ''}
          </span>
        ) : null}
        {notice ? <span style={{ ...row, ...(notice.isErr ? err : {}), fontSize: 12 }}>{notice.msg}</span> : null}
      </div>

      {/* --- Diagnostics & Runtimes --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name={diagBusy || busy ? 'processing' : 'checkOk'} size={15} live={Boolean(diagBusy || busy)} />
          <span>Diagnostics {busy ? `(${busy}…)` : ''}</span>
        </div>
        {diag
          ? DIAGNOSTIC_ROWS.map(([key, name]) => {
              const v = diag[key];
              const good = v === 'installed';
              return (
                <div style={row} key={key}>
                  <span style={label}>{name}</span>
                  <AnimatedIcon name={good ? 'checkOk' : 'warning'} size={14} style={good ? ok : warn} />
                  {diag.details?.[key] ? <span style={{ opacity: 0.6, fontSize: 11 }}>{diag.details[key]}</span> : null}
                </div>
              );
            })
          : <div style={{ ...row, opacity: 0.6 }}><AnimatedIcon name="processing" size={14} live={true} /> Running…</div>}
        <div style={row}>
          <Tip label="Re-run the diagnostics (probes the microphone and audio output once)">
            <button type="button" style={btn} onClick={() => void refreshDiag()}>
              <AnimatedIcon name="recheck" size={13} live={diagBusy} /> Re-check
            </button>
          </Tip>
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            Whisper: {status?.runtimes?.whisper ?? '…'} / Piper: {status?.runtimes?.piper ?? '…'} / voices in catalogue: {status?.catalogue?.count ?? '…'}
          </span>
        </div>
        <div style={row}>
          <span style={label}>Install runtimes</span>
          {/* Whisper runtime install / status / cancel */}
          {whisperRtDl.state ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Tip label={whisperRtDl.state === 'queued' ? 'Queued in download queue…' : 'Downloading and extracting Whisper runtime…'}>
                <span style={{ ...btn, ...(whisperRtDl.state === 'queued' ? warn : ok), cursor: 'default' }}>
                  <AnimatedIcon name={whisperRtDl.state === 'queued' ? 'processing' : 'download'} size={14} live={true} />
                  <span>
                    {whisperRtDl.state === 'queued'
                      ? 'Whisper runtime (queued…)'
                      : `Whisper runtime (${whisperRtDl.percent > 0 ? `${whisperRtDl.percent}%` : 'downloading…'})`}
                  </span>
                </span>
              </Tip>
              <Tip label="Cancel Whisper runtime download">
                <button
                  type="button"
                  style={btn}
                  onClick={() => void api.postJson('/runtime/cancel', { kind: 'whisper' }).then(load).catch(() => {})}
                >
                  <AnimatedIcon name="cancelDownload" size={14} />
                </button>
              </Tip>
            </span>
          ) : (
            <Tip label={status?.runtimes?.whisper === 'installed' ? 'Whisper runtime is installed (click to reinstall)' : 'Download the local Whisper runtime (STT engine)'}>
              <button
                type="button"
                style={btn}
                onClick={() => void startDownload('runtime:whisper', () => api.postJson('/runtime/install', { kind: 'whisper' }))}
              >
                <AnimatedIcon
                  name={status?.runtimes?.whisper === 'installed' ? 'checkOk' : 'download'}
                  size={14}
                  style={status?.runtimes?.whisper === 'installed' ? ok : undefined}
                />
                <span>Whisper runtime</span>
              </button>
            </Tip>
          )}

          {/* Piper runtime install / status / cancel */}
          {piperRtDl.state ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Tip label={piperRtDl.state === 'queued' ? 'Queued in download queue…' : 'Downloading and extracting Piper runtime…'}>
                <span style={{ ...btn, ...(piperRtDl.state === 'queued' ? warn : ok), cursor: 'default' }}>
                  <AnimatedIcon name={piperRtDl.state === 'queued' ? 'processing' : 'download'} size={14} live={true} />
                  <span>
                    {piperRtDl.state === 'queued'
                      ? 'Piper runtime (queued…)'
                      : `Piper runtime (${piperRtDl.percent > 0 ? `${piperRtDl.percent}%` : 'downloading…'})`}
                  </span>
                </span>
              </Tip>
              <Tip label="Cancel Piper runtime download">
                <button
                  type="button"
                  style={btn}
                  onClick={() => void api.postJson('/runtime/cancel', { kind: 'piper' }).then(load).catch(() => {})}
                >
                  <AnimatedIcon name="cancelDownload" size={14} />
                </button>
              </Tip>
            </span>
          ) : (
            <Tip label={status?.runtimes?.piper === 'installed' ? 'Piper runtime is installed (click to reinstall)' : 'Download the local Piper runtime (TTS engine)'}>
              <button
                type="button"
                style={btn}
                onClick={() => void startDownload('runtime:piper', () => api.postJson('/runtime/install', { kind: 'piper' }))}
              >
                <AnimatedIcon
                  name={status?.runtimes?.piper === 'installed' ? 'checkOk' : 'download'}
                  size={14}
                  style={status?.runtimes?.piper === 'installed' ? ok : undefined}
                />
                <span>Piper runtime</span>
              </button>
            </Tip>
          )}
        </div>
      </div>

      {/* --- Whisper --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name="mic" size={15} />
          <span>Whisper (speech → text)</span>
        </div>
        {(models?.models ?? []).map((m) => {
          const wInstalled = m.installed === true;
          const dlInfo = getDownloadInfo(`whisper-model:${m.id}`, m.downloadState ?? (m.downloading ? 'downloading' : null));
          const wDlState = dlInfo.state;
          const wActive = config.whisperModel === m.id;
          return (
            <div
              key={m.id}
              style={{
                ...row,
                marginBottom: 2,
                paddingLeft: 6,
                background: wActive ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.14))' : 'transparent',
                borderLeft: wActive ? '3px solid var(--dsw-alias-state-success-primary, #4caf7d)' : '3px solid transparent',
              }}
            >
              <span style={{ minWidth: 170, fontSize: 12 }}>{m.displayName} · {m.approxSizeMB} MB</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', paddingLeft: 8 }}>
                {wDlState === 'downloading' ? (
                  <Tip label="Downloading model…">
                    <span style={{ ...ok, padding: '0 4px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <AnimatedIcon name="download" size={14} live={true} style={ok} />
                      {dlInfo.percent > 0 ? `${dlInfo.percent}%` : null}
                    </span>
                  </Tip>
                ) : wDlState === 'queued' ? (
                  <Tip label="Queued in download queue (waiting for an open download slot)…">
                    <span style={{ ...warn, padding: '0 4px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <AnimatedIcon name="processing" size={14} live={true} style={warn} />
                      <span>Queued</span>
                    </span>
                  </Tip>
                ) : wInstalled ? (
                  <Tip label="Installed">
                    <span style={{ ...ok, padding: '0 4px', display: 'inline-flex', alignItems: 'center' }}>
                      <AnimatedIcon name="checkOk" size={14} style={ok} />
                    </span>
                  </Tip>
                ) : (
                  <Tip label={`Download this model (${m.approxSizeMB} MB)`}>
                    <button
                      type="button"
                      style={btn}
                      onClick={() => void startDownload(`whisper-model:${m.id}`, () => api.postJson('/models/whisper/download', { id: m.id }))}
                    >
                      <AnimatedIcon name="download" size={14} />
                    </button>
                  </Tip>
                )}
                {wDlState ? (
                  <Tip label="Cancel download">
                    <button
                      type="button"
                      style={btn}
                      onClick={() => void api.postJson('/models/whisper/cancel', { id: m.id }).then(load).catch(() => {})}
                    >
                      <AnimatedIcon name="cancelDownload" size={14} />
                    </button>
                  </Tip>
                ) : null}
                {wInstalled ? (
                  <Tip label={wActive ? 'Active model (in use)' : 'Set as the active Whisper model'}>
                    <button
                      type="button"
                      style={{ ...btn, ...(wActive ? { borderColor: 'var(--dsw-alias-state-success-primary, #4caf7d)', color: 'var(--dsw-alias-state-success-primary, #4caf7d)' } : {}) }}
                      disabled={wActive}
                      onClick={() => void run(`selecting ${m.displayName}`, () => api.postJson('/models/whisper/select', { id: m.id }).then((j) => setConfig(j.config)))}
                    >
                      <AnimatedIcon name={wActive ? 'activeModel' : 'setDefault'} size={14} />
                    </button>
                  </Tip>
                ) : null}
                {wInstalled ? (
                  <Tip label="Remove this model from disk">
                    <button
                      type="button"
                      style={btn}
                      onClick={() => {
                        if (confirm(`Delete ${m.displayName} from disk?`)) void run(`removing ${m.displayName}`, () => api.postJson('/models/whisper/remove', { id: m.id }));
                      }}
                    >
                      <AnimatedIcon name="removeModel" size={14} />
                    </button>
                  </Tip>
                ) : null}
              </span>
            </div>
          );
        })}
        {(models?.models ?? []).length === 0 ? <div style={{ ...row, opacity: 0.6 }}>Loading Whisper models…</div> : null}
        <div style={row}>
          <Tip label="Language of the recording. 'Auto' = English (the engine default; auto-detection isn't supported).">
            <span style={label}><AnimatedIcon name="language" size={13} /> Language</span>
          </Tip>
          <DarkSelect
            value={config.whisperLanguage}
            onChange={(v) => void patch({ whisperLanguage: v })}
            options={[
              { value: 'auto', label: 'Auto (engine default: English — auto-detection not supported)' },
              ...WHISPER_LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
            ]}
          />
        </div>
        <div style={row}>
          <Tip label="Transcribe keeps the original language; Translate outputs English."><span style={label}>Task</span></Tip>
          <DarkSelect
            value={config.whisperTask}
            onChange={(v) => void patch({ whisperTask: v })}
            options={[
              { value: 'transcribe', label: 'Transcribe' },
              { value: 'translate', label: 'Translate to English' },
            ]}
          />
        </div>
        <div style={row}>
          <Tip label="Smaller model = faster live partials; the final transcript always uses the main model."><span style={label}>Live preview model</span></Tip>
          <DarkSelect
            value={config.sttWindowModel ?? ''}
            onChange={(v) => void patch({ sttWindowModel: v })}
            options={[
              { value: '', label: 'Same as main model' },
              ...(models?.models ?? []).map((m) => ({ value: m.id, label: `${m.displayName}${m.installed ? '' : ' (not installed)'}` })),
            ]}
          />
        </div>
      </div>

      {/* --- Piper --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name="unmute" size={15} />
          <span>Piper (text → speech)</span>
        </div>
        <div style={row}>
          <span style={label}><AnimatedIcon name="language" size={13} /> Language</span>
          <DarkSelect
            value={config.piperLanguageCode}
            onChange={(v) => void patch({ piperLanguageCode: v })}
            options={(piper?.languages ?? []).map((l) => ({ value: l.code, label: l.name }))}
          />
          <span style={{ opacity: 0.6, fontSize: 11 }}>
            selected: {selectedVoice ? `${selectedVoice.language} / ${selectedVoice.region} / ${selectedVoice.name} / ${selectedVoice.quality}` : '—'}
          </span>
        </div>
        <div style={row}>
          <input style={{ ...input, flex: 1, minWidth: 120 }} placeholder="Search voice name / locale / language…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Tip label="Refresh catalogue">
            <button
              type="button"
              style={btn}
              title="Refresh catalogue"
              onClick={() => void run('refreshing catalogue', () => api.postJson('/models/piper/refresh', {}))}
            >
              <AnimatedIcon name="refreshCatalogue" size={14} live={busy === 'refreshing catalogue'} />
            </button>
          </Tip>
        </div>
        {needsFallback && (
          <div style={{ ...row, ...warn }}>
            <AnimatedIcon name="warning" size={14} style={warn} />
            <span>You removed the selected voice. Pick a replacement:</span>
            <DarkSelect
              placeholder="choose…"
              value=""
              onChange={(v) => {
                if (!v) return;
                void run('selecting replacement voice', () => api.postJson('/models/piper/select', { key: v }).then((j) => setConfig(j.config)));
                setNeedsFallback(false);
              }}
              options={(piper?.voices ?? [])
                .filter((v) => installedVoiceKeys.has(v.key))
                .map((v) => ({ value: v.key, label: `${v.name} / ${v.quality}${v.onnxSizeBytes ? ` (${Math.round(v.onnxSizeBytes / 1048576)} MB, installed)` : ''}` }))}
            />
          </div>
        )}
        {filteredVoices.slice(0, 40).map((v) => {
          const installed = installedVoiceKeys.has(v.key);
          const isActive = config?.piperVoiceKey === v.key;
          const vDlInfo = getDownloadInfo(`piper-voice:${v.key}`, v.downloadState ?? (v.downloading ? 'downloading' : null));
          const vDlState = vDlInfo.state;
          return (
            <div
              key={v.key}
              style={{
                ...row,
                paddingLeft: 6,
                background: isActive ? 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.12))' : 'transparent',
                borderLeft: isActive ? '3px solid var(--dsw-alias-state-success-primary, #4caf7d)' : '3px solid transparent',
              }}
            >
              <span style={{ minWidth: 220, fontSize: 12 }}>
                {v.name} · {v.region} · {v.quality}
                {v.numSpeakers > 1 ? ` · ${v.numSpeakers} speakers` : ''}
                {v.onnxSizeBytes ? ` · ${Math.round(v.onnxSizeBytes / 1048576)} MB` : ''}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto', paddingLeft: 8 }}>
                {installed ? (
                  previewPlaying === v.key ? (
                    <Tip label="Stop preview (click to stop and reset)">
                      <button
                        type="button"
                        style={{ ...btn, borderColor: 'var(--dsw-alias-state-error-primary, #e06c5a)', color: 'var(--dsw-alias-state-error-primary, #e06c5a)' }}
                        onClick={() => stopPreview()}
                      >
                        <AnimatedIcon name="previewStop" size={14} live={true} />
                      </button>
                    </Tip>
                  ) : previewing === v.key ? (
                    <Tip label="Generating preview…">
                      <button type="button" style={{ ...btn, opacity: 0.7 }} disabled>
                        <AnimatedIcon name="processing" size={14} live={true} />
                      </button>
                    </Tip>
                  ) : (
                    <Tip label="Preview this voice (a few words, in its language)">
                      <button
                        type="button"
                        style={btn}
                        onClick={() => void playPreview(v)}
                      >
                        <AnimatedIcon name="previewPlay" size={14} />
                      </button>
                    </Tip>
                  )
                ) : vDlState === 'downloading' ? (
                  <Tip label="Downloading voice…">
                    <span style={{ ...ok, padding: '0 4px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <AnimatedIcon name="download" size={14} live={true} style={ok} />
                      {vDlInfo.percent > 0 ? `${vDlInfo.percent}%` : null}
                    </span>
                  </Tip>
                ) : vDlState === 'queued' ? (
                  <Tip label="Queued in download queue (waiting for an open download slot)…">
                    <span style={{ ...warn, padding: '0 4px', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <AnimatedIcon name="processing" size={14} live={true} style={warn} />
                      <span>Queued</span>
                    </span>
                  </Tip>
                ) : (
                  <Tip label={`Download this voice${v.onnxSizeBytes ? ` (~${Math.round(v.onnxSizeBytes / 1048576)} MB)` : ''}`}>
                    <button
                      type="button"
                      style={btn}
                      onClick={() => void startDownload(`piper-voice:${v.key}`, () => api.postJson('/models/piper/download', { key: v.key }))}
                    >
                      <AnimatedIcon name="download" size={14} />
                    </button>
                  </Tip>
                )}
                {vDlState ? (
                  <Tip label="Cancel voice download">
                    <button
                      type="button"
                      style={btn}
                      onClick={() => void api.postJson('/models/piper/cancel', { key: v.key }).then(load).catch(() => {})}
                    >
                      <AnimatedIcon name="cancelDownload" size={14} />
                    </button>
                  </Tip>
                ) : null}
                {installed ? (
                  <Tip label={isActive ? 'Active voice (in use)' : 'Set as the active voice'}>
                    <button
                      type="button"
                      style={{ ...btn, ...(isActive ? { borderColor: 'var(--dsw-alias-state-success-primary, #4caf7d)', color: 'var(--dsw-alias-state-success-primary, #4caf7d)' } : {}) }}
                      disabled={isActive}
                      onClick={() => void run(`selecting ${v.name}`, () => api.postJson('/models/piper/select', { key: v.key }).then((j) => setConfig(j.config)))}
                    >
                      <AnimatedIcon name={isActive ? 'activeModel' : 'setDefault'} size={14} />
                    </button>
                  </Tip>
                ) : null}
                {installed ? (
                  <Tip label="Remove this voice from disk">
                    <button
                      type="button"
                      style={btn}
                      onClick={() => {
                        if (confirm(`Remove voice ${v.name} from disk?`))
                          void run(`removing ${v.name}`, () =>
                            api.postJson('/models/piper/remove', { key: v.key }).then((j) => {
                              if (j.wasSelected) setNeedsFallback(true);
                            }),
                          );
                      }}
                    >
                      <AnimatedIcon name="removeModel" size={14} />
                    </button>
                  </Tip>
                ) : null}
              </span>
            </div>
          );
        })}
        {filteredVoices.length > 40 ? <div style={{ ...row, opacity: 0.6, fontSize: 11 }}>… {filteredVoices.length - 40} more — refine the search</div> : null}
      </div>

      {/* --- TTS Speech Quality & Behaviour --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name="play" size={14} />
          <span>Speech quality & behaviour</span>
        </div>
        <div style={row}>
          <Tip label="Speaking speed. 1.0 = natural; higher = faster, lower = slower."><span style={label}>Speed (0.5–2.0)</span></Tip>
          <input type="range" min="0.5" max="2" step="0.1" value={config.ttsSpeed} onChange={(e) => void patch({ ttsSpeed: Number(e.target.value) })} />
          <span style={{ fontSize: 11, opacity: 0.7 }}>{config.ttsSpeed.toFixed(1)}×</span>
        </div>
        <div style={row}>
          <Tip label="Output loudness, 0–100%. Click the speaker icon to mute/unmute.">
            <span style={label}>Volume (0–1)</span>
          </Tip>
          <Tip label={config.ttsVolume <= 0 ? 'Unmute speech output' : 'Mute speech output'}>
            <button
              type="button"
              style={{ ...btn, padding: '2px 5px' }}
              onClick={() => {
                if (config.ttsVolume > 0) {
                  prevVolumeRef.current = config.ttsVolume;
                  void patch({ ttsVolume: 0 });
                } else {
                  void patch({ ttsVolume: prevVolumeRef.current > 0 ? prevVolumeRef.current : 1.0 });
                }
              }}
            >
              <AnimatedIcon name={config.ttsVolume <= 0 ? 'mute' : 'unmute'} size={14} />
            </button>
          </Tip>
          <input type="range" min="0" max="1" step="0.05" value={config.ttsVolume} onChange={(e) => void patch({ ttsVolume: Number(e.target.value) })} />
          <span style={{ fontSize: 11, opacity: 0.7 }}>{Math.round(config.ttsVolume * 100)}%</span>
        </div>
        <div style={row}>
          <Tip label="How much pauses / silence are stretched. Higher = longer pauses."><span style={label}>Length scale (0.3–3.0)</span></Tip>
          <input type="range" min="0.3" max="3" step="0.1" value={config.ttsLengthScale} onChange={(e) => void patch({ ttsLengthScale: Number(e.target.value) })} />
          <span style={{ fontSize: 11, opacity: 0.7 }}>{config.ttsLengthScale.toFixed(1)}</span>
        </div>
        <div style={row}>
          <Tip label="Silence appended after each spoken chunk (except the last) — a natural pause between sentence groups. 0 = off."><span style={label}>Pause between chunks (ms)</span></Tip>
          <input
            style={{ ...input, width: 70 }}
            type="number"
            min="0"
            max="2000"
            step="50"
            value={config.pauseBetweenSentences}
            onChange={(e) => void patch({ pauseBetweenSentences: Number(e.target.value) })}
          />
        </div>
        <div style={row}>
          <Tip label="Normalize each chunk's loudness to a fixed level, so the volume doesn't jump between chunks of one response.">
            <SwitchToggle checked={config.ttsLevelMatch} onChange={(v) => void patch({ ttsLevelMatch: v })}>
              Level-match chunk loudness
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Keep one Piper process alive per voice: the model is loaded once, so chunks synthesize faster. Off = one short-lived Piper process per chunk (the classic mode).">
            <SwitchToggle checked={config.ttsPersistentWorker} onChange={(v) => void patch({ ttsPersistentWorker: v })}>
              Persistent Piper worker (faster chunks)
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Speak each assistant response automatically as it finishes.">
            <SwitchToggle checked={config.autoSpeak} onChange={(v) => void patch({ autoSpeak: v })}>
              Automatically speak assistant responses
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="When you dictate, send the transcription as a message automatically (after the review delay).">
            <SwitchToggle checked={config.autoSendTranscript} onChange={(v) => void patch({ autoSendTranscript: v })}>
              Automatically send transcription
            </SwitchToggle>
          </Tip>
          <Tip label="0 = send immediately (no review window); any key press or click in the composer cancels the send."><span style={label}>Review delay (s)</span></Tip>
          <input
            style={{ ...input, width: 60 }}
            type="number"
            min="0"
            max="30"
            step="1"
            value={config.autoSendDelaySec}
            onChange={(e) => void patch({ autoSendDelaySec: Number(e.target.value) })}
          />
        </div>
        <div style={row}>
          <Tip label="Also read the model's thinking/reasoning aloud. Off by default — only the visible reply is spoken.">
            <SwitchToggle checked={config.speakThinking} onChange={(v) => void patch({ speakThinking: v })}>
              Speak thinking/reasoning blocks
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Also read tool output aloud (off by default).">
            <SwitchToggle checked={config.speakToolOutput} onChange={(v) => void patch({ speakToolOutput: v })}>
              Speak tool output
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Also read code blocks aloud (off by default — code is omitted).">
            <SwitchToggle checked={config.speakCode} onChange={(v) => void patch({ speakCode: v })}>
              Speak code blocks (default: omitted)
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Stop any speech that's playing when you start a new recording.">
            <SwitchToggle checked={config.stopSpeechOnRecording} onChange={(v) => void patch({ stopSpeechOnRecording: v })}>
              Stop speech when a recording starts
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Log detailed TTS/STT steps (useful for diagnosing playback issues).">
            <SwitchToggle checked={config.debugLogging} onChange={(v) => void patch({ debugLogging: v })}>
              Debug logging
            </SwitchToggle>
          </Tip>
        </div>
      </div>

      {/* --- Text & transcript filters --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name="filter" size={15} />
          <span>Text & transcript filters</span>
        </div>
        <div style={row}>
          <Tip label="Filter assistant text before it is spoken (affects only the Piper input, never the text you see). Defaults strip stray * and # markdown markers.">
            <SwitchToggle
              checked={config.ttsFilter?.enabled ?? true}
              onChange={(v) => void patch({ ttsFilter: { ...(config.ttsFilter ?? {}), enabled: v } })}
            >
              TTS text filter
            </SwitchToggle>
          </Tip>
        </div>
        <FilterRulesEditor
          mode="tts"
          label="TTS rules (JSON)"
          tip={'Rules applied to the Piper input: {kind: "literal"|"regex", value, replacement?, ignoreCase?}. Literal rules have no regex semantics; invalid or catastrophic-backtracking regexes are disabled automatically.'}
          rules={config.ttsFilter?.rules}
          defaults={DEFAULT_TTS_FILTER.rules}
          onApply={(rules) => void patch({ ttsFilter: { ...(config.ttsFilter ?? {}), rules } })}
        />
        <div style={{ ...row, marginBottom: 2 }}><span style={{ opacity: 0.35, fontSize: 11 }}>— transcript —</span></div>
        <div style={row}>
          <Tip label="Filter Whisper transcripts before they reach the input box — strips annotation tokens like (music), [Music], [BLANK_AUDIO], (applause), (laughter), etc. while real words pass untouched.">
            <SwitchToggle
              checked={config.sttFilter?.enabled ?? true}
              onChange={(v) => void patch({ sttFilter: { ...(config.sttFilter ?? {}), enabled: v } })}
            >
              STT transcript filter
            </SwitchToggle>
          </Tip>
        </div>
        <div style={row}>
          <Tip label="Skip Whisper entirely when the recording is quieter than the threshold (silence / ambient noise).">
            <SwitchToggle
              checked={config.sttFilter?.silenceGate?.enabled ?? true}
              onChange={(v) => void patch({ sttFilter: { ...(config.sttFilter ?? {}), silenceGate: { ...(config.sttFilter?.silenceGate ?? {}), enabled: v } } })}
            >
              Silence gate
            </SwitchToggle>
          </Tip>
          <Tip label="Gate threshold in dBFS (0 = full scale). Recordings below this level are treated as silence and never transcribed.">
            <span style={{ ...label, minWidth: 'auto' }}>threshold (dB)</span>
          </Tip>
          <input
            style={{ ...input, width: 60 }}
            type="number"
            min="-80"
            max="0"
            step="1"
            value={config.sttFilter?.silenceGate?.thresholdDb ?? -45}
            onChange={(e) => void patch({ sttFilter: { ...(config.sttFilter ?? {}), silenceGate: { ...(config.sttFilter?.silenceGate ?? {}), thresholdDb: Number(e.target.value) } } })}
          />
        </div>
        <FilterRulesEditor
          mode="stt"
          label="STT rules (JSON)"
          tip={'Rules applied to transcripts: {kind: "literal"|"regex", value, replacement?, ignoreCase?}. Type any word above (e.g. music, noise) to auto-add (word)/[word] rules to the JSON.'}
          rules={config.sttFilter?.rules}
          defaults={DEFAULT_STT_FILTER.rules}
          onApply={(rules) => void patch({ sttFilter: { ...(config.sttFilter ?? {}), rules } })}
        />
      </div>

      {/* --- Input --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name="mic" size={15} />
          <span>Microphone input</span>
        </div>
        <div style={row}>
          <span style={label}>Input mode</span>
          <DarkSelect
            value={config.inputMode}
            onChange={(v) => void patch({ inputMode: v })}
            options={[
              { value: 'click', label: 'Click to record / click to stop' },
              { value: 'push-to-talk', label: 'Push-to-talk (hold hotkey)' },
            ]}
          />
        </div>
        {config.inputMode === 'push-to-talk' && (
          <div style={row}>
            <span style={label}>Hotkey</span>
            <input style={input} value={config.pushToTalkKey} onChange={(e) => void patch({ pushToTalkKey: e.target.value })} placeholder="Ctrl+Space" />
          </div>
        )}
      </div>

      {/* --- Voice queue --- */}
      <div style={box}>
        <div style={h3}>
          <AnimatedIcon name={speakingJobs.length > 0 ? 'ttsPlaying' : 'unmute'} size={15} live={speakingJobs.length > 0} />
          <span>Voice queue</span>
          {speakingJobs.length > 0 || queuedJobs.length > 0 ? (
            <Tip label="Stop all active and queued speech">
              <button
                type="button"
                style={{ ...btn, marginLeft: 'auto' }}
                onClick={() => void api.postJson('/tts/control', { action: 'stopAll' }).then(load).catch(() => {})}
              >
                <AnimatedIcon name="stop" size={13} /> Stop all
              </button>
            </Tip>
          ) : null}
        </div>
        {speakingJobs.length === 0 && queuedJobs.length === 0 ? (
          <div style={{ ...row, opacity: 0.5, fontSize: 12 }}>Idle — nothing speaking or queued.</div>
        ) : (
          <>
            {speakingJobs.map((j) => (
              <div style={row} key={j.id}>
                <span style={{ ...ok, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <AnimatedIcon
                    name={j.state === 'paused' ? 'ttsPaused' : j.state === 'generating' ? 'generatingTTS' : 'ttsPlaying'}
                    size={14}
                    live={true}
                    style={ok}
                  />
                  <span>currently: {j.textPreview}</span>
                </span>
              </div>
            ))}
            {queuedJobs.map((j) => (
              <div style={row} key={j.id}>
                <span style={{ opacity: 0.6, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <AnimatedIcon name="processing" size={14} live={true} />
                  <span>queued: {j.textPreview}</span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
