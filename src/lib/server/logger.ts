import pino from 'pino';

export const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	redact: {
		paths: [
			'password',
			'passwordHash',
			'accessToken',
			'refreshToken',
			'refreshTokenHash',
			'mfaSecret',
			'req.headers.authorization',
			'req.headers.cookie'
		],
		censor: '[REDACTED]'
	}
});
