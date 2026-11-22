import * as OTPAuth from 'otpauth';

const ISSUER = 'ITAM';

export function generateTotpSecret(email: string): { secret: string; uri: string } {
	const secret = new OTPAuth.Secret({ size: 20 });
	const totp = new OTPAuth.TOTP({
		issuer: ISSUER,
		label: email,
		algorithm: 'SHA1',
		digits: 6,
		period: 30,
		secret
	});
	return {
		secret: secret.base32,
		uri: totp.toString()
	};
}

export function verifyTotpCode(secretBase32: string, token: string): boolean {
	try {
		const totp = new OTPAuth.TOTP({
			issuer: ISSUER,
			algorithm: 'SHA1',
			digits: 6,
			period: 30,
			secret: OTPAuth.Secret.fromBase32(secretBase32)
		});
		const delta = totp.validate({ token: token.trim(), window: 1 });
		return delta !== null;
	} catch {
		return false;
	}
}
