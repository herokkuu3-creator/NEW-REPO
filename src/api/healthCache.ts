const healthCacheInvalidators = new Set<() => void>();

/** Registers a server-local /health cache invalidator and returns its cleanup hook. */
export function registerHealthCacheInvalidator(fn: () => void): () => void {
  healthCacheInvalidators.add(fn);
  return () => {
    healthCacheInvalidators.delete(fn);
  };
}

/** Clears every active /health snapshot cache immediately after account/session changes. */
export function invalidateHealthCache(): void {
  for (const invalidate of healthCacheInvalidators) {
    invalidate();
  }
}
