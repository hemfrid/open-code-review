// SPDX-License-Identifier: Apache-2.0
// Phase 1 seat-relay prototype (see spec-hub-direct-relay-review.md §3.2).
//
// Turns a Claude Code seat credential into a loopback Anthropic Messages endpoint
// so `ocr` (or any Anthropic-protocol client) can spend a subscription seat.
//
//   RELAY_PORT              default 8890 (binds 127.0.0.1 only)
//   RELAY_CREDENTIALS_FILE  path to Claude Code's .credentials.json  (pod mode)
//   RELAY_KEYCHAIN_SERVICE  macOS Keychain service name holding that JSON (laptop mode),
//                           e.g. "Claude Code-credentials"; read with `security`, no shell.
//   RELAY_ALLOW_REFRESH     "1" to refresh near expiry / on 401 and write back to the file.
//                           Default off: on a laptop the refresh token belongs to Claude Code
//                           and rotating it from here could log the user's CLI out.
//   RELAY_UPSTREAM          default https://api.anthropic.com
//
// Logs carry status codes, byte counts and durations only — never headers or bodies.

import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const IDENTITY_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";
export const IDENTITY_BLOCK = Object.freeze({ type: 'text', text: IDENTITY_TEXT });
export const OAUTH_BETA = 'oauth-2025-04-20';
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REJECTED_TOP_LEVEL = ['context_management'];
const HOP_BY_HOP = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection']);
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ── pure helpers (unit-tested) ─────────────────────────────────────────────

/** Claude Code credential blob → {accessToken, refreshToken, expiresAt(ms)}. */
export function parseCredentials(json) {
  const d = typeof json === 'string' ? JSON.parse(json) : json;
  const o = d?.claudeAiOauth;
  if (!o || typeof o.accessToken !== 'string') throw new Error('credential blob has no claudeAiOauth.accessToken');
  return { accessToken: o.accessToken, refreshToken: o.refreshToken ?? null, expiresAt: Number(o.expiresAt) || 0 };
}

export function needsRefresh(expiresAtMs, nowMs = Date.now(), skewMs = REFRESH_SKEW_MS) {
  return expiresAtMs > 0 && expiresAtMs - nowMs < skewMs;
}

function isIdentityBlock(b) {
  return b && typeof b === 'object' && b.type === 'text' && b.text === IDENTITY_TEXT;
}

/** Strip fields the OAuth endpoint rejects; make the identity block the first system block. */
export function fixupBody(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const out = { ...payload };
  for (const f of REJECTED_TOP_LEVEL) delete out[f];
  const sys = out.system;
  if (sys === undefined || sys === null) out.system = [IDENTITY_BLOCK];
  else if (typeof sys === 'string') out.system = [IDENTITY_BLOCK, { type: 'text', text: sys }];
  else if (Array.isArray(sys)) { if (!(sys.length && isIdentityBlock(sys[0]))) out.system = [IDENTITY_BLOCK, ...sys]; }
  return out;
}

/** Merge our beta flag into an existing comma-separated anthropic-beta value. */
export function mergeBeta(existing) {
  const parts = String(existing ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(',');
}

/** Incoming headers → outbound headers for api.anthropic.com. */
export function rewriteHeaders(incoming, accessToken, upstreamHost) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'x-api-key' || key === 'authorization') continue;
    out[key] = v;
  }
  out.authorization = `Bearer ${accessToken}`;
  out['anthropic-beta'] = mergeBeta(incoming['anthropic-beta']);
  out.host = upstreamHost;
  return out;
}

export function filterResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

// ── credential store ───────────────────────────────────────────────────────

class CredentialStore {
  constructor({ file, keychainService, allowRefresh }) {
    this.file = file; this.keychainService = keychainService; this.allowRefresh = allowRefresh;
    this.raw = null; this.creds = null; this.state = 'loading'; this.refreshing = null;
  }
  load() {
    if (!this.file && !this.keychainService) throw new Error('set RELAY_CREDENTIALS_FILE or RELAY_KEYCHAIN_SERVICE');
    const json = this.file
      ? readFileSync(this.file, 'utf8')
      : execFileSync('security', ['find-generic-password', '-s', this.keychainService, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    this.raw = JSON.parse(json);
    this.creds = parseCredentials(this.raw);
    this.state = needsRefresh(this.creds.expiresAt) && !this.allowRefresh ? 'expiring_no_refresh' : 'ready';
    return this;
  }
  async token() {
    if (needsRefresh(this.creds.expiresAt)) {
      if (!this.allowRefresh) {
        if (this.creds.expiresAt <= Date.now()) throw new RelayError(401, 'seat_token_expired', 'Seat access token expired and refresh is disabled; run the Claude CLI once to refresh it.');
      } else await this.refresh();
    }
    return this.creds.accessToken;
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const res = await fetch(TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: this.creds.refreshToken, client_id: CLIENT_ID }),
      });
      if ([400, 401, 403].includes(res.status)) { this.state = 'seat_reauth_required'; throw new RelayError(401, 'seat_reauth_required', 'Seat needs to be reconnected.'); }
      if (!res.ok) throw new RelayError(503, 'refresh_transient', `Token refresh failed upstream (${res.status}).`);
      const data = await res.json();
      this.creds = { accessToken: data.access_token, refreshToken: data.refresh_token || this.creds.refreshToken, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
      this.raw = { ...this.raw, claudeAiOauth: { ...this.raw.claudeAiOauth, accessToken: this.creds.accessToken, refreshToken: this.creds.refreshToken, expiresAt: this.creds.expiresAt } };
      if (this.file) writeFileSync(this.file, JSON.stringify(this.raw), { mode: 0o600 });
      this.state = 'ready';
      log('refresh ok', { expiresInMin: Math.round((this.creds.expiresAt - Date.now()) / 60000) });
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

class RelayError extends Error { constructor(status, type, message) { super(message); this.status = status; this.type = type; } }

function log(msg, fields = {}) { process.stderr.write(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }) + '\n'); }

