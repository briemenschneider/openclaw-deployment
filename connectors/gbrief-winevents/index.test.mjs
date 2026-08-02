import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDigest, clampHours } from './index.mjs';

test('clampHours defaults to 24', () => {
  assert.equal(clampHours(undefined), 24);
  assert.equal(clampHours(null), 24);
});

test('clampHours bounds the range', () => {
  assert.equal(clampHours(0), 1);
  assert.equal(clampHours(500), 168);
  assert.equal(clampHours(48), 48);
});

test('fetchDigest returns parsed body on success', async () => {
  const stub = async (url, opts) => {
    assert.match(url, /hours=12/);
    assert.equal(opts.headers['X-Brief-Token'], 'tok');
    return { ok: true, status: 200, json: async () => ({ events: [], windowHours: 12 }) };
  };
  const r = await fetchDigest('http://c:18790', 'tok', 12, stub);
  assert.equal(r.ok, undefined);
  assert.equal(r.windowHours, 12);
});

test('fetchDigest returns a structured error on non-200', async () => {
  const stub = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
});

test('fetchDigest returns a structured error when the collector is unreachable', async () => {
  const stub = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});
