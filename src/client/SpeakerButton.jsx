// src/client/SpeakerButton.jsx
// 🔊 per finalized assistant message (slot: conversation.chat.assistant-actions,
// owner = { messageId }). Finds the message's text in the chat snapshot and
// drives a SpeakerPlayer for it. Scrolling a speaking message out of view
// stops that speech (the player lives with the component).

import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { SpeakerPlayer } from './player.js';
import { speakerButtonState } from './assistant-speaker.js';
import { extractAssistantText, diagnoseExtraction } from './extract-text.js';
import { AnimatedIcon } from './AnimatedIcon.jsx';

// Neutral chrome border, matched to DSH's real design tokens with the prior
// hardcoded value kept as the fallback (see SettingsCard.jsx for the same
// pattern) — unlike MicButton's deliberately loud accent border, this one is
// meant to blend with the surrounding message-action row, so it follows the
// ambient token rather than standing out.
const btnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  padding: '1px 5px',
  fontSize: 13,
  lineHeight: 1.2,
  marginLeft: 4,
};

// Chat-snapshot text projection lives in ./extract-text.js (pure, tested):
//   extractAssistantText, latestFinalizedAssistantMessageId, blocksToSpeech

export function SpeakerButton(props) {
  const messageId = props.owner?.messageId ?? props.messageId;
  const chat = props.useChat ? props.useChat((s) => s) : null;
  const [player] = useState(() => new SpeakerPlayer());
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const activeRef = useRef(false);

  useEffect(() => {
    api.getJson('/config').then((j) => setConfig(j.config)).catch(() => {});
  }, []);

  useEffect(() => {
    const off = player.onState((s, err) => {
      setState(s);
      setError(err);
      activeRef.current = s === 'generating' || s === 'playing';
    });
    return () => {
      off();
      // Unmount: stop speech if this message is the one currently speaking.
      if (activeRef.current) player.stop();
    };
  }, [player]);

  const onClick = () => {
    if (state === 'idle' || state === 'error') {
      const text = extractAssistantText(chat, messageId, config);
      if (!text) {
        // Runtime proof of where the message's text actually lives in THIS
        // DSH generation — read this console line before guessing (old-message
        // extraction failures, 2026-09-20/21).
        console.warn('[O-Sound] no readable text — diagnosis:', diagnoseExtraction(chat, messageId));
        setError('No readable text found for this message.');
        setState('error');
        return;
      }
      void player.speak(text, config?.ttsVolume ?? 1.0);
    } else if (state === 'generating' || state === 'playing') {
      // Single-button model: while waiting or playing, one click stops and
      // resets the button back to Play (no pause / resume).
      player.stop();
    }
  };

  const view = speakerButtonState(state);
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
      <button
        type="button"
        title={view.ariaLabel}
        aria-label={view.ariaLabel}
        style={{ ...btnStyle, background: view.activeHighlight ? 'rgba(120,160,255,0.15)' : 'transparent' }}
        onClick={onClick}
      >
        <AnimatedIcon name={view.iconName} size={14} live={view.live} />
      </button>
      {state === 'error' && error ? (
        <span style={{ fontSize: 11, opacity: 0.7, marginLeft: 4, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
