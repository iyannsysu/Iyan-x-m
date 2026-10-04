import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import makeWASocket, {
	delay,
	useMultiFileAuthState,
	DisconnectReason,
	Browsers,
	makeCacheableSignalKeyStore,
	areJidsSameUser,
	isLidUser,
	fetchLatestBaileysVersion,
} from 'baileys';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Jangan biarkan satu error (mis. upload media gagal) membunuh seluruh bot.
// Cukup log, bot tetap jalan.
process.on('uncaughtException', err => {
	console.error('\x1b[31m[guard] uncaughtException:\x1b[39m', err?.message || err);
});
process.on('unhandledRejection', reason => {
	console.error('\x1b[31m[guard] unhandledRejection:\x1b[39m', reason?.message || reason);
});

import JSONDB from './db/json.js';
import { injectClient } from './helper/inject.js';
import { telegram } from './helper/index.js';
import { getCaseName } from './helper/utils.js';

const sessionDir = (global.sessionDir = path.join(process.cwd(), 'sessions', process.env.BOT_SESSION_NAME || 'iyan'));

// Validate BOT_MAX_RETRIES
if (process.env.BOT_MAX_RETRIES && isNaN(Number(process.env.BOT_MAX_RETRIES))) {
	console.warn('\x1b[33mWarning: BOT_MAX_RETRIES is not a valid number. Disabling max retry limit.\x1b[39m');
	delete process.env.BOT_MAX_RETRIES;
}

// Initialize logger
const logger = pino({ level: process.env.BOT_LOGGER_LEVEL || 'silent' }).child({ class: 'Aja Sendiri' });

let reconnectCount = 0;

// Proxy: sandbox hanya mengizinkan outbound via egress proxy.
// WebSocket Baileys harus lewat HttpsProxyAgent. Untuk fetch, JANGAN pakai
// undici ProxyAgent sebagai dispatcher — tidak kompatibel dengan fetch bawaan
// Node (UND_ERR_INVALID_ARG / fetch failed). Fetch bawaan Node sudah otomatis
// pakai proxy dari env (NODE_USE_ENV_PROXY=1), jadi biarkan default.
const PROXY_URL = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const wsAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : undefined;

/**
 * Kirim ringkasan status harian ke Telegram, lalu kosongkan log.
 * @param {import('../index.js').WASocketExtra} hisoka
 */
async function sendDailySummary(hisoka) {
	if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

	const entries = hisoka.statusLog?.read('entries') || [];
	if (!entries.length) return;

	let text = `📊 Ringkasan status hari ini (${entries.length} status)\n\n`;
	for (const e of entries) {
		const jam = new Date(e.time).toLocaleTimeString('id-ID', {
			timeZone: 'Asia/Jakarta',
			hour: '2-digit',
			minute: '2-digit',
		});
		const cap = e.caption || (e.hasMedia ? '[media]' : '-');
		text += `• ${e.name} (${jam}): ${cap}\n`;
	}

	try {
		await telegram.send(process.env.TELEGRAM_CHAT_ID, text, { type: 'text' });
		hisoka.statusLog.write('entries', []);
		console.info('\x1b[32mRingkasan status harian terkirim.\x1b[39m');
	} catch (err) {
		console.error('\x1b[31mGagal mengirim ringkasan status harian:\x1b[39m', err?.message || err);
	}
}

/**
 * Jadwalkan ringkasan harian setiap jam 23:59 WIB via setTimeout berantai.
 * Perhitungan memakai offset WIB (UTC+7, tanpa DST) tanpa peduli TZ server.
 * @param {import('../index.js').WASocketExtra} hisoka
 */
function scheduleDailySummary(hisoka) {
	const scheduleNext = () => {
		const now = new Date();
		// Konversi ke jam dinding WIB
		const wibNow = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
		const target = new Date(wibNow);
		target.setHours(23, 59, 0, 0);
		if (target <= wibNow) target.setDate(target.getDate() + 1);
		const delayMs = Math.max(target.getTime() - wibNow.getTime(), 1000);

		setTimeout(async () => {
			await sendDailySummary(hisoka);
			scheduleNext();
		}, delayMs);
	};

	scheduleNext();
}

