export function invalidateCache(key) {
  // cache invalidation on write
  return del(key);
}
