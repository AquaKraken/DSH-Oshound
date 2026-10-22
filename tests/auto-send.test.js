import { describe, expect, it } from 'vitest';
import { evaluateAutoSendTick } from '../src/shared/auto-send.js';

// The pure tick decision of the auto-send review window (2026-09-26). The
// MicButton owns timers/state; this module decides send/cancel/wait.
const makePlan = (over = {}) => ({
  seq: 1,
  draft: 'hello this is a test',
  rev: 7,
  startedAt: 1_000_000,
  delayMs: 4000,
  ...over,
});
const inputAt = (plan, over = {}) => ({ draft: plan.draft, draftRev: plan.rev, ...over });

describe('evaluateAutoSendTick', () => {
  it('waits with the correct countdown while the draft is untouched', () => {
    const plan = makePlan();
    expect(evaluateAutoSendTick({ plan, input: inputAt(plan), nowMs: plan.startedAt + 200 })).toEqual({ action: 'wait', leftSec: 4 });
    expect(evaluateAutoSendTick({ plan, input: inputAt(plan), nowMs: plan.startedAt + 3200 })).toEqual({ action: 'wait', leftSec: 1 });
  });

  it('sends automatically when the timer expires (no interaction)', () => {
    const plan = makePlan();
    expect(evaluateAutoSendTick({ plan, input: inputAt(plan), nowMs: plan.startedAt + plan.delayMs }).action).toBe('send');
    expect(evaluateAutoSendTick({ plan, input: inputAt(plan), nowMs: plan.startedAt + plan.delayMs + 5000 }).action).toBe('send');
  });

  it('editing the message cancels (draft differs from what the plan wrote)', () => {
    const plan = makePlan();
    const verdict = evaluateAutoSendTick({ plan, input: inputAt(plan, { draft: 'hello this is a TEST!' }), nowMs: plan.startedAt + 1000 });
    expect(verdict).toEqual({ action: 'cancel', reason: 'user-interacted' });
  });

  it('typing into the composer cancels (draftRev advanced even though draft check would pass)', () => {
    const plan = makePlan();
    // draftRev bumped (e.g. a caret move / selection the projection does not show as a draft change)
    const verdict = evaluateAutoSendTick({ plan, input: inputAt(plan, { draftRev: 8 }), nowMs: plan.startedAt + 1000 });
    expect(verdict.action).toBe('cancel');
  });

  it('selection/cursor interaction cancels (rev bump, draft unchanged)', () => {
    const plan = makePlan();
    const verdict = evaluateAutoSendTick({ plan, input: { draft: plan.draft, draftRev: plan.rev + 3 }, nowMs: plan.startedAt + 2000 });
    expect(verdict.action).toBe('cancel');
  });

  it('cancellation is per-message: a LATER voice message starts a fresh plan that is not cancelled', () => {
    // Message A's plan is cancelled by the user's edit...
    const planA = makePlan({ seq: 1, draft: 'voice message A', rev: 10 });
    const edited = { draft: 'voice message A edited', draftRev: 11 };
    expect(evaluateAutoSendTick({ plan: planA, input: edited, nowMs: planA.startedAt + 500 }).action).toBe('cancel');

    // ...but message B creates a NEW plan bound to B's own draft/rev. The same
    // (already edited) input now matches B's binding exactly, so B counts down
    // normally — the edit to A never touches B.
    const planB = makePlan({ seq: 2, draft: 'voice message B', rev: 12, startedAt: 2_000_000, delayMs: 4000 });
    expect(evaluateAutoSendTick({ plan: planB, input: { draft: 'voice message B', draftRev: 12 }, nowMs: 2_000_000 + 100 })).toEqual({
      action: 'wait',
      leftSec: 4,
    });
    expect(evaluateAutoSendTick({ plan: planB, input: { draft: 'voice message B', draftRev: 12 }, nowMs: 2_000_000 + 4000 }).action).toBe('send');
  });

  it('a stale tick of a superseded plan can never send (seq guard lives in the component; the decision itself is idempotent-safe)', () => {
    const plan = makePlan();
    // Even if the component were to evaluate an old plan after a new one started,
    // the draft/rev binding of the OLD plan no longer matches the composer state.
    const verdict = evaluateAutoSendTick({ plan, input: { draft: 'something newer', draftRev: 99 }, nowMs: plan.startedAt + plan.delayMs });
    expect(verdict.action).toBe('cancel');
  });

  it('works with a missing input snapshot (null) — timer still runs', () => {
    const plan = makePlan();
    expect(evaluateAutoSendTick({ plan, input: null, nowMs: plan.startedAt + 100 }).action).toBe('wait');
    expect(evaluateAutoSendTick({ plan, input: null, nowMs: plan.startedAt + plan.delayMs }).action).toBe('send');
  });
});

describe('evaluateAutoSendTick — v0.5.1 active cursor & setDraft settle fix', () => {
  it('does not false-cancel when draftRev bumps from setDraft or an active cursor while draft is unchanged and userInteracted is false', () => {
    const plan = makePlan({
      rev: 5,
      allowCursorRevSync: true,
      userInteracted: false,
      settleUntilMs: 1_000_000 + 600,
    });
    // Frame 1 (100ms): useInput still has the pre-final partial draft during the settle window
    expect(
      evaluateAutoSendTick({
        plan,
        input: { draft: 'hello this is', draftRev: 5 },
        nowMs: plan.startedAt + 100,
      }),
    ).toEqual({ action: 'wait', leftSec: 4 });

    // Frame 2 (250ms): setDraft landed and active cursor bumped draftRev from 5 -> 7, but text is plan.draft
    expect(
      evaluateAutoSendTick({
        plan,
        input: { draft: plan.draft, draftRev: 7 },
        nowMs: plan.startedAt + 250,
      }),
    ).toEqual({ action: 'wait', leftSec: 4 });
    expect(plan.rev).toBe(7);

    // Timer expires at 4000ms without user interaction -> sends!
    expect(
      evaluateAutoSendTick({
        plan,
        input: { draft: plan.draft, draftRev: 7 },
        nowMs: plan.startedAt + 4000,
      }),
    ).toEqual({ action: 'send' });
  });

  it('cancels immediately when userInteracted is true (key press or click in composer)', () => {
    const plan = makePlan({
      allowCursorRevSync: true,
      userInteracted: true,
    });
    expect(
      evaluateAutoSendTick({
        plan,
        input: { draft: plan.draft, draftRev: plan.rev },
        nowMs: plan.startedAt + 500,
      }),
    ).toEqual({ action: 'cancel', reason: 'user-interacted' });
  });

  it('cancels when draft text differs after the settle window', () => {
    const plan = makePlan({
      allowCursorRevSync: true,
      userInteracted: false,
      settleUntilMs: 1_000_000 + 600,
    });
    expect(
      evaluateAutoSendTick({
        plan,
        input: { draft: 'user edited this', draftRev: 8 },
        nowMs: plan.startedAt + 900,
      }),
    ).toEqual({ action: 'cancel', reason: 'user-interacted' });
  });
});
