import { AppError } from '$lib/shared/errors';

interface RateLimitBucket {
	attempts: number;
	resetAt: number;
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 menit
const SWEEP_THRESHOLD = 200;

const buckets = new Map<string, RateLimitBucket>();

export function sweepExpiredRateLimitBuckets(now = Date.now()): number {
	let removed = 0;
	for (const [key, entry] of buckets.entries()) {
		if (now >= entry.resetAt) {
			buckets.delete(key);
			removed++;
		}
	}
	return removed;
}

export function getRateLimitBucketCount(): number {
	return buckets.size;
}

export function assertLoginRateLimit(key: string, now = Date.now()): void {
	const entry = buckets.get(key);
	if (!entry) return;

	if (now >= entry.resetAt) {
		buckets.delete(key);
		return;
	}

	if (entry.attempts >= MAX_ATTEMPTS) {
		const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
		throw new AppError(
			'RATE_LIMITED',
			'Terlalu banyak percobaan login. Silakan coba lagi beberapa saat lagi.',
			{ retryAfterSec }
		);
	}
}

export function recordFailedLoginAttempt(key: string, now = Date.now()): void {
	if (buckets.size >= SWEEP_THRESHOLD) {
		sweepExpiredRateLimitBuckets(now);
	}

	const existing = buckets.get(key);
	if (!existing || now >= existing.resetAt) {
		buckets.set(key, {
			attempts: 1,
			resetAt: now + WINDOW_MS
		});
		return;
	}

	existing.attempts += 1;
}

export function clearLoginRateLimit(key: string): void {
	buckets.delete(key);
}
