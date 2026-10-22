// src/client/icon-proximity.js
// Decides when an animated icon should "play": while the pointer is near it, or
// while the plugin is busy with that icon's job (recording, transcribing, speaking).
// Pure distance/hysteresis logic here is unit-tested; the DOM wiring is in
// icon-motion.js. Hysteresis (enter at 56px, leave beyond 80px) stops the animation
// flickering when the pointer hovers right at the boundary.

export const NEAR_ENTER_PX = 56;
export const NEAR_LEAVE_PX = 80;

/**
 * Next "near" state for one icon.
 * @param {boolean} wasNear
 * @param {number} distancePx - pointer distance to the icon's box (0 = inside it)
 */
export function nearState(wasNear, distancePx) {
  if (!Number.isFinite(distancePx)) return false;
  return wasNear ? distancePx <= NEAR_LEAVE_PX : distancePx <= NEAR_ENTER_PX;
}

/**
 * Distance from a point to a rectangle (0 when inside).
 * @param {{left:number,top:number,right:number,bottom:number}} rect
 * @param {number} x
 * @param {number} y
 */
export function distanceToRect(rect, x, y) {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

/** Whether an icon should currently animate. */
export function isIconLive(near, forced) {
  return Boolean(forced || near);
}
