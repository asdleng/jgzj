function createAsyncTtlCache(options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries) || 128);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const entries = new Map();

  function trim() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  }

  async function get(key, ttlMs, loader) {
    if (typeof loader !== 'function') {
      throw new TypeError('cache loader must be a function');
    }

    const cached = entries.get(key);
    if (cached?.promise) {
      return cached.promise;
    }
    if (cached && cached.expiresAt > now()) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.value;
    }
    if (cached) {
      entries.delete(key);
    }

    const promise = Promise.resolve().then(loader);
    entries.set(key, { promise });

    try {
      const value = await promise;
      const active = entries.get(key);
      if (active?.promise === promise) {
        entries.delete(key);
        const normalizedTtlMs = Math.max(0, Number(ttlMs) || 0);
        if (normalizedTtlMs > 0) {
          entries.set(key, {
            value,
            expiresAt: now() + normalizedTtlMs
          });
          trim();
        }
      }
      return value;
    } catch (error) {
      if (entries.get(key)?.promise === promise) {
        entries.delete(key);
      }
      throw error;
    }
  }

  return {
    clear() {
      entries.clear();
    },
    get,
    get size() {
      return entries.size;
    }
  };
}

module.exports = { createAsyncTtlCache };