async function main() {
	console.log(`\x1b[36mStarting with session directory: ${sessionDir}\x1b[39m`);

	// Check if the script is already running
	if (reconnectCount > 0) {
		console.warn(`\x1b[33mReconnecting... Attempt ${reconnectCount}\x1b[39m`);
	}

	const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
	const { version, isLatest } = await fetchLatestBaileysVersion();

	console.info(
		`\x1b[32mUsing WhatsApp version: ${version.join('.')}${
			isLatest ? '' : ' (latest version is recommended)'
		}\x1b[39m`
	);

	// Initialize caches and databases
	/**
	 * @type {Map<string, import('baileys').WAMessage>}
	 */
	const cacheMsg = new Map();

	/**
	 * @type {import('../index.js').Groups}
	 */
	const groups = new JSONDB('groups', sessionDir);

	/**
	 * @type {import('../index.js').Contacts}
	 */
	const contacts = new JSONDB('contacts', sessionDir);

	/**
	 * @type {import('./db/json.js').default}
	 */
	const settings = new JSONDB('settings', sessionDir);

	/**
	 * Log status harian (untuk ringkasan jam 23:59 WIB)
	 * @type {import('./db/json.js').default}
	 */
	const statusLog = new JSONDB('statuslog', sessionDir);

	/**
	 * * Initialize the connection with WhatsApp
	 * * This includes setting up the auth state, browser info, and other configurations.
	 * @type {import('../index.js').WASocketExtra}
	 */
	const hisoka = injectClient(
		makeWASocket({
			version,
			logger,
			agent: wsAgent,
			auth: {
				creds: state.creds,
				keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }).child({ class: 'Session Logger' })),
			},
			browser: Browsers.appropriate('Chrome'),
			generateHighQualityLinkPreview: true,
			syncFullHistory: true,
			cachedGroupMetadata: async jid => {
				const group = groups.read(jid);
				if (!group || !group.participants.length) {
					const metadata = await hisoka.groupMetadata(jid);
					groups.write(jid, metadata);
					return metadata;
				}
				return group;
			},
			getMessage: async key => {
				const msg = cacheMsg.get(key.id);

				return msg?.message || '';
			},
		}),
		cacheMsg,
		contacts,
		groups,
		settings
	);

	hisoka.statusLog = statusLog;

	// Auth with pairing code if provided
	const pairingNumber = process.env.BOT_NUMBER_PAIR || false;
	if (pairingNumber && !hisoka.authState.creds?.registered) {
		try {
			let phoneNumber = pairingNumber.replace(/[^0-9]/g, '');

			// tunggu handshake noise selesai dulu (fix 401: kirim pairing terlalu cepat setelah socket dibuat)
			await delay(20000);
			let code = await hisoka.requestPairingCode(phoneNumber);
			console.log(`\x1b[32mYour Pairing Code : ${code?.match(/.{1,4}/g)?.join('-') || code}\x1b[39m`);
		} catch (err) {
			console.error('\x1b[31mFailed to request pairing code. Please check your pairing number.\x1b[39m');
			console.error(err);
			process.exit(1);
		}
	}

	hisoka.ev.on('creds.update', saveCreds);

	hisoka.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
		if (qr && !pairingNumber) {
			qrcode.generate(qr, { small: true }, code => {
				console.log('\x1b[36mScan this QR code to connect:\x1b[39m\n');
				console.log(code);
			});
		}

		if (connection === 'open') {
			lastDisconnect = 0; // Reset lastDisconnect on successful connection
			console.log(`\x1b[32mConnected successfully! ${JSON.stringify(hisoka.user, null, 2)}\x1b[39m`);

			// fetch all groups for caching
			// console.info('\x1b[36mFetching group metadata...\x1b[39m');
			// const groupList = await hisoka.groupFetchAllParticipating();
			// for (const group in groupList) {
			// 	groups.write(group, groupList[group]);
			// }

			// fetch privacy settings
			console.info('\x1b[36mFetching privacy settings...\x1b[39m');
			const privacySettings = await hisoka.fetchPrivacySettings();
			settings.write('privacy', privacySettings);

			// Load All Commands
			console.info('\x1b[36mLoading command handlers...\x1b[39m');
			const commands = await getCaseName(path.join(process.cwd(), 'src', 'handler', 'message.js'));
			hisoka.loadedCommands = commands;
			console.info(`\x1b[32mLoaded ${commands.length} command handlers.\x1b[39m`);

			// Jadwalkan ringkasan status harian (23:59 WIB -> Telegram)
			scheduleDailySummary(hisoka);
		}

		if (connection === 'close') {
			const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode || 0;

			switch (statusCode) {
				case DisconnectReason.loggedOut:
				case DisconnectReason.forbidden:
					console.error('\x1b[31mSession expired or logged out. Please re-authenticate.\x1b[39m');

					// Clean up session files without deleting .env files
					const dirContents = await fs.promises.readdir(sessionDir);
					for (const file of dirContents) {
						if (file.startsWith('.env')) continue;
						await fs.promises.rm(path.join(sessionDir, file), { recursive: true, force: true });
					}

					process.exit(1);
					break;

				case DisconnectReason.restartRequired:
					console.info('\x1b[33mRestart required. Reconnecting...\x1b[39m');
					await main();
					break;

				default:
					if (Number(process.env.BOT_MAX_RETRIES) && reconnectCount >= Number(process.env.BOT_MAX_RETRIES)) {
						console.error(`\x1b[31mMax retries reached (${process.env.BOT_MAX_RETRIES}). Exiting...\x1b[39m`);
						process.exit(1);
					}

					console.error(
						`\x1b[31mConnection closed unexpectedly. Reconnecting in ${Math.min(
							5 * reconnectCount,
							30
						)} seconds...\x1b[39m`,
						JSON.stringify(lastDisconnect, null, 2)
					);
					reconnectCount++;

					await delay(Math.min(5 * reconnectCount, 30) * 1000);
					main();
					break;
			}
		}
	});

	hisoka.ev.on('contacts.upsert', async contactsData => {
		await Promise.all(
			contactsData.map(async contact => {
				const jid = await hisoka.resolveLidToPN({ remoteJid: contact.id, remoteJidAlt: contact.phoneNumber });
				const existingContact = (await contacts.read(jid)) || {};
				contacts.write(
					jid,
					Object.assign(
						isLidUser(contact.id) ? { id: jid, lid: contact.id } : {},
						{ isContact: true },
						existingContact,
						contact
					)
				);
			})
		);
	});

	hisoka.ev.on('contacts.update', async contactsData => {
		await Promise.all(
			contactsData.map(async contact => {
				const jid = await hisoka.resolveLidToPN({ remoteJid: contact.id, remoteJidAlt: contact.phoneNumber });
				const existingContact = (await contacts.read(jid)) || {};
				contacts.write(
					jid,
					Object.assign(isLidUser(contact.id) ? { id: jid, lid: contact.id } : {}, existingContact, contact)
				);
			})
		);
	});

	hisoka.ev.on('groups.upsert', async groupsData => {
		await Promise.all(
			groupsData.map(group => {
				const groupId = group.id;
				const existingGroup = groups.read(groupId) || {};

				return groups.write(groupId, { ...existingGroup, ...group });
			})
		);
	});

	hisoka.ev.on('groups.update', async groupsData => {
		await Promise.all(
			groupsData.map(group => {
				const groupId = group.id;
				const existingGroup = groups.read(groupId) || {};

				return groups.write(groupId, { ...existingGroup, ...group });
			})
		);
	});

	hisoka.ev.on('group-participants.update', ({ id, author, participants, action }) => {
		/**
		 * @type {import('baileys').GroupMetadata}
		 */
		const existingGroup = groups.read(id) || {};

		switch (action) {
			case 'add':
				existingGroup.participants = [...(existingGroup.participants || []), ...participants];
				break;
			case 'remove':
			case 'modify':
				existingGroup.participants = (existingGroup.participants || []).filter(p => {
					const existId = p.phoneNumber || p.id;
					return !participants.some(removed => areJidsSameUser(existId, removed.phoneNumber || removed.id));
				});
				break;
			case 'promote':
			case 'demote':
				existingGroup.participants = (existingGroup.participants || []).map(p => {
					const existId = p.phoneNumber || p.id;
					if (participants.some(modified => areJidsSameUser(existId, modified.phoneNumber || modified.id))) {
						return { ...p, admin: action === 'promote' ? 'admin' : null };
					}
					return p;
				});
				break;
			default:
				console.warn(`\x1b[33mUnknown group action: ${action}\x1b[39m`);
				return;
		}

		groups.write(id, existingGroup);
	});

	hisoka.ev.on('messages.upsert', async messagesUpsert => {
		// Save every incoming message to cache
		for (const message of messagesUpsert.messages) {
			if (message.key && message.message) {
				if (!hisoka.cacheMsg.has(message.key.id)) {
					hisoka.cacheMsg.set(message.key.id, message);
				}
			}

			const messageHandler = await import('./handler/message.js');
			await messageHandler.default({ ...messagesUpsert, message }, hisoka);
		}
	});
}

main().catch(err => {
	console.error('\x1b[31mAn error occurred:\x1b[39m');
	console.error(err);

	// Optionally, you can exit the process if an error occurs
	// Uncomment the line below if you want to exit on error
	// process.exit(1);
});