function sendError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: type === 'seat_reauth_required' || type === 'seat_token_expired' ? 'authentication_error' : 'api_error', message, relay: type } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
}

// ── server ─────────────────────────────────────────────────────────────────

export function createServer(store, { upstream = 'https://api.anthropic.com' } = {}) {
  const up = new URL(upstream);
  const stats = { requests: 0, byStatus: {}, inputTokens: 0, outputTokens: 0 };

  async function forward(req, res, body, attempt) {
    const started = Date.now();
    const token = await store.token();
    const headers = rewriteHeaders(req.headers, token, up.host);
    headers['content-length'] = String(body.length);
    return new Promise((resolve) => {
      const preq = https.request({ protocol: up.protocol, host: up.hostname, port: up.port || 443, method: req.method, path: req.url, headers, timeout: 600_000 }, (pres) => {
        if (pres.statusCode === 401 && attempt === 0 && store.allowRefresh) {
          pres.resume(); pres.on('end', async () => { try { await store.refresh(); resolve(await forward(req, res, body, 1)); } catch (e) { resolve(fail(res, e)); } });
          return;
        }
        stats.requests++; stats.byStatus[pres.statusCode] = (stats.byStatus[pres.statusCode] || 0) + 1;
        res.writeHead(pres.statusCode, filterResponseHeaders(pres.headers));
        let bytes = 0; const isJson = String(pres.headers['content-type'] || '').includes('application/json');
        const chunks = [];
        pres.on('data', (c) => { bytes += c.length; if (isJson) chunks.push(c); res.write(c); });
        pres.on('end', () => {
          res.end();
          if (isJson) { try { const u = JSON.parse(Buffer.concat(chunks).toString('utf8')).usage; if (u) { stats.inputTokens += u.input_tokens || 0; stats.outputTokens += u.output_tokens || 0; } } catch { /* streamed or non-usage body */ } }
          log('relay', { method: req.method, path: req.url, status: pres.statusCode, bytes, ms: Date.now() - started, retryAfter: pres.headers['retry-after'] });
          resolve();
        });
      });
      preq.on('timeout', () => preq.destroy(new Error('upstream timeout')));
      preq.on('error', (e) => { log('upstream error', { message: e.message }); if (!res.headersSent) sendError(res, 502, 'upstream_error', 'Upstream request failed.'); else res.end(); resolve(); });
      preq.end(body);
    });
  }
  function fail(res, e) { if (e instanceof RelayError) sendError(res, e.status, e.type, e.message); else { log('relay error', { message: e.message }); sendError(res, 500, 'relay_error', 'Relay failure.'); } }

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(store.state === 'ready' ? 200 : 503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: store.state === 'ready', seat: store.state, expiresInMin: Math.round((store.creds.expiresAt - Date.now()) / 60000) })); }
      if (req.method === 'GET' && req.url === '/metrics') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(stats)); }
      if (req.method === 'POST' && req.url === '/shutdown') { res.writeHead(200); res.end('bye'); setTimeout(() => process.exit(0), 50); return; }
      if (!req.url.startsWith('/v1/')) return sendError(res, 404, 'not_found', 'Only /v1/* is relayed.');
      let body = await readBody(req);
      if (String(req.headers['content-type'] || '').includes('application/json') && body.length) {
        try { body = Buffer.from(JSON.stringify(fixupBody(JSON.parse(body.toString('utf8'))))); } catch { /* forward as-is */ }
      }
      await forward(req, res, body, 0);
    } catch (e) { fail(res, e); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = new CredentialStore({ file: process.env.RELAY_CREDENTIALS_FILE, keychainService: process.env.RELAY_KEYCHAIN_SERVICE, allowRefresh: process.env.RELAY_ALLOW_REFRESH === '1' }).load();
  const port = Number(process.env.RELAY_PORT || 8890);
  createServer(store, { upstream: process.env.RELAY_UPSTREAM }).listen(port, '127.0.0.1', () => log('listening', { port, seat: store.state, allowRefresh: store.allowRefresh, expiresInMin: Math.round((store.creds.expiresAt - Date.now()) / 60000) }));
}
