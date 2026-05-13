const BACKOFF_MS: readonly number[] = [250, 500, 1000];

export function backoffSchedule(maxRetries = 3): readonly number[] {
	const capped = Math.max(0, Math.min(maxRetries, BACKOFF_MS.length));
	return BACKOFF_MS.slice(0, capped);
}

export function shouldRetry(
	method: string,
	status: number | null,
	attempt: number,
	maxRetries: number,
): boolean {
	if (attempt >= maxRetries) return false;
	if (method.toUpperCase() !== 'GET') return false;
	if (status === null) return true;
	return status >= 500;
}
