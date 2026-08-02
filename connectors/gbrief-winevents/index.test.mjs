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
  assert.doesNotMatch(r.error, /timed out/);
});

test('fetchDigest returns a malformed-response error when a 200 body fails to parse as JSON', async () => {
  const stub = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token o in JSON at position 0'); },
  });
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /malformed/);
  assert.doesNotMatch(r.error, /unreachable/);
});

test('fetchDigest returns a structured error when the parsed body is null', async () => {
  const stub = async () => ({ ok: true, status: 200, json: async () => null });
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected payload type/);
  assert.match(r.error, /null/);
});

test('fetchDigest returns a structured error when the parsed body is an array', async () => {
  const stub = async () => ({ ok: true, status: 200, json: async () => ([1, 2, 3]) });
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected payload type/);
  assert.match(r.error, /array/);
});

test('fetchDigest survives a non-Error thrown value', async () => {
  // `throw 'boom'` is legal JS and some transports reject with strings or
  // plain objects. Reading .message off null/undefined throws, which would
  // escape the catch and turn a structured error into an MCP protocol error -
  // breaking the shim's never-throw contract.
  for (const thrown of ['boom', null, undefined, 42, { code: 'ENOTFOUND' }]) {
    const stub = async () => { throw thrown; };
    const r = await fetchDigest('http://c:18791', 'tok', 24, stub);
    assert.equal(r.ok, false, `thrown value ${String(thrown)} should yield a structured error`);
    assert.match(r.error, /unreachable/);
  }
});

test('fetchDigest includes the thrown string in the error when it is not an Error', async () => {
  const stub = async () => { throw 'connect ECONNREFUSED bare string'; };
  const r = await fetchDigest('http://c:18791', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /connect ECONNREFUSED bare string/);
});

test('fetchDigest reports a timeout distinctly from an unreachable collector', async () => {
  const stub = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.doesNotMatch(r.error, /unreachable/);
});
