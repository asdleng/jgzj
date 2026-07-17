const assert = require('node:assert/strict');
const test = require('node:test');

const { createAsyncTtlCache } = require('./async-ttl-cache');

test('caches values until the TTL expires', async () => {
  let now = 1000;
  let loads = 0;
  const cache = createAsyncTtlCache({ now: () => now });
  const load = async () => ++loads;

  assert.equal(await cache.get('key', 100, load), 1);
  assert.equal(await cache.get('key', 100, load), 1);
  assert.equal(loads, 1);

  now = 1101;
  assert.equal(await cache.get('key', 100, load), 2);
  assert.equal(loads, 2);
});

test('coalesces concurrent loads for the same key', async () => {
  let resolveLoad;
  let loads = 0;
  const cache = createAsyncTtlCache();
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => {
      resolveLoad = resolve;
    });
  };

  const first = cache.get('key', 1000, loader);
  const second = cache.get('key', 1000, loader);
  await Promise.resolve();
  assert.equal(loads, 1);

  resolveLoad('value');
  assert.deepEqual(await Promise.all([first, second]), ['value', 'value']);
});

test('does not cache loader failures', async () => {
  let loads = 0;
  const cache = createAsyncTtlCache();
  const loader = async () => {
    loads += 1;
    if (loads === 1) throw new Error('temporary failure');
    return 'ok';
  };

  await assert.rejects(cache.get('key', 1000, loader), /temporary failure/);
  assert.equal(await cache.get('key', 1000, loader), 'ok');
  assert.equal(loads, 2);
});
