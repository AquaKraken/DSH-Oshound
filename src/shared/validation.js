// src/shared/validation.js
// All values that cross the client -> host boundary (or that get embedded
// into a child_process argv) MUST pass through here first. Nothing in this
// file builds a shell string; everything is designed to feed argv arrays.

import path from 'node:path';

export class ValidationError extends Error {}

/** A model/voice id may only contain safe filename characters. */
const SAFE_ID = /^[a-zA-Z0-9_.-]+$/;

/**
 * @param {string} id
 * @param {string} kind
 * @returns {string}
 */
export function assertSafeId(id, kind) {
  if (!id || !SAFE_ID.test(id)) {
    throw new ValidationError(`Invalid ${kind} id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Resolves `filename` inside `baseDir` and verifies the result did not
 * escape baseDir via `..`, symlink tricks, or an absolute path override.
 * @param {string} baseDir
 * @param {string} filename
 * @returns {string}
 */
export function safeJoin(baseDir, filename) {
  if (path.isAbsolute(filename)) {
    throw new ValidationError(`Absolute paths are not allowed: ${filename}`);
  }
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, filename);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new ValidationError(`Path traversal detected: ${filename}`);
  }
  return resolved;
}

/**
 * @param {string} url
 * @param {readonly string[]} allowedHosts
 * @returns {string}
 */
export function assertHttpsUrl(url, allowedHosts) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Malformed URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError(`Only https:// downloads are allowed: ${url}`);
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new ValidationError(`Host not in allow-list: ${parsed.hostname}`);
  }
  return url;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {string} name
 * @returns {number}
 */
export function clampNumber(value, min, max, name) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ValidationError(`${name} must be a number`);
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {string} code
 * @param {ReadonlySet<string>} known
 * @returns {string}
 */
export function assertLanguageCode(code, known) {
  if (code !== 'auto' && !known.has(code)) {
    throw new ValidationError(`Unknown language code: ${code}`);
  }
  return code;
}

/** Whitelisted download hosts. Nothing else is ever fetched. */
export const ALLOWED_DOWNLOAD_HOSTS = [
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];
