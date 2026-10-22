import { describe, expect, it } from 'vitest';
import {
  blocksToSpeech,
  extractAssistantText,
  latestFinalizedAssistantMessageId,
} from '../src/client/extract-text.js';

/** Minimal ChatNodeStore fake: .values() (unordered) + .get(key). */
function makeStore(nodes) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  return {
    values: () => nodes,
    get: (key) => byKey.get(key),
  };
}

function viewNode({ key, messageId, blocks, status = 'settled' }) {
  return {
    key,
    kind: 'assistant-step',
    data: {
      status,
      turn: 1,
      step: 1,
      blocks,
      ...(messageId ? { finalNode: { kind: 'assistant', messageId, seq: 10, blocks } } : {}),
    },
  };
}

function legacyNode({ messageId, blocks, seq, interrupted }) {
  return { kind: 'assistant', messageId, seq, turn: 1, step: 1, blocks, ...(interrupted ? { interrupted: true } : {}) };
}

describe('blocksToSpeech', () => {
  it('joins text blocks, skips image/tool/other', () => {
    const out = blocksToSpeech(
      [
        { kind: 'text', text: 'Hello.' },
        { kind: 'image', attachment: { id: 'x' } },
        { kind: 'tool-call', callId: 'c1', name: 'ls', argsRaw: '{}' },
        { kind: 'other', block: {} },
        { kind: 'text', text: 'World.' },
      ],
      {},
    );
    expect(out).toBe('Hello.\nWorld.');
  });

  it('includes reasoning only when speakThinking is on', () => {
    const blocks = [{ kind: 'reasoning', text: 'thinking…' }, { kind: 'text', text: 'Answer.' }];
    expect(blocksToSpeech(blocks, { speakThinking: false })).toBe('Answer.');
    expect(blocksToSpeech(blocks, { speakThinking: true })).toBe('thinking…\nAnswer.');
  });

  it('tolerates null/empty blocks', () => {
    expect(blocksToSpeech(null, {})).toBe('');
    expect(blocksToSpeech([], {})).toBe('');
  });
});

describe('extractAssistantText — current-generation view nodes (0.1.3+)', () => {
  it('finds the finalized message via data.finalNode.messageId + data.blocks', () => {
    const chat = {
      order: ['k1'],
      nodes: makeStore([viewNode({ key: 'k1', messageId: 'm1', blocks: [{ kind: 'text', text: 'Spoken line.' }] })]),
    };
    expect(extractAssistantText(chat, 'm1', {})).toBe('Spoken line.');
  });

  it('skips streaming prefixes (no finalNode) even if kind matches', () => {
    const chat = {
      order: ['k1'],
      nodes: makeStore([viewNode({ key: 'k1', messageId: null, blocks: [{ kind: 'text', text: 'partial' }], status: 'running' })]),
    };
    expect(extractAssistantText(chat, 'm1', {})).toBeNull();
  });

  it('ignores other node kinds in the store', () => {
    const chat = {
      order: ['k0', 'k1'],
      nodes: makeStore([
        { key: 'k0', kind: 'user', data: {} },
        viewNode({ key: 'k1', messageId: 'm1', blocks: [{ kind: 'text', text: 'Hi.' }] }),
      ]),
    };
    expect(extractAssistantText(chat, 'm1', {})).toBe('Hi.');
  });

  it('returns null for unknown message ids and null chat', () => {
    const chat = { order: ['k1'], nodes: makeStore([viewNode({ key: 'k1', messageId: 'm1', blocks: [{ kind: 'text', text: 'Hi.' }] })]) };
    expect(extractAssistantText(chat, 'nope', {})).toBeNull();
    expect(extractAssistantText(null, 'm1', {})).toBeNull();
    expect(extractAssistantText(chat, null, {})).toBeNull();
  });
});

describe('extractAssistantText — legacy slice (rc.1 / compat carrier)', () => {
  it('finds raw nodes with TOP-LEVEL messageId and blocks (no .data wrapper)', () => {
    const chat = {
      legacy: { nodes: [legacyNode({ messageId: 'm9', blocks: [{ kind: 'text', text: 'Legacy text.' }], seq: 5 })] },
    };
    expect(extractAssistantText(chat, 'm9', {})).toBe('Legacy text.');
  });

  it('prefers the view store when both carriers match, falls back to legacy otherwise', () => {
    const view = viewNode({ key: 'k1', messageId: 'm1', blocks: [{ kind: 'text', text: 'from-view' }] });
    const legacyOnly = legacyNode({ messageId: 'm2', blocks: [{ kind: 'text', text: 'from-legacy' }], seq: 7 });
    const chat = {
      order: ['k1'],
      nodes: makeStore([view]),
      legacy: { nodes: [viewNodeLegacyFor(view), legacyOnly] },
    };
    expect(extractAssistantText(chat, 'm1', {})).toBe('from-view');
    expect(extractAssistantText(chat, 'm2', {})).toBe('from-legacy');
  });

  function viewNodeLegacyFor(view) {
    return legacyNode({ messageId: view.data.finalNode.messageId, blocks: view.data.blocks, seq: 10 });
  }
});

describe('latestFinalizedAssistantMessageId', () => {
  it('returns the LAST finalized assistant in timeline order (order array wins over values order)', () => {
    // values() is intentionally unordered: store lists newest first,
    // order[] says otherwise — the reader must follow order[].
    const older = viewNode({ key: 'kA', messageId: 'older', blocks: [{ kind: 'text', text: 'a' }] });
    const newer = viewNode({ key: 'kB', messageId: 'newer', blocks: [{ kind: 'text', text: 'b' }] });
    const streaming = viewNode({ key: 'kC', messageId: null, blocks: [{ kind: 'text', text: 'c' }], status: 'running' });
    const chat = {
      order: ['kA', 'kB', 'kC'],
      nodes: makeStore([newer, older, streaming]),
    };
    expect(latestFinalizedAssistantMessageId(chat)).toBe('newer');
  });

  it('ignores streaming prefixes and non-assistant nodes', () => {
    const finalized = viewNode({ key: 'k1', messageId: 'm1', blocks: [{ kind: 'text', text: 'x' }] });
    const streaming = viewNode({ key: 'k2', messageId: null, blocks: [{ kind: 'text', text: 'y' }], status: 'running' });
    const chat = {
      order: ['k1', 'k2'],
      nodes: makeStore([{ key: 'k0', kind: 'user', data: {} }, finalized, streaming]),
    };
    expect(latestFinalizedAssistantMessageId(chat)).toBe('m1');
  });

  it('falls back to the legacy slice (greatest seq) when no view store', () => {
    const chat = {
      legacy: {
        nodes: [
          { kind: 'user', seq: 1 },
          legacyNode({ messageId: 'old', blocks: [], seq: 2 }),
          legacyNode({ messageId: 'new', blocks: [], seq: 9 }),
        ],
      },
    };
    expect(latestFinalizedAssistantMessageId(chat)).toBe('new');
  });

  it('returns null for empty or null chat', () => {
    expect(latestFinalizedAssistantMessageId(null)).toBeNull();
    expect(latestFinalizedAssistantMessageId({})).toBeNull();
    expect(latestFinalizedAssistantMessageId({ order: [], nodes: makeStore([]) })).toBeNull();
  });
});
