import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { prisma } from '../src/lib/server/db';
import { can, assertCan, type PolicyUser } from '../src/lib/server/policy';
import { isValidAssetStatusTransition } from '../src/lib/shared/enums';
import { hashPassword } from '../src/lib/server/auth/password';
import { generateTotpSecret } from '../src/lib/server/auth/totp';
import {
	loginUser,
	refreshUserSession,
	logoutUserSession,
	revokeSessionByAdmin,
	resolveAuthenticatedSession
} from '../src/lib/server/auth/service';
import {
	clearLoginRateLimit,
	getRateLimitBucketCount,
	recordFailedLoginAttempt,
	sweepExpiredRateLimitBuckets
} from '../src/lib/server/auth/rateLimit';
import {
	 signAccessToken,
	 verifyAccessToken,
	 getAccessSecret,
	 ACCESSTOKEN_COOKIE,
	 REFRESHTOKEN_COOKIE
} from '../src/lib/server/auth/tokens';
import { SignJWT } from 'jose';
import { GET as healthHandler } from '../src/routes/api/v1/health/+server';
import { handle } from '../src/hooks.server';

describe('M0: Fondasi — Unit & Integrasi Database + Auth + Policy', () => {
	const adminUser: PolicyUser = { id: 'u-admin', role: 'ADMIN', isActive: true };
	const officerUser: PolicyUser = { id: 'u-officer', role: 'OFFICER', isActive: true };
	const borrowerUser: PolicyUser = { id: 'u-borrower', role: 'BORROWER', isActive: true };
	const inactiveAdmin: PolicyUser = { id: 'u-inactive', role: 'ADMIN', isActive: false };

	beforeAll(async () => {
		await prisma.$connect();
	});

	afterAll(async () => {
		await prisma.$disconnect();
	});

	describe('1. Kebijakan Otorisasi Terpusat can(user, action, resource) (Bagian 3.2)', () => {
		it('menolak user null atau tidak aktif untuk semua aksi', () => {
			expect(can(null, 'asset:read')).toBe(false);
			expect(can(inactiveAdmin, 'master:manage')).toBe(false);
			expect(() => assertCan(null, 'asset:read')).toThrowError(/Sesi login tidak valid/);
		});

		it('mengizinkan semua role aktif membaca info barang (asset:read)', () => {
			expect(can(adminUser, 'asset:read')).toBe(true);
			expect(can(officerUser, 'asset:read')).toBe(true);
			expect(can(borrowerUser, 'asset:read')).toBe(true);
		});

		it('membatasi pengelolaan master data, persetujuan, tutup darurat shift, status LOST/RETIRED, audit log, dan cabut sesi hanya untuk ADMIN', () => {
			const adminOnlyActions = [
				'master:manage',
				'loan:approve',
				'shift:force-close',
				'shift:read_all',
				'ticket:manage',
				'asset:set_terminal_status',
				'risk:read',
				'audit:read',
				'map:read',
				'report:read',
				'session:revoke'
			] as const;

			for (const action of adminOnlyActions) {
				expect(can(adminUser, action)).toBe(true);
				expect(can(officerUser, action)).toBe(false);
				expect(can(borrowerUser, action)).toBe(false);
			}
		});

		it('mengatur hak peminjaman & pengembalian sesuai role dan kepemilikan', () => {
			// BORROWER hanya boleh meminjam dan mengembalikan milik sendiri
			expect(can(borrowerUser, 'loan:create', { borrowerId: borrowerUser.id })).toBe(true);
			expect(can(borrowerUser, 'loan:create', { borrowerId: 'other-user' })).toBe(false);

			expect(can(borrowerUser, 'loan:return', { borrowerId: borrowerUser.id })).toBe(true);
			expect(can(borrowerUser, 'loan:return', { borrowerId: 'other-user' })).toBe(false);

			// OFFICER & ADMIN boleh memproses pengembalian siapa saja
			expect(can(officerUser, 'loan:return', { borrowerId: 'other-user' })).toBe(true);
			expect(can(adminUser, 'loan:return', { borrowerId: 'other-user' })).toBe(true);
		});

		it('mengatur hak shift (buka/tutup sendiri vs tutup darurat) dan pembuatan tiket perbaikan', () => {
			expect(can(adminUser, 'shift:manage')).toBe(true);
			expect(can(officerUser, 'shift:manage')).toBe(true);
			expect(can(borrowerUser, 'shift:manage')).toBe(false);

			// Matriks can() untuk shift:force-close (tutup shift milik petugas lain / tutup darurat)
			expect(can(adminUser, 'shift:force-close', { userId: officerUser.id })).toBe(true);
			expect(can(officerUser, 'shift:force-close', { userId: officerUser.id })).toBe(false);
			expect(can(officerUser, 'shift:force-close', { userId: 'other-officer' })).toBe(false);
			expect(can(borrowerUser, 'shift:force-close', { userId: officerUser.id })).toBe(false);
			expect(can(inactiveAdmin, 'shift:force-close', { userId: officerUser.id })).toBe(false);
			expect(can(null, 'shift:force-close', { userId: officerUser.id })).toBe(false);

			expect(can(adminUser, 'ticket:create')).toBe(true);
			expect(can(officerUser, 'ticket:create')).toBe(true);
			expect(can(borrowerUser, 'ticket:create')).toBe(false);
		});
	});

	describe('2. Mesin Status Barang (Bagian 5.3)', () => {
		it('mengizinkan transisi valid dan menolak transisi di luar tabel', () => {
			expect(isValidAssetStatusTransition('AVAILABLE', 'BORROWED')).toBe(true);
			expect(isValidAssetStatusTransition('AVAILABLE', 'PENDING_APPROVAL')).toBe(true);
			expect(isValidAssetStatusTransition('BORROWED', 'DAMAGED')).toBe(true);
			expect(isValidAssetStatusTransition('DAMAGED', 'IN_MAINTENANCE')).toBe(true);
			expect(isValidAssetStatusTransition('IN_MAINTENANCE', 'RETIRED')).toBe(true);

			// Transisi terlarang
			expect(isValidAssetStatusTransition('RETIRED', 'AVAILABLE')).toBe(false);
			expect(isValidAssetStatusTransition('BORROWED', 'IN_MAINTENANCE')).toBe(false);
			expect(isValidAssetStatusTransition('LOST', 'BORROWED')).toBe(false);
		});
	});

	describe('3. Constraint SQL Database PostgreSQL (Bagian 5.1 & M0 Penerimaan)', () => {
		let testUserId: string;
		let testCategoryId: string;
		let testAssetId: string;

		beforeAll(async () => {
			const suffix = randomUUID().slice(0, 8);
			const user = await prisma.user.create({
				data: {
					name: 'DB Constraint Tester',
					email: `dbtest-${suffix}@example.com`,
					passwordHash: await hashPassword('Password123!'),
					role: 'OFFICER'
				}
			});
			testUserId = user.id;

			const category = await prisma.category.create({
				data: {
					name: `Kategori Uji ${suffix}`,
					requiresApproval: false
				}
			});
			testCategoryId = category.id;

			const asset = await prisma.asset.create({
				data: {
					code: `AST-${suffix}`,
					qrToken: `qr-${randomUUID()}`,
					name: 'Laptop Uji Constraint',
					categoryId: testCategoryId,
					status: 'AVAILABLE'
				}
			});
			testAssetId = asset.id;
		});

		it('Trigger audit_log_no_update menolak UPDATE dan DELETE pada AuditLog (BR-13)', async () => {
			const log = await prisma.auditLog.create({
				data: {
					actorId: testUserId,
					action: 'TEST_IMMUTABLE_LOG',
					entityType: 'Asset',
					entityId: testAssetId,
					after: { test: true }
				}
			});

			await expect(
				prisma.auditLog.update({
					where: { id: log.id },
					data: { action: 'TAMPERED_ACTION' }
				})
			).rejects.toThrowError(/AuditLog bersifat append-only/);

			await expect(
				prisma.auditLog.delete({
					where: { id: log.id }
				})
			).rejects.toThrowError(/AuditLog bersifat append-only/);
		});

		it('Unique partial index one_active_loan_per_asset menolak dua LoanItem aktif untuk satu barang (BR-02)', async () => {
			const loan1 = await prisma.loan.create({
				data: {
					borrowerId: testUserId,
					createdById: testUserId,
					purpose: 'Seminar 1',
					expectedReturnAt: new Date(Date.now() + 86400_000),
					status: 'ACTIVE'
				}
			});

			const activeItem1 = await prisma.loanItem.create({
				data: {
					loanId: loan1.id,
					assetId: testAssetId,
					returnedAt: null
				}
			});

			const loan2 = await prisma.loan.create({
				data: {
					borrowerId: testUserId,
					createdById: testUserId,
					purpose: 'Seminar 2 Paralel',
					expectedReturnAt: new Date(Date.now() + 86400_000),
					status: 'ACTIVE'
				}
			});

			// Percobaan kedua meminjam barang yang sama saat returnedAt masih NULL wajib ditolak oleh PostgreSQL
			await expect(
				prisma.loanItem.create({
					data: {
						loanId: loan2.id,
						assetId: testAssetId,
						returnedAt: null
					}
				})
			).rejects.toThrow();

			// Setelah peminjaman pertama dikembalikan (returnedAt terisi), barang bisa dipinjam kembali
			await prisma.loanItem.update({
				where: { id: activeItem1.id },
				data: { returnedAt: new Date(), returnCondition: 'NORMAL' }
			});

			const activeItem2 = await prisma.loanItem.create({
				data: {
					loanId: loan2.id,
					assetId: testAssetId,
					returnedAt: null
				}
			});
			expect(activeItem2.id).toBeDefined();
		});

		it('CHECK constraint koordinat pada Evidence menolak latitude/longitude di luar batas wajar', async () => {
			await expect(
				prisma.evidence.create({
					data: {
						purpose: 'CHECKOUT',
						imageKey: 'evidence/invalid-lat.jpg',
						userId: testUserId,
						takenAtDevice: new Date(),
						gpsAvailable: true,
						latitude: 95.5, // tidak valid (> 90)
						longitude: 106.8
					}
				})
			).rejects.toThrow();

			await expect(
				prisma.evidence.create({
					data: {
						purpose: 'CHECKOUT',
						imageKey: 'evidence/invalid-lng.jpg',
						userId: testUserId,
						takenAtDevice: new Date(),
						gpsAvailable: true,
						latitude: -6.2,
						longitude: 195.0 // tidak valid (> 180)
					}
				})
			).rejects.toThrow();
		});
	});

	describe('4. Layanan Autentikasi, TOTP Admin, Rotasi Token, Cabut Sesi, & Health Check', () => {
		let adminEmail: string;
		let adminTotpSecret: string;
		let borrowerEmail: string;
		const plainPassword = 'CorrectHorseBatteryStaple!99';

		beforeAll(async () => {
			const suffix = randomUUID().slice(0, 8);
			adminEmail = `admin-${suffix}@example.com`;
			borrowerEmail = `borrower-${suffix}@example.com`;

			const totp = generateTotpSecret(adminEmail);
			adminTotpSecret = totp.secret;

			await prisma.user.create({
				data: {
					name: 'Admin Utama',
					email: adminEmail,
					passwordHash: await hashPassword(plainPassword),
					role: 'ADMIN',
					mfaSecret: adminTotpSecret
				}
			});

			await prisma.user.create({
				data: {
					name: 'Peminjam Lapangan',
					email: borrowerEmail,
					passwordHash: await hashPassword(plainPassword),
					role: 'BORROWER'
				}
			});
		});

		it('Endpoint /api/v1/health melaporkan status ok dan koneksi database aktif', async () => {
			const response = await healthHandler({} as never);
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.status).toBe('ok');
			expect(body.database).toBe('connected');
		});

		it('Login peminjam berhasil, merotasi refresh token, dan menulis AuditLog transaksional', async () => {
			const loginResult = await loginUser({
				email: borrowerEmail,
				password: plainPassword,
				deviceInfo: 'Vitest Android Client',
				ip: '127.0.0.1'
			});

			expect(loginResult.accessToken).toBeTruthy();
			expect(loginResult.refreshToken).toBeTruthy();
			expect(loginResult.user.role).toBe('BORROWER');

			// Verifikasi sesi aktif
			const resolved = await resolveAuthenticatedSession(loginResult.accessToken);
			expect(resolved?.user.email).toBe(borrowerEmail);

			// Rotasi refresh token
			const refreshed = await refreshUserSession({
				refreshToken: loginResult.refreshToken,
				ip: '127.0.0.1'
			});
			expect(refreshed.refreshToken).not.toBe(loginResult.refreshToken);

			// Refresh token lama tidak boleh bisa dipakai lagi
			await expect(
				refreshUserSession({
					refreshToken: loginResult.refreshToken
				})
			).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

			// Logout mencabut sesi
			await logoutUserSession({
				sessionId: refreshed.sessionId,
				actorId: refreshed.user.id
			});

			const afterLogout = await resolveAuthenticatedSession(refreshed.accessToken);
			expect(afterLogout).toBeNull();
		});

		it('Klaim atomik refreshUserSession mencegah balapan rotasi token paralel menimpa token pemenang (#3)', async () => {
			const loginResult = await loginUser({
				email: borrowerEmail,
				password: plainPassword,
				deviceInfo: 'Parallel Refresh Race Test',
				ip: '127.0.0.1'
			});

			// Jalankan 5 panggilan refreshUserSession paralel dengan refreshToken yang sama
			const parallelResults = await Promise.allSettled(
				Array.from({ length: 5 }, (_, idx) =>
					refreshUserSession({
						refreshToken: loginResult.refreshToken,
						deviceInfo: `Parallel Caller #${idx + 1}`,
						ip: '127.0.0.1'
					})
				)
			);

			const fulfilled = parallelResults.filter(
				(r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof refreshUserSession>>> =>
					r.status === 'fulfilled'
			);
			const rejected = parallelResults.filter(
				(r): r is PromiseRejectedResult => r.status === 'rejected'
			);

			// Tepat 1 panggilan berhasil mengklaim rotasi token; 4 lainnya ditolak UNAUTHENTICATED
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(4);
			for (const rej of rejected) {
				expect(rej.reason).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
			}

			// Refresh token milik pemenang tidak tertimpa dan masih valid untuk rotasi berikutnya
			const winnerToken = fulfilled[0].value.refreshToken;
			const nextRefresh = await refreshUserSession({
				refreshToken: winnerToken,
				ip: '127.0.0.1'
			});
			expect(nextRefresh.sessionId).toBe(loginResult.sessionId);
			expect(nextRefresh.refreshToken).not.toBe(winnerToken);

			await logoutUserSession({
				sessionId: nextRefresh.sessionId,
				actorId: nextRefresh.user.id
			});
		});

		it('Auto-refresh sesi cookie di hooks.server.ts merotasi token saat access token kedaluwarsa, menangani request paralel tanpa saling menggagalkan, dan menjaga flag cookie (#5)', async () => {
			const loginResult = await loginUser({
				email: borrowerEmail,
				password: plainPassword,
				deviceInfo: 'Web Admin Cookie Refresh Test',
				ip: '127.0.0.1'
			});

			// Buat access token yang sudah kedaluwarsa untuk sesi tersebut
			const expiredAccessToken = await signAccessToken(
				{
					sub: loginResult.user.id,
					sid: loginResult.sessionId,
					role: loginResult.user.role,
					email: loginResult.user.email,
					name: loginResult.user.name
				},
				{ expiresInSec: -60 }
			);

			function buildMockHookEvent(cookiesIn: Record<string, string>) {
				const setCalls: Array<{
					name: string;
					value: string;
					opts: Record<string, unknown>;
				}> = [];
				const event = {
					url: new URL('http://localhost:3000/admin/assets'),
					request: new Request('http://localhost:3000/admin/assets', {
						method: 'GET',
						headers: { 'user-agent': 'Vitest Web Admin Browser' }
					}),
					cookies: {
						get: (name: string) => cookiesIn[name],
						set: (name: string, value: string, opts: Record<string, unknown>) => {
							setCalls.push({ name, value, opts });
						}
					},
					locals: {
						requestId: '',
						user: null as PolicyUser | null,
						sessionId: null as string | null
					},
					getClientAddress: () => '127.0.0.1'
				};
				return { event, setCalls };
			}

			// 1. Jalankan 5 request paralel di hooks.server.ts dengan access token kedaluwarsa & cookie refresh token yang sama
			const parallelHooks = await Promise.all(
				Array.from({ length: 5 }, async () => {
					const { event, setCalls } = buildMockHookEvent({
						[ACCESSTOKEN_COOKIE]: expiredAccessToken,
						[REFRESHTOKEN_COOKIE]: loginResult.refreshToken
					});
					const response = await handle({
						event: event as never,
						resolve: async () => new Response('ok', { status: 200 })
					});
					return { event, setCalls, status: response.status };
				})
			);

			// Semua 5 request paralel harus berhasil terautentikasi tanpa saling menggagalkan
			const rotatedRefreshTokens = new Set<string>();
			for (const res of parallelHooks) {
				expect(res.status).toBe(200);
				expect(res.event.locals.user?.id).toBe(loginResult.user.id);
				expect(res.event.locals.sessionId).toBe(loginResult.sessionId);

				const accessCookie = res.setCalls.find((c) => c.name === ACCESSTOKEN_COOKIE);
				const refreshCookie = res.setCalls.find((c) => c.name === REFRESHTOKEN_COOKIE);
				expect(accessCookie).toBeDefined();
				expect(refreshCookie).toBeDefined();

				// Pastikan flag keamanan cookie tidak dilemahkan
				expect(accessCookie?.opts).toMatchObject({
					path: '/',
					httpOnly: true,
					sameSite: 'lax',
					secure: false,
					maxAge: 15 * 60
				});
				expect(refreshCookie?.opts).toMatchObject({
					path: '/',
					httpOnly: true,
					sameSite: 'lax',
					secure: false,
					maxAge: 30 * 24 * 60 * 60
				});

				if (refreshCookie) {
					rotatedRefreshTokens.add(refreshCookie.value);
				}
			}

			// Single-flight coalescing memastikan ke-5 request paralel menerima refresh token hasil rotasi yang sama
			expect(rotatedRefreshTokens.size).toBe(1);

			// Hanya 1 baris AuditLog SESSION_REFRESHED yang ditulis ke database
			const refreshLogs = await prisma.auditLog.count({
				where: {
					entityType: 'Session',
					entityId: loginResult.sessionId,
					action: 'SESSION_REFRESHED'
				}
			});
			expect(refreshLogs).toBe(1);

			// 2. Request susulan dalam masa toleransi singkat (sebelum browser menerapkan Set-Cookie) tetap berhasil
			const lateArrival = buildMockHookEvent({
				[REFRESHTOKEN_COOKIE]: loginResult.refreshToken
			});
			await handle({
				event: lateArrival.event as never,
				resolve: async () => new Response('ok', { status: 200 })
			});
			expect(lateArrival.event.locals.user?.id).toBe(loginResult.user.id);

			// 3. Setelah logout, masa toleransi langsung dihapus dan request dengan cookie lama tidak lagi diautentikasi
			await logoutUserSession({
				sessionId: loginResult.sessionId,
				actorId: loginResult.user.id
			});

			const afterLogoutHook = buildMockHookEvent({
				[REFRESHTOKEN_COOKIE]: loginResult.refreshToken
			});
			await handle({
				event: afterLogoutHook.event as never,
				resolve: async () => new Response('ok', { status: 200 })
			});
			expect(afterLogoutHook.event.locals.user).toBeNull();
		});

		it('Wajib TOTP untuk ADMIN yang memiliki mfaSecret dan mencabut sesi pengguna secara instan (BR-19 & Bagian 12)', async () => {
			// Login admin tanpa TOTP harus ditolak
			await expect(
				loginUser({
					email: adminEmail,
					password: plainPassword,
					ip: '127.0.0.2'
				})
			).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

			// Buat kode TOTP valid
			const validTotp = new OTPAuth.TOTP({
				issuer: 'ITAM',
				algorithm: 'SHA1',
				digits: 6,
				period: 30,
				secret: OTPAuth.Secret.fromBase32(adminTotpSecret)
			}).generate();

			const adminSession = await loginUser({
				email: adminEmail,
				password: plainPassword,
				totpCode: validTotp,
				ip: '127.0.0.2'
			});
			expect(adminSession.user.role).toBe('ADMIN');

			// Login borrower di perangkat yang kemudian dicabut oleh Admin
			const targetLogin = await loginUser({
				email: borrowerEmail,
				password: plainPassword,
				deviceInfo: 'HP Hilang'
			});

			expect(await resolveAuthenticatedSession(targetLogin.accessToken)).not.toBeNull();

			// Non-admin ditolak mencabut sesi
			await expect(
				revokeSessionByAdmin({
					actor: targetLogin.user,
					targetSessionId: targetLogin.sessionId
				})
			).rejects.toMatchObject({ code: 'FORBIDDEN' });

			// Admin mencabut sesi
			await revokeSessionByAdmin({
				actor: adminSession.user,
				targetSessionId: targetLogin.sessionId
			});

			// Permintaan berikutnya dengan access token lama langsung ditolak
			expect(await resolveAuthenticatedSession(targetLogin.accessToken)).toBeNull();
		});

		it('Menerapkan rate limit login (RATE_LIMITED) setelah 5 percobaan gagal berturut-turut', async () => {
			const ip = '10.99.99.99';
			const key = `${borrowerEmail}:${ip}`;
			clearLoginRateLimit(key);

			for (let i = 0; i < 5; i++) {
				await expect(
					loginUser({
						email: borrowerEmail,
						password: 'WrongPassword!',
						ip
					})
				).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
			}

			await expect(
				loginUser({
					email: borrowerEmail,
					password: plainPassword,
					ip
				})
			).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });

			clearLoginRateLimit(key);
		});

		it('Menyapu otomatis entri rateLimit yang sudah kedaluwarsa saat jumlah bucket melampaui ambang batas', () => {
			const t0 = 1_700_000_000_000;
			for (let i = 0; i < 210; i++) {
				recordFailedLoginAttempt(`expired-${i}@example.com:10.0.0.1`, t0);
			}
			expect(getRateLimitBucketCount()).toBeGreaterThanOrEqual(200);

			// 16 menit kemudian (> 15 menit window), percobaan baru memicu sapu otomatis atas 210 entri kedaluwarsa
			const tAfterWindow = t0 + 16 * 60 * 1000;
			recordFailedLoginAttempt('fresh-user@example.com:10.0.0.2', tAfterWindow);

			expect(getRateLimitBucketCount()).toBe(1);
			sweepExpiredRateLimitBuckets(tAfterWindow + 16 * 60 * 1000);
			expect(getRateLimitBucketCount()).toBe(0);
		});

		it('Menolak JWT_ACCESS_SECRET yang kosong atau terlalu pendek (< 32 karakter)', async () => {
			const originalSecret = process.env.JWT_ACCESS_SECRET;
			try {
				process.env.JWT_ACCESS_SECRET = '';
				expect(() => getAccessSecret()).toThrowError(/wajib diatur.*tidak boleh kosong/i);
				await expect(
					signAccessToken({
						sub: 'u-1',
						sid: 's-1',
						role: 'ADMIN',
						email: 'a@b.com',
						name: 'Admin'
					})
				).rejects.toThrowError(/wajib diatur.*tidak boleh kosong/i);

				process.env.JWT_ACCESS_SECRET = 'terlalu-pendek-123';
				expect(() => getAccessSecret()).toThrowError(/terlalu pendek.*minimal 32 karakter/i);
				await expect(
					signAccessToken({
						sub: 'u-1',
						sid: 's-1',
						role: 'ADMIN',
						email: 'a@b.com',
						name: 'Admin'
					})
				).rejects.toThrowError(/terlalu pendek.*minimal 32 karakter/i);
			} finally {
				process.env.JWT_ACCESS_SECRET = originalSecret;
			}
		});

		it('Menolak token kedaluwarsa, token dengan signature salah, dan token dengan role tidak sah', async () => {
			// 1. Token kedaluwarsa (expiresInSec negatif)
			const expiredToken = await signAccessToken(
				{
					sub: 'u-1',
					sid: 's-1',
					role: 'BORROWER',
					email: 'b@example.com',
					name: 'Borrower'
				},
				{ expiresInSec: -10 }
			);
			expect(await verifyAccessToken(expiredToken)).toBeNull();

			// 2. Token dengan signature salah (ditandatangani dengan secret berbeda)
			const wrongSecret = new TextEncoder().encode(
				'wrong-secret-that-is-at-least-32-characters-long!!'
			);
			const wrongSigToken = await new SignJWT({
				sid: 's-1',
				role: 'BORROWER',
				email: 'b@example.com',
				name: 'Borrower'
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setSubject('u-1')
				.setIssuedAt()
				.setExpirationTime('15m')
				.sign(wrongSecret);
			expect(await verifyAccessToken(wrongSigToken)).toBeNull();

			// 3. Token dengan role tidak sah (bukan ADMIN | OFFICER | BORROWER)
			await expect(
				signAccessToken({
					sub: 'u-1',
					sid: 's-1',
					role: 'SUPERUSER' as never,
					email: 'b@example.com',
					name: 'Invalid Role'
				})
			).rejects.toThrowError(/Role tidak sah/);

			const forgedInvalidRoleToken = await new SignJWT({
				sid: 's-1',
				role: 'SUPERUSER',
				email: 'b@example.com',
				name: 'Forged Role'
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setSubject('u-1')
				.setIssuedAt()
				.setExpirationTime('15m')
				.sign(getAccessSecret());
			expect(await verifyAccessToken(forgedInvalidRoleToken)).toBeNull();
		});
	});
});
