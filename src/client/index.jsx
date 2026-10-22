// src/client/index.jsx
// Client bundle entry (built to lib/client.js — see scripts/build-client.mjs).
// Registers O-Sound's UI into DSH's client slots; all data flows over the
// same-origin /dsh-osound/api routes served by the host (src/dsh/adapter.js).

import React from 'react';
import { MicButton } from './MicButton.jsx';
import { SpeakerButton } from './SpeakerButton.jsx';
import { AutoSpeaker } from './AutoSpeaker.jsx';
import { SettingsCard } from './SettingsCard.jsx';

// DSH reveals each turn's message-action row "always" only for the LATEST turn
// and "hover" for every older turn, so a per-message action (the 🔊) is hidden
// on all old assistant messages until you hover. We normalize older turns to
// "always" so the O-Sound speaker button is reachable on old messages too.
function installAlwaysVisibleActions() {
  if (typeof document === 'undefined') return () => {};
  const flip = (el) => {
    if (el && typeof el.getAttribute === 'function' && el.getAttribute('data-actions-reveal') === 'hover') {
      el.setAttribute('data-actions-reveal', 'always');
    }
  };
  const scan = (root) => {
    if (!root) return;
    if (root.nodeType === 1) flip(root);
    if (typeof root.querySelectorAll === 'function') {
      root.querySelectorAll('[data-actions-reveal=hover]').forEach(flip);
    }
  };
  scan(document);
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') flip(m.target);
        else for (const n of m.addedNodes) scan(n);
      }
    });
    mo.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-actions-reveal'],
    });
    return () => mo.disconnect();
  } catch {
    return () => {};
  }
}

export const name = 'dsh-osound';
export const inject = ['slots'];

export function apply(ctx) {
  const { slots } = ctx;

  const disposeActionsObserver = installAlwaysVisibleActions();
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeActionsObserver);
  }

  // 🎤 Composer microphone button (session scope; props carry useInput/inputActions).
  slots.inject('conversation.input.left', () => {
    slots.register(
      { name: 'conversation.input.left', id: 'dsh-osound-mic', order: 50, label: 'O-Sound Microphone' },
      (props) => React.createElement(MicButton, props),
    );
  });

  // 🔊 Per finalized assistant message (owner = { messageId }).
  slots.inject('conversation.chat.assistant-actions', () => {
    slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'dsh-osound-speaker', order: 40, label: 'Speak' },
      (props) => React.createElement(SpeakerButton, props),
    );
  });

  // Hidden auto-speak watchdog (one per session).
  slots.inject('conversation.session.header.utilities', () => {
    slots.register(
      { name: 'conversation.session.header.utilities', id: 'dsh-osound-auto', order: 60, label: 'O-Sound' },
      (props) => React.createElement(AutoSpeaker, props),
    );
  });

  // Settings → Voice card.
  slots.inject('settings.section', () => {
    slots.register(
      { name: 'settings.section', id: 'dsh-osound', order: 40, label: 'O-Sound' },
      () => React.createElement(SettingsCard),
    );
  });
}
