const { test } = require('node:test');
const assert = require('node:assert/strict');

async function run(responses, options = {}) {
  const calls = [];
  const { deploy } = await import('../scripts/webstore.mjs');
  const promise = deploy({ token: 'test-token', publisher: 'publisher', item: 'item', version: '1.0.4',
    archive: Buffer.from('zip'), sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      assert.ok(responses.length, 'unexpected API request');
      const body = responses.shift();
      return { ok: !body.httpError, status: body.httpError || 200, json: async () => body };
    }, ...options });
  return { calls, promise };
}

test('release waits for async ZIP processing before publishing for review', async () => {
  const { calls, promise } = await run([{}, { uploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  assert.equal((await promise).state, 'PENDING_REVIEW');
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'GET', 'POST']);
  assert.ok(calls[1].url.includes('/upload/v2/'));
  assert.equal(calls[1].headers['Content-Type'], 'application/zip');
  assert.deepEqual(JSON.parse(calls[3].body), { publishType: 'DEFAULT_PUBLISH' });
});

test('status mode and already submitted versions never mutate the store', async () => {
  for (const statusOnly of [false, true]) {
    const { calls, promise } = await run([{ submittedItemRevisionStatus: {
      state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.4' }],
    } }], { statusOnly });
    await promise;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
  }
});

test('an existing review for another version is never cancelled or replaced', async () => {
  const { calls, promise } = await run([{ submittedItemRevisionStatus: {
    state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.3' }],
  } }]);
  await assert.rejects(promise, /Another submission/);
  assert.equal(calls.length, 1);
});

test('upload failure, timeout, HTTP errors and version mismatch never publish', async () => {
  for (const upload of [{ uploadState: 'FAILED' }, { httpError: 403 },
    { uploadState: 'SUCCEEDED', crxVersion: '9.0.0' }, { uploadState: 'IN_PROGRESS' }]) {
    const { calls, promise } = await run([{}, upload,
      ...Array.from({ length: 24 }, () => ({ lastAsyncUploadState: 'IN_PROGRESS' }))]);
    await assert.rejects(promise);
    assert.equal(calls.some(c => c.url.endsWith(':publish')), false);
  }
});

test('an unexpected publish response does not claim success', async () => {
  const { promise } = await run([{}, { uploadState: 'SUCCEEDED' }, { state: 'REJECTED' }]);
  await assert.rejects(promise, /Unexpected submission/);
});

test('policy notices permit corrected packages to enter the normal store review', async () => {
  for (const notice of [{ warned: true }, { takenDown: true }]) {
    const { calls, promise } = await run([notice, { uploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
    assert.equal((await promise).state, 'PENDING_REVIEW');
    assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'POST']);
    const blocked = await run([notice, { httpError: 403 }]);
    await assert.rejects(blocked.promise, /HTTP 403/);
    assert.equal(blocked.calls.some(c => c.url.endsWith(':publish')), false);
    const active = await run([{ ...notice, submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.3' }] } }]);
    await assert.rejects(active.promise, /Another submission/);
    assert.equal(active.calls.length, 1);
  }
});
