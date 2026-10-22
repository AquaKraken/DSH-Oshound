// src/client/extract-text.js
// Pure read-only projection of the DSH Chat snapshot into speakable prose.
// No React, no network — testable in plain vitest.
//
// Shape contract (verified against the installed DSH 0.1.5-rc.1 client
// packages, @deepseek-ai/dsh-client-ui-chat + dsh-client-ui-conversation
// type declarations):
//
//   useChat snapshot = ChatSnapshot {
//     order: string[]                      // stable keys, timeline order
//     nodes: ChatNodeStore                 // .get(key), .values() (unordered)
//     timeline: { turnOrder, turns }       // engine-owned locations
//     legacy: { nodes: ConversationNode[], ... }   // compat slice
//   }
//
//   Chat view node (current generation):
//     { kind: 'assistant-step', data: { status, turn, step,
//                                        blocks: AssistantBlock[],
//                                        finalNode?: { messageId?, blocks, seq, ... } } }
//
//   Legacy slice node (rc.1 and earlier):
//     { kind: 'assistant', messageId?, seq, turn, step, blocks, interrupted? }
//     — note: messageId and blocks sit at the TOP LEVEL, not under .data.
//     (The old single-shape reader assumed .data on both and therefore found
//     "no readable text" on newer hosts: legacy.nodes shadowed the view store,
//     and its nodes carry no .data wrapper.)
//
//   AssistantBlock =
//     { kind:'text', text } | { kind:'reasoning', text }
//     | { kind:'image', attachment } | { kind:'tool-call', ... }
//     | { kind:'other', block }

/**
 * Collects speakable prose from AssistantBlock[] values.
 * text blocks always; reasoning only when config.speakThinking.
 * (DSH's own assistantText() takes text blocks only — this is a superset
 * gated by the O-Sound speakThinking setting.)
 */
export function blocksToSpeech(blocks, config) {
  const parts = [];
  for (const b of blocks ?? []) {
    if (b?.kind === 'text' && b.text) parts.push(b.text);
    else if (b?.kind === 'reasoning' && b.text && config?.speakThinking) parts.push(b.text);
  }
  return parts.join('\n').trim();
}

/**
 * Extracts the speakable text of the assistant message whose durable id
 * matches `messageId`. Dual-shape for DSH generations:
 *  - 0.1.3+: Chat view nodes — kind 'assistant-step', payload under n.data,
 *    durable id at n.data.finalNode.messageId (finalized only: streaming
 *    prefixes have no finalNode and are skipped).
 *  - rc.1 / earlier: raw finalized nodes in the legacy slice — kind
 *    'assistant', with n.messageId and n.blocks at the top level.
 */
export function extractAssistantText(chat, messageId, config) {
  if (!chat || !messageId) return null;
  const store = chat.nodes;
  const legacy = Array.isArray(chat.legacy?.nodes) ? chat.legacy.nodes : [];

  // Pass 1 (current generation): Chat view node store, kind 'assistant-step'.
  if (store && typeof store.values === 'function') {
    for (const n of store.values()) {
      if (n?.kind !== 'assistant-step') continue;
      if (n.data?.finalNode?.messageId !== messageId) continue;
      const text = blocksToSpeech(n.data?.blocks, config);
      if (text) return text;
    }
  }
  // Pass 2 (compat): legacy finalized-node slice, kind 'assistant'.
  for (const n of legacy) {
    if (n?.kind !== 'assistant' || n.messageId !== messageId) continue;
    const text = blocksToSpeech(n.blocks, config);
    if (text) return text;
  }
  // Pass 3 (kind-agnostic fallback): a future DSH generation may wrap the
  // assistant payload under an unexpected node kind. Match on the durable
  // messageId ALONE (finalNode.messageId in the view, top-level messageId in
  // the legacy slice) and accept the first node that yields speakable text.
  // diagnoseExtraction() below explains what the snapshot actually contains
  // when this still fails, so the next investigation starts from data, not guesses.
  if (store && typeof store.values === 'function') {
    for (const n of store.values()) {
      if (n?.data?.finalNode?.messageId !== messageId) continue;
      const text = blocksToSpeech(n?.data?.blocks ?? n?.blocks, config);
      if (text) return text;
    }
  }
  for (const n of legacy) {
    if (n?.messageId !== messageId) continue;
    const text = blocksToSpeech(n?.data?.blocks ?? n?.blocks, config);
    if (text) return text;
  }
  return null;
}

/**
 * Read-only snapshot diagnosis for "no readable text found": WHAT the chat
 * snapshot actually contains. Consumed by SpeakerButton's console.warn so a
 * failed extraction is a data point (kind counts + where the messageId was
 * seen), not a mystery.
 * @param {object} chat - a useChat snapshot
 * @param {string} messageId
 * @returns {{orderLen: number, viewCount: number, viewKinds: Object.<string, number>, legacyCount: number, legacyKinds: Object.<string, number>, messageIdSeen: string[]}}
 */
export function diagnoseExtraction(chat, messageId) {
  const viewKinds = {};
  const legacyKinds = {};
  let viewCount = 0;
  let legacyCount = 0;
  let seenInView = false;
  let seenInLegacy = false;

  const store = chat?.nodes;
  if (store && typeof store.values === 'function') {
    for (const n of store.values()) {
      viewCount += 1;
      const kind = n?.kind ?? 'unknown';
      viewKinds[kind] = (viewKinds[kind] ?? 0) + 1;
      if (n?.data?.finalNode?.messageId === messageId) seenInView = true;
    }
  }
  const legacy = Array.isArray(chat?.legacy?.nodes) ? chat.legacy.nodes : [];
  for (const n of legacy) {
    legacyCount += 1;
    const kind = n?.kind ?? 'unknown';
    legacyKinds[kind] = (legacyKinds[kind] ?? 0) + 1;
    if (n?.messageId === messageId) seenInLegacy = true;
  }
  return {
    orderLen: Array.isArray(chat?.order) ? chat.order.length : 0,
    viewCount,
    viewKinds,
    legacyCount,
    legacyKinds,
    messageIdSeen: [seenInView ? 'view' : null, seenInLegacy ? 'legacy' : null].filter(Boolean),
  };
}

/**
 * Latest finalized assistant message id in timeline order, or null.
 * Current generation walks the stable key order with the per-key node
 * reader (order-safe; values() does not impose order). Falls back to the
 * legacy finalized-node slice (greatest seq) on older hosts.
 */
export function latestFinalizedAssistantMessageId(chat) {
  if (!chat) return null;
  const order = Array.isArray(chat.order) ? chat.order : null;
  const store = chat.nodes;
  if (order && store && typeof store.get === 'function') {
    let mid = null;
    for (const key of order) {
      const n = store.get(key);
      if (n?.kind === 'assistant-step' && n.data?.finalNode?.messageId) {
        mid = n.data.finalNode.messageId;
      }
    }
    if (mid) return mid;
  }
  const legacy = Array.isArray(chat.legacy?.nodes) ? chat.legacy.nodes : [];
  let best = null;
  for (const n of legacy) {
    if (n?.kind !== 'assistant' || !n.messageId) continue;
    if (!best || (n.seq ?? 0) >= (best.seq ?? 0)) best = n;
  }
  return best?.messageId ?? null;
}
