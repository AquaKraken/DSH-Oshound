// src/shared/text-filter.js
// Generic literal/regex text-filter mechanism shared by the TTS and STT
// filters (2026-10-06, upgraded in v0.5.1). The safety model is identical for both:
//   * compile guard   — regex rules that fail to compile are dropped at
//                       config-sanitize time, with a report; they never run.
//   * ReDoS heuristic — a quantified group whose content itself contains a
//                       quantifier ((a+)+, (a?)*, (.*)+, …) is structurally
//                       catastrophic; such rules are dropped at sanitize time.
//                       (Documented limitation: overlapping alternations like
//                       (a|a)+ are not detected.)
//   * match cap       — a rule performs at most MAX_RULE_MATCHES substitutions
//                       per job (the scan continues, the substituting stops).
//   * length guard    — on very large texts, regex rules are skipped for that
//                       job (literals still apply), so one giant message can't
//                       wedge the event loop.
// A bad rule disables ONLY itself — it can never crash or freeze the host.
//
// Shape (persisted JSON, normalized by sanitizeFilter):
//   { enabled: boolean, rules: [ { kind: 'literal'|'regex', value, replacement?, ignoreCase? } ] }
// Literal rules have NO regex semantics (a "$1" in a literal stays a "$1");
// regex rules support the usual $1/$& replacement syntax.

/** Max substitutions one regex rule performs per job. */
export const MAX_RULE_MATCHES = 1000;
/** Above this input length, regex rules are skipped for the job (literals still run). */
const MAX_TEXT_FOR_REGEX = 200_000;
/** Max user rules kept. */
const MAX_RULES = 32;

/**
 * @typedef {Object} TextFilterRule
 * @property {'literal'|'regex'} kind
 * @property {string} value
 * @property {string} replacement
 * @property {boolean} [ignoreCase]
 */
/**
 * @typedef {Object} TextFilter
 * @property {boolean} enabled
 * @property {TextFilterRule[]} rules
 */

/** Escapes special regex metacharacters in a literal string. */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a regex rule's pattern: tries Unicode mode ('gu' / 'gui') first, then
 * plain 'g' / 'gi'.
 * @param {string} pattern
 * @param {boolean} [ignoreCase=false]
 * @returns {RegExp|null}
 */
export function compileFilterRegex(pattern, ignoreCase = false) {
  const flagSets = ignoreCase ? ['gui', 'gi'] : ['gu', 'g'];
  for (const flags of flagSets) {
    try {
      return new RegExp(pattern, flags);
    } catch {
      /* try next flag set */
    }
  }
  return null;
}

// The classic catastrophic-backtracking shape: a group containing a quantifier,
// itself followed by a quantifier — (a+)+, (a?)*, (.*)+, ((a)(b))+…
const REDOS_SHAPE_RE = /\((?:[^()\\]|\\.)*?[*+?](?:[^()\\]|\\.)*\)[*+?]/;

/**
 * Pure sanitizer for a text-filter config field (Schema.any() passes
 * everything through, so the caller's sanitizeConfig is the enforcement
 * point). Error messages are prefixed with `field`.
 * @param {unknown} raw
 * @param {{defaultFilter: TextFilter, field: string}} opts
 * @returns {{value: TextFilter, errors: string[]}}
 */
export function sanitizeFilter(raw, { defaultFilter, field = 'filter' }) {
  if (raw === undefined || raw === null) return { value: copyFilter(defaultFilter), errors: [] };
  if (typeof raw === 'boolean') {
    return { value: { enabled: raw, rules: copyFilter(defaultFilter).rules }, errors: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: copyFilter(defaultFilter), errors: [`${field}: expected an object {enabled, rules} or a boolean — using the default filter`] };
  }

  const errors = [];
  let enabled = defaultFilter.enabled;
  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') enabled = raw.enabled;
    else errors.push(`${field}.enabled: expected boolean — using default`);
  }

  let rulesIn;
  if (raw.rules === undefined) rulesIn = null;
  else if (Array.isArray(raw.rules)) rulesIn = raw.rules;
  else {
    errors.push(`${field}.rules: expected an array — using default rules`);
    return { value: { enabled, rules: copyFilter(defaultFilter).rules }, errors };
  }
  if (rulesIn === null) return { value: { enabled, rules: copyFilter(defaultFilter).rules }, errors };

  const rules = [];
  for (let i = 0; i < Math.min(rulesIn.length, MAX_RULES); i++) {
    const r = rulesIn[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push(`${field}.rules[${i}]: expected an object — rule dropped`);
      continue;
    }
    if (typeof r.value !== 'string' || r.value.length === 0) {
      errors.push(`${field}.rules[${i}]: "value" must be a non-empty string — rule dropped`);
      continue;
    }
    const replacement = typeof r.replacement === 'string' ? r.replacement : '';
    let kind = 'literal';
    if (r.kind === 'regex') kind = 'regex';
    else if (r.kind !== 'literal') errors.push(`${field}.rules[${i}]: "kind" must be "literal" or "regex" — using "literal"`);

    const ignoreCase = r.ignoreCase === true;

    if (kind === 'regex') {
      if (!compileFilterRegex(r.value, ignoreCase)) {
        errors.push(`${field}.rules[${i}]: invalid regex "${r.value}" — rule disabled`);
        continue;
      }
      if (REDOS_SHAPE_RE.test(r.value)) {
        errors.push(`${field}.rules[${i}]: regex "${r.value}" has a catastrophic-backtracking shape — rule disabled`);
        continue;
      }
    }
    const normalized = { kind, value: r.value, replacement };
    if (ignoreCase) normalized.ignoreCase = true;
    rules.push(normalized);
  }
  if (rulesIn.length > MAX_RULES) {
    errors.push(`${field}.rules: maximum ${MAX_RULES} rules — the rest were dropped`);
  }
  return { value: { enabled, rules }, errors };
}

/** @param {TextFilter} f @returns {TextFilter} a fresh deep copy */
export function copyFilter(f) {
  return { enabled: f.enabled, rules: f.rules.map((r) => ({ ...r })) };
}

/**
 * Pure application of a sanitized filter. Never throws (a malformed rule is
 * skipped, the text passes through for it).
 * @param {string} text
 * @param {TextFilter|unknown} filter
 * @returns {string}
 */
export function applyFilter(text, filter) {
  const input = String(text ?? '');
  if (!filter || typeof filter !== 'object') return input;
  if (filter.enabled === false) return input;
  if (!Array.isArray(filter.rules) || filter.rules.length === 0) return input;

  let out = input;
  for (const rule of filter.rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (typeof rule.value !== 'string' || rule.value.length === 0) continue;
    const replacement = typeof rule.replacement === 'string' ? rule.replacement : '';
    const ignoreCase = rule.ignoreCase === true;

    if (rule.kind === 'regex') {
      if (out.length > MAX_TEXT_FOR_REGEX) continue; // length guard
      const re = compileFilterRegex(rule.value, ignoreCase);
      if (!re) continue; // sanitized already; stay defensive
      let n = 0;
      out = out.replace(re, (m) => {
        if (n++ >= MAX_RULE_MATCHES) return m; // match cap: stop substituting
        return replacement;
      });
    } else if (ignoreCase) {
      const re = compileFilterRegex(escapeRegExp(rule.value), true);
      if (!re) continue;
      out = out.replace(re, () => replacement);
    } else {
      // Literal: split/join — no regex semantics, no escape surprises.
      out = out.split(rule.value).join(replacement);
    }
  }
  return out;
}
