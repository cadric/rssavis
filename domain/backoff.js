// @ts-check

const MIN_JITTER = 0.8;
const MAX_JITTER = 1.2;
const MAX_EXPONENT = 6;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{consecutiveFailures: number, refreshIntervalMinutes: number, jitter?: number, retryAfterMs?: number}} input
 */
export function calculateBackoffDelayMs(input) {
  const baseDelayMs =
    refreshIntervalMs(input.refreshIntervalMinutes) * 2 ** Math.min(input.consecutiveFailures - 1, MAX_EXPONENT);
  const jitteredDelayMs = Math.round(baseDelayMs * normalizeJitter(input.jitter));
  const retryAfterMs =
    Number.isFinite(input.retryAfterMs) && Number(input.retryAfterMs) > 0 ? Number(input.retryAfterMs) : 0;
  return Math.min(MAX_DELAY_MS, Math.max(jitteredDelayMs, retryAfterMs));
}

/**
 * @param {{consecutiveFailures: number, refreshIntervalMinutes: number, nowMs: number, jitter?: number, retryAfterMs?: number}} input
 */
export function nextBackoffAtMs(input) {
  return input.nowMs + calculateBackoffDelayMs(input);
}

/**
 * @param {number | undefined} value
 */
function normalizeJitter(value) {
  if (value === undefined) return MIN_JITTER + Math.random() * (MAX_JITTER - MIN_JITTER);
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_JITTER, Math.max(MIN_JITTER, value));
}

/**
 * @param {number} minutes
 */
function refreshIntervalMs(minutes) {
  const normalized = Number.isSafeInteger(minutes) && minutes > 0 ? minutes : 30;
  return normalized * 60 * 1000;
}
