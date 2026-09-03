// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixupBody, IDENTITY_BLOCK, IDENTITY_TEXT, mergeBeta, needsRefresh, parseCredentials, rewriteHeaders, filterResponseHeaders, OAUTH_BETA, authorized, presentedToken, DEFAULT_MAX_BODY_BYTES } from './relay.mjs';

test('authorized: no configured token allows any loopback caller; configured token must match exactly', () => {
  assert.equal(authorized({}, null), true);
  assert.equal(authorized({ 'x-api-key': 'abc' }, 'abc'), true);
  assert.equal(authorized({ authorization: 'Bearer abc' }, 'abc'), true);
  assert.equal(authorized({ 'x-api-key': 'abd' }, 'abc'), false);
  assert.equal(authorized({ 'x-api-key': 'ab' }, 'abc'), false);
  assert.equal(authorized({}, 'abc'), false);
  assert.equal(presentedToken({ 'x-api-key': 'k', authorization: 'Bearer b' }), 'k', 'x-api-key wins, as in seat-proxy');
  assert.equal(DEFAULT_MAX_BODY_BYTES, 32 * 1024 * 1024);
});

test('parseCredentials reads the Claude Code blob and rejects other shapes', () => {
  const c = parseCredentials({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 123 } });
  assert.deepEqual(c, { accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
  assert.throws(() => parseCredentials({}), /claudeAiOauth/);
});

test('needsRefresh is true inside the skew window and false otherwise', () => {
  const now = 1_000_000;
  assert.equal(needsRefresh(now + 10 * 60_000, now), false);
  assert.equal(needsRefresh(now + 60_000, now), true);
  assert.equal(needsRefresh(now - 1, now), true);
  assert.equal(needsRefresh(0, now), false, 'unknown expiry never forces a refresh');
});

test('fixupBody strips rejected fields and prepends the identity block once', () => {
  assert.deepEqual(fixupBody({ model: 'm', context_management: {} }).system, [IDENTITY_BLOCK]);
  assert.equal('context_management' in fixupBody({ context_management: {} }), false);
  assert.deepEqual(fixupBody({ system: 'hi' }).system, [IDENTITY_BLOCK, { type: 'text', text: 'hi' }]);
  const ocrStyle = [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }];
  const out = fixupBody({ system: ocrStyle }).system;
  assert.equal(out.length, 2);
  assert.equal(out[0].text, IDENTITY_TEXT);
  assert.deepEqual(out[1], ocrStyle[0], 'cache_control on the caller block survives');
  assert.deepEqual(fixupBody({ system: out }).system, out, 'idempotent');
  const untouched = { tools: [{ name: 't' }], tool_choice: { type: 'auto' }, thinking: { type: 'disabled' }, max_tokens: 5 };
  const fixed = fixupBody({ ...untouched, system: [] });
  for (const k of Object.keys(untouched)) assert.deepEqual(fixed[k], untouched[k]);
  assert.equal(fixupBody('not json'), 'not json');
});

test('mergeBeta adds the oauth flag without duplicating', () => {
  assert.equal(mergeBeta(undefined), OAUTH_BETA);
  assert.equal(mergeBeta('prompt-caching-2024-07-31'), `prompt-caching-2024-07-31,${OAUTH_BETA}`);
  assert.equal(mergeBeta(`${OAUTH_BETA}, x`), `${OAUTH_BETA},x`);
});

test('rewriteHeaders replaces auth, drops hop-by-hop, keeps anthropic-version', () => {
  const h = rewriteHeaders({ 'x-api-key': 'local', authorization: 'Bearer nope', host: '127.0.0.1:8890', 'content-length': '9', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, 'TOKEN', 'api.anthropic.com');
  assert.equal(h.authorization, 'Bearer TOKEN');
  assert.equal(h['x-api-key'], undefined);
  assert.equal(h['content-length'], undefined);
  assert.equal(h.host, 'api.anthropic.com');
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['anthropic-beta'], OAUTH_BETA);
});

test('filterResponseHeaders passes retry-after and rate-limit headers, drops hop-by-hop', () => {
  const h = filterResponseHeaders({ 'retry-after': '30', 'anthropic-ratelimit-unified-remaining': '5', connection: 'close', 'transfer-encoding': 'chunked' });
  assert.deepEqual(h, { 'retry-after': '30', 'anthropic-ratelimit-unified-remaining': '5' });
});
