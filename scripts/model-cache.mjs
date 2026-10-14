export const MODEL_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function modelCacheExpired(mtimeMs, now = Date.now()) {
  return now - mtimeMs >= MODEL_CACHE_TTL_MS;
}
