import { hash, verify } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
	memoryCost: 19456,
	timeCost: 2,
	outputLen: 32,
	parallelism: 1
};

export async function hashPassword(plainPassword: string): Promise<string> {
	return hash(plainPassword, ARGON2_OPTIONS);
}

export async function verifyPassword(
	passwordHash: string,
	plainPassword: string
): Promise<boolean> {
	try {
		return await verify(passwordHash, plainPassword);
	} catch {
		return false;
	}
}
