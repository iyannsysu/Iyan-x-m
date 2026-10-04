'use strict';

import fs from 'fs';
import path from 'path';
import { jidNormalizedUser, toNumber, jidDecode, proto, isPnUser } from 'baileys';

import { telegram } from '../helper/index.js';
import { injectMessage } from '../helper/inject.js';
import { isNumber } from '../helper/text.js';
import { readSwConfig, pickEmoji } from '../helper/swconfig.js';

/**
 * @param {import('../../index').WAMessageExtra} m
 * @param {import('../../index').WASocketExtra} hisoka
 */
export default async function (m, hisoka) {
	try {
		// Log the message details
		if (process.env.BOT_LOG_MESSAGE === 'true' && m.type !== 'protocolMessage' && !m.isBot) {
			console.log(`\x1b[32m${'—'.repeat(50)}\x1b[39m`);
			console.log(
				`\x1b[36mReceived message from ${
					m.isGroup ? `"${m.pushName}" in "${hisoka.getName(m.from)}"` : m.pushName
				} (${m.type})\x1b[39m`
			);
			const maxLogLength = 200;
			const displayText = m.text.length > maxLogLength ? m.text.slice(0, maxLogLength) + '...' : m.text;
			console.log(`\x1b[36mText: ${displayText}\x1b[39m`);
		}

		// Hanlde Expiration Contextinfo
		if (m.content && m.content.contextInfo && isNumber(m.content.contextInfo.expiration) && isPnUser(m.from)) {
			const expiration = m.content.contextInfo.expiration;
			const ephemeralSettingTimestamp = toNumber(m.content.contextInfo.ephemeralSettingTimestamp);
			const contact = hisoka.contacts.read(m.from) || {};
			hisoka.contacts.write(m.from, { ...contact, ephemeralSettingTimestamp, ephemeralDuration: expiration });
		}

		// Auto-download media yang masuk (opsional via env BOT_AUTODL_MEDIA)
		if (process.env.BOT_AUTODL_MEDIA === 'true' && m.isMedia && !m.status && !m.isBot && !m.key.fromMe) {
			try {
				const buf = await m.downloadMedia();
				const mime = (m.content?.mimetype || '').split(';')[0].trim();
				const extMap = {
					'image/jpeg': 'jpg',
					'image/png': 'png',
					'image/webp': 'webp',
					'image/gif': 'gif',
					'video/mp4': 'mp4',
					'video/3gpp': '3gp',
					'audio/mpeg': 'mp3',
					'audio/ogg': 'ogg',
					'audio/mp4': 'm4a',
					'application/pdf': 'pdf',
				};
				const ext = extMap[mime] || 'bin';
				const d = new Date();
				const pad = n => String(n).padStart(2, '0');
				const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
					d.getHours()
				)}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
				const senderNum = (m.sender || 'unknown').replace(/[^0-9]/g, '') || 'unknown';
				const dir = path.join(process.cwd(), 'downloads');
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, `${stamp}_${senderNum}_${m.key.id}.${ext}`), buf);
			} catch (err) {
				console.error('\x1b[31mAuto-download media gagal:\x1b[39m', err?.message || err);
			}
		}

		// Handle protocol messages
		if (m.message.protocolMessage) {
			const protocolMessage = m.message.protocolMessage;
			const key = protocolMessage.key;
			const type = protocolMessage.type;

			switch (type) {
				case proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING:
				case proto.Message.ProtocolMessage.Type.EPHEMERAL_SYNC_RESPONSE:
					{
						const id = await hisoka.resolveLidToPN(key);
						const contact = hisoka.contacts.read(id) || {};
						hisoka.contacts.write(id, {
							...contact,
							ephemeralSettingTimestamp: toNumber(
								protocolMessage.ephemeralSettingTimestamp || m.message.messageTimestamp
							),
							ephemeralDuration: protocolMessage.ephemeralExpiration,
						});
					}
					break;

				case proto.Message.ProtocolMessage.Type.REVOKE:
					{
						// Anti-delete: teruskan pesan yang dihapus ke owner
						const revokedId = key?.id;
						const orig = revokedId ? hisoka.cacheMsg.get(revokedId) : null;

						if (orig && !orig.key.fromMe) {
							const ownerNumber = (process.env.BOT_NUMBER_OWNER || '')
								.split(',')
								.map(x => x.trim())
								.filter(Boolean)[0];
							if (!ownerNumber) break;

							try {
								const om = await injectMessage(hisoka, orig);
								const sender = await hisoka.resolveLidToPN(orig.key);
								const name = hisoka.getName(sender, true);
								const ts = Number(orig.messageTimestamp) || Date.now() / 1000;
								const when = new Date(ts * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
								const caption = `🗑️ Pesan dihapus oleh ${name} (${when})`;
								const ownerJid = `${ownerNumber}@s.whatsapp.net`;

								if (om.isMedia) {
									const media = await hisoka.downloadMediaMessage(orig);
									const waType = (om.type || '').replace('Message', '');
									const content = {};
									if (waType === 'image') content.image = media;
									else if (waType === 'video') content.video = media;
									else if (waType === 'audio') content.audio = media;
									else if (waType === 'sticker') content.sticker = media;
									else content.document = media;
									if (!content.sticker) content.caption = caption;
									await hisoka.sendMessage(ownerJid, content);
								} else {
									await hisoka.sendMessage(ownerJid, {
										text: `${caption}\n\n${om.text || ''}`.trim(),
									});
								}
							} catch (err) {
								console.error(
									'\x1b[31mGagal meneruskan pesan yang dihapus:\x1b[39m',
									err?.message || err
								);
							}
						}
					}
					break;
			}
		}

		// Handle read receipts and send read status to Telegram
		if (!m.isOwner && m.status && m.content.type !== 0) {
			const statusFrom = jidNormalizedUser(m.participant || m.sender);
			// Simpan ke log status harian (untuk ringkasan jam 23:59)
			try {
				const entries = hisoka.statusLog?.read('entries') || [];
				entries.push({
					from: statusFrom,
					name: hisoka.getName(statusFrom, true),
					time: new Date().toISOString(),
					caption: (m.text || '').slice(0, 200),
					hasMedia: !!m.isMedia,
				});
				hisoka.statusLog?.write('entries', entries.slice(-500));
			} catch (err) {
				console.error('\x1b[31mGagal menyimpan status log:\x1b[39m', err?.message || err);
			}

			const privacySettings = hisoka.settings.read('privacy') || {};
			const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';

			// Config status: baca otomatis & react otomatis (bisa on/off via .swread / .swreact)
			const sw = readSwConfig();

			// Auto-read status (tandai "dibaca")
			if (sw.autoread) {
				await hisoka.sendReceipts([m.key], readType);
			}

			// Status saver: simpan foto/video status ke downloads/status/
			if (m.isMedia && process.env.BOT_SAVE_STATUS !== 'false') {
				try {
					const buf = await m.downloadMedia();
					const mime = (m.content?.mimetype || '').split(';')[0].trim();
					const extMap = {
						'image/jpeg': 'jpg',
						'image/png': 'png',
						'image/webp': 'webp',
						'image/gif': 'gif',
						'video/mp4': 'mp4',
						'video/3gpp': '3gp',
					};
					const ext = extMap[mime] || 'bin';
					const d = new Date();
					const pad = n => String(n).padStart(2, '0');
					const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
						d.getHours()
					)}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
					const senderNum = jidDecode(statusFrom).user.replace(/[^0-9]/g, '') || 'unknown';
					const dir = path.join(process.cwd(), 'downloads', 'status');
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(path.join(dir, `${stamp}_${senderNum}_${m.key.id}.${ext}`), buf);
				} catch (err) {
					console.error('\x1b[31mStatus saver gagal:\x1b[39m', err?.message || err);
				}
			}

			// Auto-react status: custom per kontak (react.json), teks custom (.swreacttext),
			// atau acak dari pool. Toggle: .swreact on/off | mode acak: .swrandom on/off
			if (sw.autoreact) {
				try {
					const reactedIds = hisoka.statusLog?.read('reacted') || [];
					if (!reactedIds.includes(m.key.id)) {
						const senderNum = jidDecode(statusFrom).user.replace(/[^0-9]/g, '');
						// react_text diisi -> react pakai tulisan, bukan emoji.
						// Sanitasi: WA server nolak react multi-baris (error 500), jadi
						// jadikan satu baris dan batasi 30 karakter.
						// Kalau ada | berarti beberapa opsi -> pilih acak.
						const rawOpts = (sw.react_text || '').split('|').map(s => s.replace(/[\r\n\t]+/g, ' ').trim()).filter(Boolean);
						const rawText = rawOpts.length > 1
							? rawOpts[Math.floor(Math.random() * rawOpts.length)]
							: (rawOpts[0] || '');
						const reactText = (rawText.slice(0, 30) || pickEmoji(senderNum, sw));
						if (reactText) {
							await hisoka.sendMessage(
								'status@broadcast',
								{
									react: { key: m.key, text: reactText },
								},
								{
									statusJidList: [jidNormalizedUser(hisoka.user.id), jidNormalizedUser(m.sender)],
								}
							);
							reactedIds.push(m.key.id);
							hisoka.statusLog?.write('reacted', reactedIds.slice(-1000));
						}
					}
				} catch (err) {
					console.error('\x1b[31mGagal mengirim react status:\x1b[39m', err?.message || err);
				}
			}

			// Auto-reply status dengan TEKS (mode "bacaan", via .swreply on/off).
			// Bot kirim pesan teks ke DM yang bikin status, sekaligus tandai dibaca.
			if (sw.autoreply && sw.reply_text) {
				try {
					const repliedIds = hisoka.statusLog?.read('replied') || [];
					if (!repliedIds.includes(m.key.id)) {
						await hisoka.sendMessage(statusFrom, { text: sw.reply_text }, { quoted: m });
						// tandai status dibaca juga
						await hisoka.sendReceipts([m.key], readType);
						repliedIds.push(m.key.id);
						hisoka.statusLog?.write('replied', repliedIds.slice(-1000));
					}
				} catch (err) {
					console.error('\x1b[31mGagal auto-reply status:\x1b[39m', err?.message || err);
				}
			}

			// Teruskan status yang dibaca ke WA sendiri (chat pribadi owner)
			if (process.env.BOT_FORWARD_STATUS_WA !== 'false') {
				try {
					const ownerNumber = (process.env.BOT_NUMBER_OWNER || '')
						.split(',')
						.map(x => x.trim())
						.filter(Boolean)[0];
					if (ownerNumber) {
						const name = hisoka.getName(statusFrom, true);
						const caption =
							`👁️ Status dari ${name}\n📅 ${new Date(toNumber(m.messageTimestamp) * 1000).toLocaleString(
								'id-ID',
								{ timeZone: 'Asia/Jakarta' }
							)}${m.text ? `\n\n${m.text}` : ''}`.trim();
						const ownerJid = `${ownerNumber}@s.whatsapp.net`;
						if (m.isMedia) {
							const media = await m.downloadMedia();
							const waType = (m.type || '').replace('Message', '');
							const content = {};
							if (waType === 'image') content.image = media;
							else if (waType === 'video') content.video = media;
							else if (waType === 'audio') content.audio = media;
							else if (waType === 'sticker') content.sticker = media;
							else content.document = media;
							if (waType !== 'sticker') content.caption = caption;
							await hisoka.sendMessage(ownerJid, content);
						} else {
							await hisoka.sendMessage(ownerJid, { text: caption });
						}
					}
				} catch (err) {
					console.error('\x1b[31mForward status ke WA gagal:\x1b[39m', err?.message || err);
				}
			}

			// Send read status to Telegram
			if (process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_TOKEN) {
				const name = hisoka.getName(statusFrom, true);
				const text = `<b>From :</b> <a href="https://wa.me/${jidDecode(statusFrom).user}">@${name}</a>
<b>Date :</b> ${new Date(toNumber(m.messageTimestamp) * 1000).toLocaleString('en-US', { timeZone: 'Asia/Jakarta' })}
${m.text ? `<b>Caption :</b>\n\n${m.text}` : ''}`.trim();

				if (m.isMedia) {
					const media = await m.downloadMedia();

					await telegram.send(process.env.TELEGRAM_CHAT_ID, media, {
						caption: text,
						type: m.type.replace('Message', ''),
						parse_mode: 'HTML',
					});
				} else {
					await telegram.send(process.env.TELEGRAM_CHAT_ID, text, { type: 'text', parse_mode: 'HTML' });
				}
			}
		}
	} catch (e) {
		console.error(`\x1b[31mError in event handler:\x1b[39m\n`, e);
	}
}
