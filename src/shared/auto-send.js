// src/shared/auto-send.js
// Pure decision logic for the auto-send review window (2026-09-26, fixed in v0.5.1).
// Kept DOM/React-free so it can be unit-tested: the MicButton owns the timers and
// state; this module only decides what a tick of one countdown plan means.

/**
 * One auto-send plan: binds to the EXACT draft it wrote and the editor revision
 * at write time. A later voice message creates a NEW plan (new seq/draft/rev),
 * so cancellation is inherently per-message: an edit to message A's draft can
 * only fail A's own (draft, rev) check.
 *
 * v0.5.1 fix for active-cursor / programmatic-setDraft cancellation bug:
 * When Whisper finishes writing via `InputActions.setDraft(draft)`, `startAutoSend`
 * runs synchronously before React re-renders with the new `InputState` snapshot,
 * and an active cursor inside the composer can also cause the editor to bump
 * `draftRev` while settling selection at the end of the newly written text.
 * When `plan.allowCursorRevSync` is true and `plan.userInteracted` is not set:
 *   - while the composer is still catching up to `plan.draft` within the initial
 *     write-settle window (`settleUntilMs`), or
 *   - when `input.draft === plan.draft` and no user key/pointer interaction has
 *     occurred (`!plan.userInteracted`),
 * `plan.rev` is synced to `input.draftRev` instead of falsely cancelling.
 *
 * @typedef {Object} AutoSendPlan
 * @property {number} seq
 * @property {string} draft - the exact composer draft this plan wrote
 * @property {number} rev - the InputState.draftRev at write time
 * @property {number} startedAt - Date.now() at plan creation
 * @property {number} delayMs - review window length
 * @property {boolean} [allowCursorRevSync] - true when MicButton tracks real user interaction events separately
 * @property {boolean} [userInteracted] - set true by MicButton on any user keydown/pointerdown/input in composer
 * @property {number} [settleUntilMs] - initial window (ms) for setDraft(draft) to propagate to useInput()
 */

/**
 * Evaluates one tick of an auto-send plan against the current input state.
 *
 * Cancellation is per-message and interaction-based: the plan fails if the
 * user interacted with the composer, if the composer draft is no longer the
 * text this plan wrote, or (when raw rev tracking is used) if the editor
 * revision advanced since the write.
 *
 * @param {{plan: AutoSendPlan, input: ({draft: string, draftRev: number})|null, nowMs: number}} args
 * @returns {{action: 'wait', leftSec: number} | {action: 'cancel', reason: string} | {action: 'send'}}
 */
export function evaluateAutoSendTick({ plan, input, nowMs }) {
  if (plan.userInteracted) {
    return { action: 'cancel', reason: 'user-interacted' };
  }
  if (input) {
    if (plan.allowCursorRevSync) {
      // During the initial programmatic setDraft() propagation window, useInput()
      // may still hold the pre-final partial for one render frame before updating
      // to plan.draft. Once it matches plan.draft (or after settleUntilMs), any
      // draft mismatch cancels immediately.
      const inSettleWindow = typeof plan.settleUntilMs === 'number' && nowMs <= plan.settleUntilMs;
      if (input.draft !== plan.draft) {
        if (!inSettleWindow) {
          return { action: 'cancel', reason: 'user-interacted' };
        }
      } else if (input.draftRev !== plan.rev) {
        // The text in the composer is identical to what Whisper wrote and no user
        // key/mouse interaction happened — this draftRev bump came from setDraft()
        // settling or an active cursor in the composer. Re-baseline plan.rev.
        plan.rev = input.draftRev;
      }
    } else if (input.draft !== plan.draft || input.draftRev !== plan.rev) {
      return { action: 'cancel', reason: 'user-interacted' };
    }
  }
  const leftMs = plan.startedAt + plan.delayMs - nowMs;
  if (leftMs <= 0) return { action: 'send' };
  return { action: 'wait', leftSec: Math.ceil(leftMs / 1000) };
}
