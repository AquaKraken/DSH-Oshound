// src/client/AutoSpeaker.jsx
// Hidden auto-speak watchdog (slot: conversation.session.header.utilities —
// session scope, exactly one instance per session, the same place
// dsh-done-sound keeps its TurnChimeDetector). Watches the chat snapshot;
// when a NEW assistant message finalizes and autoSpeak is on, it speaks it.
// The last finalized message present at mount is baselined and never spoken,
// so loading a session does not re-announce its history.

import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { SpeakerPlayer } from './player.js';
import { extractAssistantText, latestFinalizedAssistantMessageId } from './extract-text.js';

export function AutoSpeaker(props) {
  const chat = props.useChat ? props.useChat((s) => s) : null;
  const [config, setConfig] = useState(null);
  const playerRef = useRef(null);
  const baselineRef = useRef(null); // last finalized messageId at mount
  const lastSpokenRef = useRef(null);

  useEffect(() => {
    api.getJson('/config').then((j) => setConfig(j.config)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!chat || !config) return;
    const mid = latestFinalizedAssistantMessageId(chat);
    if (!mid) return;

    if (baselineRef.current === null) {
      baselineRef.current = mid; // first snapshot: baseline only, don't speak history
      lastSpokenRef.current = mid;
      return;
    }
    if (mid === lastSpokenRef.current) return;

    if (config.autoSpeak) {
      const text = extractAssistantText(chat, mid, config);
      if (text) {
        if (!playerRef.current) playerRef.current = new SpeakerPlayer();
        void playerRef.current.speak(text, config.ttsVolume ?? 1.0);
      }
    }
    lastSpokenRef.current = mid;
  }, [chat, config]);

  // A single watchdog per session — nothing visible.
  return <span style={{ display: 'none' }} aria-hidden="true" />;
}
