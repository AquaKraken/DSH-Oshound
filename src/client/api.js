// src/client/api.js
// Same-origin fetch wrapper for the O-Sound host routes (the webServer
// prefix registered by src/dsh/adapter.js).

const PREFIX = '/dsh-osound/api';

function fail(r, fallback) {
  return r
    .clone()
    .json()
    .then((j) => new Error(j?.error ?? fallback))
    .catch(() => new Error(fallback));
}

export const api = {
  fetch(path, init) {
    return fetch(PREFIX + path, init);
  },

  async getJson(path) {
    const r = await this.fetch(path);
    if (!r.ok) throw await fail(r, `GET ${path} failed: HTTP ${r.status}`);
    return r.json();
  },

  async postJson(path, body) {
    const r = await this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw await fail(r, `POST ${path} failed: HTTP ${r.status}`);
    return r.json();
  },

  /** Raw binary body (STT upload). @returns {Promise<object>} parsed JSON response. */
  async postRaw(path, buf, query = '') {
    const r = await this.fetch(path + (query ? `?${query}` : ''), { method: 'POST', body: buf });
    if (!r.ok) throw await fail(r, `POST ${path} failed: HTTP ${r.status}`);
    return r.json();
  },

  /** POSTs JSON and returns the RAW binary body (e.g. a Piper WAV preview). @returns {Promise<ArrayBuffer>} */
  async postBytes(path, body) {
    const r = await this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw await fail(r, `POST ${path} failed: HTTP ${r.status}`);
    return r.arrayBuffer();
  },
};
