import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';

if (typeof process.loadEnvFile === 'function') {
	try {
		process.loadEnvFile();
	} catch {
		// ignore
	}
}

const prisma = new PrismaClient();

async function main() {
	const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@itam.local';
	const hasExplicitPassword = Boolean(
		process.env.SEED_ADMIN_PASSWORD && process.env.SEED_ADMIN_PASSWORD.trim().length > 0
	);
	const adminPass = hasExplicitPassword
		? process.env.SEED_ADMIN_PASSWORD.trim()
		: randomBytes(12).toString('base64url');

	const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
	if (!existingAdmin) {
		const secret = new OTPAuth.Secret({ size: 20 });
		const passwordHash = await hash(adminPass, {
			memoryCost: 19456,
			timeCost: 2,
			outputLen: 32,
			parallelism: 1
		});

		const created = await prisma.user.create({
			data: {
				name: 'Administrator ITAM',
				email: adminEmail,
				passwordHash,
				role: 'ADMIN',
				isActive: true,
				mfaSecret: secret.base32
			}
		});

		console.log(`Seeded ADMIN: ${created.email}`);
		if (!hasExplicitPassword) {
			console.log(`Generated One-Time Admin Password: ${adminPass}`);
		}
		console.log(`TOTP Base32 Secret: ${secret.base32}`);
	} else {
		console.log(`Admin ${adminEmail} already exists.`);
	}

	const defaultCategories = [
		{ name: 'Laptop', requiresApproval: true, maintenanceIntervalDays: 180 },
		{ name: 'Proyektor', requiresApproval: false, maintenanceIntervalDays: 180 },
		{ name: 'Aksesoris & Kabel', requiresApproval: false, maintenanceIntervalDays: null }
	];

	for (const cat of defaultCategories) {
		await prisma.category.upsert({
			where: { name: cat.name },
			update: {},
			create: cat
		});
	}

	const defaultLocations = [
		{ name: 'Ruang Seminar A', latitude: -6.2, longitude: 106.8166, radiusM: 100 },
		{ name: 'Gudang IT Pusat', latitude: -6.2005, longitude: 106.817, radiusM: 80 }
	];

	for (const loc of defaultLocations) {
		await prisma.location.upsert({
			where: { name: loc.name },
			update: {},
			create: loc
		});
	}

	console.log('Master data seed completed.');
}

main()
	.catch((e) => {
		console.error(e);
		process.exit(1);
	})
	.finally(async () => {
		await prisma.$disconnect();
	});
