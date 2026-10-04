'use strict';

import { isJidGroup, jidNormalizedUser, jidDecode, generateWAMessageFromContent } from 'baileys';
import { exec, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { glitch } from '../helper/text.js';

import { msToTime } from '../helper/utils.js';
import { downloadTikTok, cleanupTikTok } from '../helper/tiktok.js';
import { downloadYouTubeAudio, cleanupYouTubeAudio } from '../helper/youtube.js';
import { searchPinterest, downloadPinterestPin, cleanupPinterest } from '../helper/pinterest.js';
import { searchPixiv, downloadPixivArtwork, cleanupPixiv } from '../helper/pixiv.js';
import { searchHentaidad, downloadHentaidadGallery, cleanupHentaidad } from '../helper/hentaidad.js';
import { searchHanime, getHanimeStreams, pickHanimeStream, downloadHanimeStream, shortNum } from '../helper/hanime.js';
import { getStickerPack, downloadStickerPack, cleanupStickerPack } from '../helper/stickerpack.js';
import { getTelegramPack, downloadTelegramPack, cleanupTelegramPack } from '../helper/tgsticker.js';
import { readSwConfig, writeSwConfig, extractEmojis } from '../helper/swconfig.js';
import { telegram } from '../helper/index.js';

const execFileAsync = util.promisify(execFile);

/** Cache hasil pencarian .hanime per pengirim: sender -> Array hasil searchHanime */
const hanimeSearchCache = new Map();
const bokepSearchCache = new Map();
const cosplay18SearchCache = new Map();
const manhwaSearchCache = new Map(); // sender -> hasil search
const manhwaChapterCache = new Map(); // sender -> { manga, chapters }

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MENU_BANNER = path.join(PROJECT_ROOT, 'assets/menu-adawong.jpg');
const GC_JSON = path.join(PROJECT_ROOT, 'gc.json');

/** Baca link invite grup WA untuk menu (diset via .setgc). */
function readGcLink() {
	try {
		const j = JSON.parse(fs.readFileSync(GC_JSON, 'utf8'));
		if (j && typeof j.invite === 'string' && /chat\.whatsapp\.com\//i.test(j.invite)) return j.invite.trim();
	} catch { /* belum diset */ }
	return '';
}

/**
 * Unduh video TikTok dari URL lalu kirim ke chat.
 * @param {import('../../index').WASocketExtra} hisoka
 * @param {import('../../index').WAMessageExtra} m
 * @param {string} text teks yang mengandung URL TikTok
 */
async function handleTikTokDownload(hisoka, m, text) {
	const match = (text || '').match(/https?:\/\/[^\s]*tiktok\.com[^\s]*/i);
	if (!match) {
		await m.reply('Kirim link TikTok yang valid. Contoh: .tt <link>');
		return;
	}

	await m.reply('⏳ Mengambil TikTok...');

	const { getTikTok, downloadUrl, downloadTikTok: ytFallback } = await import('../helper/tiktok.js');
	let info = null;
	try {
		info = await getTikTok(match[0]);
	} catch (err) {
		await m.reply('❌ ' + (err?.message || 'Gagal.') + '\n_Coba lagi sebentar..._');
		return;
	}

	const caption = `🎵 *${info.title || 'TikTok'}*\n👤 ${info.author}`;

	// FOTO SLIDESHOW -> kirim sebagai album
	if (info.type === 'images') {
		await m.reply(`🖼️ ${info.count} foto ditemukan, mengunduh...`);
		try {
			const bufs = await Promise.all(info.images.map(u => downloadUrl(u, 20)));
			const tmpFiles = bufs.map((b, i) => {
				const fp = `/tmp/tt_img_${Date.now()}_${i}.jpg`;
				fs.writeFileSync(fp, b);
				return fp;
			});
			// caption di foto pertama via sendAlbum modif: kirim manual
			await sendAlbum(hisoka, m.from, tmpFiles);
			await m.reply(caption);
			for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
		} catch (err) {
			await m.reply('❌ ' + (err?.message || 'Gagal mengunduh foto.'));
		}
		return;
	}

	// VIDEO HD
	await m.reply('🎬 Mengunduh video HD...');
	try {
		const data = await downloadUrl(info.videoUrl, 100);
		if (data.length > 100 * 1024 * 1024) {
			await hisoka.sendMessage(m.from, { document: data, fileName: 'tiktok_hd.mp4', caption }, { quoted: m });
		} else {
			await hisoka.sendMessage(m.from, { video: data, caption }, { quoted: m });
		}
	} catch (err) {
		// fallback ke yt-dlp
		await m.reply('⚠️ Coba cara lain...');
		let file = '';
		try {
			const { downloadTikTok, cleanupTikTok } = await import('../helper/tiktok.js');
			file = await downloadTikTok(match[0]);
			const size = fs.statSync(file).size;
			const data = fs.readFileSync(file);
			if (size > 100 * 1024 * 1024) {
				await hisoka.sendMessage(m.from, { document: data, fileName: path.basename(file), caption }, { quoted: m });
			} else {
				await hisoka.sendMessage(m.from, { video: data, caption }, { quoted: m });
			}
			cleanupTikTok(file);
		} catch (err2) {
			if (file) { try { fs.unlinkSync(file); } catch {} }
			await m.reply('❌ ' + (err2?.message || 'Gagal mengunduh video.'));
		}
	}
}

/**
 * Kirim beberapa gambar sebagai SATU album WhatsApp.
 * Caranya: kirim dulu pesan albumMessage (pengumuman: "N gambar akan datang"),
 * baru kirim semua gambar berbarengan. Client WA lalu menampilkannya
 * sebagai satu grup album, bukan pesan satu-satu.
 * @param {import('../../index').WASocketExtra} hisoka
 * @param {string} jid tujuan
 * @param {string[]} files path file gambar
 */
async function sendAlbum(hisoka, jid, files) {
	const n = files.length;
	if (!n) return;
	if (n === 1) {
		await hisoka.sendMessage(jid, { image: fs.readFileSync(files[0]) });
		return;
	}

	// 1. Pengumuman album
	try {
		const albumMsg = generateWAMessageFromContent(
			jid,
			{ albumMessage: { expectedImageCount: n, expectedVideoCount: 0 } },
			{}
		);
		await hisoka.relayMessage(jid, albumMsg.message, { messageId: albumMsg.key.id });
	} catch (err) {
		console.error('\x1b[33mPengumuman album gagal, lanjut kirim biasa:\x1b[39m', err?.message || err);
	}

	// 2. Semua gambar berbarengan
	const results = await Promise.allSettled(
		files.map(f => hisoka.sendMessage(jid, { image: fs.readFileSync(f) }))
	);
	const failed = results.filter(r => r.status === 'rejected').length;
	if (failed) {
		console.error(`\x1b[33msendAlbum: ${failed}/${n} gambar gagal terkirim\x1b[39m`);
	}
}

/**
 * Buat stiker webp 512x512 dari pesan quoted (gambar / video pendek).
 * @param {import('../../index').WASocketExtra} hisoka
 * @param {import('../../index').WAMessageExtra} m
 */
async function handleSticker(hisoka, m) {
	if (!m.isQuoted || !m.quoted?.isMedia) {
		await m.reply('Balas (reply) pesan berisi gambar atau video dulu.');
		return;
	}

	let media;
	try {
		media = await m.quoted.downloadMedia();
	} catch {
		await m.reply('Gagal mengunduh media.');
		return;
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
	const input = path.join(tmpDir, 'input');
	const output = path.join(tmpDir, 'sticker.webp');
	fs.writeFileSync(input, media);

	try {
		await execFileAsync(
			'/usr/bin/ffmpeg',
			[
				'-y',
				'-i',
				input,
				'-vf',
				'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
				'-vcodec',
				'libwebp',
				'-qscale',
				'75',
				'-preset',
				'default',
				'-loop',
				'0',
				'-an',
				'-vsync',
				'0',
				output,
			],
			{ timeout: 120000 }
		);

		await hisoka.sendMessage(m.from, { sticker: fs.readFileSync(output) }, { quoted: m });
	} catch {
		await m.reply('Gagal membuat stiker.');
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/**
 * @param {import('baileys').BaileysEventMap['messages.upsert'] & { message: import('baileys').WAMessage }} message
 * @param {import('../../index').WASocketExtra} hisoka
 */
export default async function ({ message, type: messagesType }, hisoka) {
	try {
		const { injectMessage } = await import('../helper/inject.js');

		/**
		 * @type {import('../../index').WAMessageExtra}
		 */
		const m = await injectMessage(hisoka, message);

		// Check if the message is empty or malformed
		if (!m || !m.message) {
			console.warn('\x1b[33mReceived an empty message. Skipping...\x1b[39m\n', m);
			return;
		}

		/** Listen Event */
		const { default: listenEvent } = await import('./event.js');
		await listenEvent(m, hisoka);
		/** End Listen Event */

		const quoted = m.isMedia ? m : m.isQuoted ? m.quoted : m;

		const text = m.text;
		const query = m.query || quoted.query;

		if (!m.message) return;
		if (!m.key) return;
		if (m.isBot) return; // Skip if the message is from a bot

		/* Command Handling */
		if (messagesType === 'append') return; // Skip command handling for appended messages
		if (m.age > 60 * 10) return; // Skip messages older than 10 minutes

		// Auto-reply: hanya untuk non-owner di chat pribadi (bukan grup/status/bot)
		if (!m.isOwner && !m.key.fromMe && m.isPrivate && !m.status && !m.isBot && m.text) {
			try {
				const raw = fs.readFileSync(path.join(process.cwd(), 'autoreply.json'), 'utf-8');
				const rules = JSON.parse(raw || '{}');
				const lower = m.text.toLowerCase();
				for (const keyword of Object.keys(rules)) {
					if (keyword && lower.includes(keyword.toLowerCase())) {
						await m.reply(rules[keyword]);
						return;
					}
				}
			} catch {
				// autoreply.json tidak ada / rusak -> abaikan
			}
		}

		// Anti view-once: teruskan foto/video sekali-lihat ke owner agar bisa dibuka ulang
		{
			const raw = message.message || {};
			const isViewOnce = !!(raw.viewOnceMessage || raw.viewOnceMessageV2 || raw.viewOnceMessageV2Extension);
			if (isViewOnce && !m.key.fromMe && !m.status && m.isMedia) {
				try {
					const ownerNumber = (process.env.BOT_NUMBER_OWNER || '')
						.split(',')
						.map(x => x.trim())
						.filter(Boolean)[0];
					if (ownerNumber) {
						const media = await m.downloadMedia();
						const waType = (m.type || '').replace('Message', '');
						const content = {};
						if (waType === 'image') content.image = media;
						else if (waType === 'video') content.video = media;
						else if (waType === 'audio') content.audio = media;
						else content.document = media;
						content.caption = `👁️ View-once dari ${m.pushName}`;
						await hisoka.sendMessage(`${ownerNumber}@s.whatsapp.net`, content);
					}
				} catch (err) {
					console.error('\x1b[31mAnti view-once gagal:\x1b[39m', err?.message || err);
				}
			}
		}

		// Pantau kontak penting: teruskan pesan ke Telegram (daftar di watch.json)
		if (
			!m.isOwner &&
			!m.key.fromMe &&
			!m.status &&
			!m.isBot &&
			process.env.TELEGRAM_CHAT_ID &&
			process.env.TELEGRAM_TOKEN
		) {
			try {
				const watchCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'watch.json'), 'utf-8') || '{}');
				const numbers = (watchCfg.numbers || []).map(n => String(n).replace(/[^0-9]/g, '')).filter(Boolean);
				const senderNum = jidDecode(jidNormalizedUser(m.sender)).user.replace(/[^0-9]/g, '');
				if (numbers.includes(senderNum)) {
					const name = hisoka.getName(m.sender, true);
					const text =
						`<b>👀 Pantauan</b> dari <a href="https://wa.me/${senderNum}">${name}</a>\n<b>Tanggal:</b> ${new Date(
							Number(m.messageTimestamp) * 1000
						).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}${m.text ? `\n\n${m.text}` : ''}`.trim();
					let sent = false;
					if (m.isMedia && watchCfg.forward_media !== false) {
						try {
							const media = await m.downloadMedia();
							await telegram.send(process.env.TELEGRAM_CHAT_ID, media, {
								caption: text,
								type: m.type.replace('Message', ''),
								parse_mode: 'HTML',
							});
							sent = true;
						} catch (err) {
							console.error('\x1b[31mPantau: kirim media gagal:\x1b[39m', err?.message || err);
						}
					}
					if (!sent) {
						await telegram.send(process.env.TELEGRAM_CHAT_ID, text, {
							type: 'text',
							parse_mode: 'HTML',
						});
					}
				}
			} catch {
				// watch.json tidak ada / rusak -> abaikan
			}
		}

		// Allow command only for me
		if (!m.isOwner) return;

		// Auto-detect link TikTok dari owner (tanpa command)
		if (!m.command && /tiktok\.com/i.test(m.text || '')) {
			await handleTikTokDownload(hisoka, m, m.text);
			return;
		}

		switch (m.command) {
			case 'hidetag':
			case 'ht':
			case 'everyone':
			case 'all':
				{
					if (!m.isGroup) {
						await m.reply('Command ini hanya bisa dipakai di dalam grup.');
						return;
					}

					const group = hisoka.groups.read(m.from);
					const participants = group.participants.map(v => v.phoneNumber || v.id);

					const msg = await hisoka.messageModify(m.from, /text|conversation/i.test(m.type) && query ? m : quoted, {
						quoted: undefined,
						text: `@${m.from}\n\n${query}`.trim(),
						mentions: participants.map(v => ({ id: v })).concat({ id: m.from, name: 'everyone' }),
					});

					await hisoka.relayMessage(m.from, msg.message);
				}
				break;

			case 'q':
			case 'quoted':
				{
					// check if the message is a reply
					if (!m.isQuoted) {
						await m.reply('No quoted message found.');
						return;
					}

					// check if quoted message have quoted to
					const message = hisoka.cacheMsg.get(m.quoted.key.id);
					if (!message) {
						await m.reply('Quoted message not found.');
						return;
					}

					const IMessage = await injectMessage(hisoka, message);
					if (!IMessage.isQuoted) {
						await m.reply('Quoted message not found.');
						return;
					}

					await m.reply({ forward: IMessage.quoted });
				}
				break;

			case 'p':
			case 'ping':
				{
					const msg = await m.reply('Pong!');
					const latency = Math.abs(Date.now() - m.messageTimestamp * 1000);
					const uptime = process.uptime();
					await m.reply({
						edit: msg.key,
						text: `Pong! Latency: ${latency}ms\nUptime: ${msToTime(uptime * 1000)}`,
					});
				}
				break;

			case '>':
			case 'eval':
				{
					let result;
					try {
						const code = query || text;
						result = /await/i.test(code) ? await eval('(async() => { ' + code + ' })()') : await eval(code);
					} catch (error) {
						result = error;
					}

					await m.reply(util.format(result));
				}
				break;

			case '$':
			case 'exec':
			case 'bash':
				{
					try {
						exec(query, (error, stdout, stderr) => {
							if (error) {
								return m.throw(util.format(error));
							}
							if (stderr) {
								return m.throw(stderr);
							}
							if (stdout) {
								return m.reply(stdout);
							}
							// If no output, send a message indicating success
							return m.throw('Command executed successfully, but no output.');
						});
					} catch (error) {
						await m.reply(util.format(error));
						return;
					}
				}
				break;

			case 'groups':
			case 'group':
			case 'listgroups':
			case 'listgroup':
				{
					const groups = Object.values(await hisoka.groupFetchAllParticipating());
					groups.map(g => hisoka.groups.write(g.id, g));

					let text = `*Total ${groups.length} groups*\n`;
					text += `\n*Total Participants in all groups:* ${Array.from(groups).reduce(
						(a, b) => a + b.participants.length,
						0
					)}\n\n`;
					groups
						.filter(group => isJidGroup(group.id))
						.forEach((group, i) => {
							text += `${i + 1}. *${group.subject}* - ${group.participants.length} participants\n`;
						});

					await m.reply(text.trim());
				}
				break;

			case 'contacts':
			case 'contact':
			case 'listcontacts':
			case 'listcontact':
				{
					const contacts = Array.from(hisoka.contacts.values()).filter(c => c.id);
					let text = '*Total:*\n\n';
					text += `- All Contacts: ${contacts.length}\n`;
					text += `- Saved Contacts: ${contacts.filter(v => v.isContact).length}\n`;
					text += `- Not Saved Contacts: ${contacts.filter(v => !v.isContact).length}\n`;
					await m.reply(text.trim());
				}
				break;

			case 'tt':
			case 'tiktok':
			case 'dl':
				{
					await handleTikTokDownload(hisoka, m, query || m.text);
				}
				break;

			case 'tiktokv2':
			case 'tt2':
				{
					const url = (query || m.text || '').trim();
					if (!/tiktok\.com/i.test(url)) {
						await m.reply('Kirim link TikTok. Contoh: `.tiktokv2 https://vt.tiktok.com/xxx/`');
						break;
					}
					await m.reply('⬇️ Mengunduh TikTok (v2)...');
					try {
						const { getTikTokV2 } = await import('../helper/tiktokv2.js');
						const { downloadUrl } = await import('../helper/tiktok.js');
						const info = await getTikTokV2(url);
						const buf = await downloadUrl(info.videoUrl, 100);
						const caption = `🎵 *${info.title}*\n👤 ${info.author}\n🔧 via ${info.source}`;
						await hisoka.sendMessage(m.from, { video: buf, caption }, { quoted: m });
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengunduh.'));
					}
				}
				break;

			case 'sfile':
				{
					const q = (query || '').trim();
					if (!q) {
						await m.reply('Cari file di sfile. Contoh: `.sfile minecraft mod`');
						break;
					}
					await m.reply('🔍 Mencari di sfile...');
					try {
						const { searchSfile } = await import('../helper/iyansearch.js');
						const files = await searchSfile(q);
						const list = files.slice(0, 10).map((f, i) => `${i + 1}. ${f.name}\n   🔗 ${f.url}`).join('\n\n');
						await m.reply(`📁 *Hasil sfile: "${q}"*\n\n${list}`);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari.'));
					}
				}
				break;

			case 'ytsearch':
			case 'yts':
				{
					const q = (query || '').trim();
					if (!q) {
						await m.reply('Cari video YouTube. Contoh: `.ytsearch kucing lucu`');
						break;
					}
					await m.reply('🔍 Mencari di YouTube...');
					try {
						const { searchYoutube, fmtDur } = await import('../helper/iyansearch.js');
						const vids = await searchYoutube(q, 5);
						const list = vids.map((v, i) => `${i + 1}. *${v.title}*\n   👤 ${v.uploader} | ⏱️ ${fmtDur(v.duration)}\n   🔗 ${v.url}`).join('\n\n');
						await m.reply(`🎬 *Hasil YouTube: "${q}"*\n\n${list}\n\n_Download: .play <judul>_`);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari.'));
					}
				}
				break;

			case 'play':
				{
					const q = (query || '').trim();
					if (!q) {
						await m.reply('Kasih judul lagunya. Contoh: .play iqroo');
						break;
					}

					await m.reply(`🔎 Mencari *${q}* ...`);

					let res = null;
					try {
						res = await downloadYouTubeAudio(q);
						const data = fs.readFileSync(res.file);
						const mins = Math.floor(res.duration / 60);
						const secs = String(Math.floor(res.duration % 60)).padStart(2, '0');
						const safeTitle = res.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'audio';

						await m.reply(`🎵 *${res.title}*\n⏱️ Durasi: ${mins}:${secs}\n⬆️ Mengirim audio...`);

						const content =
							data.length > 100 * 1024 * 1024
								? { document: data, fileName: `${safeTitle}.mp3` }
								: { audio: data, mimetype: 'audio/mpeg', fileName: `${safeTitle}.mp3` };
						await hisoka.sendMessage(m.from, content, { quoted: m });
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengunduh audio.'));
					} finally {
						if (res) cleanupYouTubeAudio(res.file);
					}
				}
				break;

			case 's':
			case 'sticker':
			case 'stiker':
				{
					await handleSticker(hisoka, m);
				}
				break;

			case 'spack':
			case 'stickerpack':
			case 'stikerpack':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih link pack sticker.ly-nya. Contoh:\n.spack https://sticker.ly/s/M3XUY1\natau kodenya aja: .spack M3XUY1');
						break;
					}
					let tmpDir = '';
					try {
						await m.reply('📦 Membuka pack stiker...');
						const pack = await getStickerPack(raw);
						await m.reply(`📦 *${pack.name}*\n🎨 Total ${pack.stickers.length} stiker, mengunduh...`);
						const res = await downloadStickerPack(pack.stickers, 15);
						tmpDir = res.tmpDir;
						await m.reply(`✅ Mengirim ${res.files.length} stiker...`);
						for (const f of res.files) {
							await hisoka.sendMessage(m.from, { sticker: fs.readFileSync(f) });
							await new Promise(r => setTimeout(r, 700));
						}
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengambil sticker pack.'));
					} finally {
						if (tmpDir) cleanupStickerPack(tmpDir);
					}
				}
				break;

			case 'tpack':
			case 'tsticker':
			case 'tstiker':
			case 'tgpack':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih nama pack atau link-nya. Contoh:\n.tpack AnimeEmojis\n.tpack https://t.me/addstickers/AnimeEmojis');
						break;
					}
					let tmpDir = '';
					try {
						await m.reply('📦 Membuka pack Telegram...');
						const pack = await getTelegramPack(raw);
						await m.reply(`📦 *${pack.title}*\n🎨 Total ${pack.stickers.length} stiker, mengunduh...`);
						const res = await downloadTelegramPack(pack.stickers, 15);
						tmpDir = res.tmpDir;
						const skipNote = res.skipped ? ` (${res.skipped} animasi/video dilewati)` : '';
						await m.reply(`✅ Mengirim ${res.files.length} stiker${skipNote}...`);
						for (const f of res.files) {
							await hisoka.sendMessage(m.from, { sticker: fs.readFileSync(f) });
							await new Promise(r => setTimeout(r, 700));
						}
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengambil sticker pack Telegram.'));
					} finally {
						if (tmpDir) cleanupTelegramPack(tmpDir);
					}
				}
				break;

			case 'menu':
			case 'help':
			case '?':
				{
					const ownerName = process.env.BOT_OWNER_NAME || 'Iyan';
					const quotes = [
						'Jangan menunggu sempurna, buat momenmu sempurna.',
						'Berani mencoba adalah awal kesuksesan.',
						'Hari ini lelah, besok bangga.',
						'Fokus proses, hasil mengikuti.',
						'Mimpi tanpa aksi hanyalah angan.',
						'Maju sedikit tiap hari itu cukup.',
						'Gagal itu guru, asal mau belajar.',
						'Jadilah versi terbaik dirimu.',
						'Waktu terbaik mulai adalah sekarang.',
						'Kerja keras kalahkan bakat malas.',
						'Pelan tak apa, asal jangan diam.',
						'Hal besar mulai dari langkah kecil.',
					];
					const quote = quotes[Math.floor(Math.random() * quotes.length)];
					const gcLink = readGcLink();

					// Menu compact untuk caption foto (limit WA 1024 byte!) —
					// foto + menu jadi SATU pesan seperti kartu.
					// Guard byte-length: kalau jebol, kirim terpisah (anti-hang).
					const menuCaption =
						`👋 Halo, *${ownerName}*! Selamat datang di *adawong* 🤖\n` +
						`💭 _"${quote}"_\n\n` +
						`📥 *DOWNLOADER*\n` +
						`.play • .ytsearch • .sfile • .tt • .tiktokv2\n` +
						`.pin • .ppcouple • .cosplay • .pixiv • .hentai\n\n` +
						`🔞 *18+ ZONE*\n` +
						`.cewe • .cewekat • .cewevid • .chara • .hanime\n` +
						`.bokep • .cosplay18 • .nekopoi • .manhwa • .manhua\n\n` +
						`🎨 *STIKER*\n` +
						`.s • .spack • .tpack\n\n` +
						`👁️ *STATUS*\n` +
						`.sw • .swread • .swreact • .swreply\n` +
						`.swreacttext • .swemoji • .uptimebio\n\n` +
						`😂 *FUN*\n` +
						`.khodam • .alay • .hacker\n\n` +
						(gcLink ? `👥 *GRUP WA*\n🔗 ${gcLink}\n\n` : '') +
						`👑 *${ownerName}* • ⚙️ readsw`;
					try {
						const banner = fs.readFileSync(MENU_BANNER);
						if (Buffer.byteLength(menuCaption, 'utf8') > 1000) {
							// kepanjangan -> kirim gambar + teks terpisah
							await hisoka.sendMessage(m.from, { image: banner }, { quoted: m });
							await m.reply(menuCaption);
						} else {
							await hisoka.sendMessage(m.from, { image: banner, caption: menuCaption }, { quoted: m });
						}
					} catch {
						// banner gagal -> kirim teks saja
						await m.reply(menuCaption);
					}
				}
				break;

			case 'setgc':
				{
					const link = (query || '').trim();
					if (!link) {
						const cur = readGcLink();
						await m.reply(
							cur
								? `👥 Link grup saat ini:\n${cur}\n\nGanti dengan: .setgc <link>\nHapus dengan: .setgc hapus`
								: 'Kirim link invite grupnya. Contoh: .setgc https://chat.whatsapp.com/xxxx'
						);
						break;
					}
					if (/^hapus$/i.test(link)) {
						try { fs.unlinkSync(GC_JSON); } catch { /* abaikan */ }
						await m.reply('🗑️ Link grup dihapus dari menu.');
						break;
					}
					if (!/chat\.whatsapp\.com\//i.test(link)) {
						await m.reply('Link-nya harus invite grup WhatsApp (chat.whatsapp.com/...).');
						break;
					}
					fs.writeFileSync(GC_JSON, JSON.stringify({ invite: link }, null, 2));
					await m.reply(`✅ Link grup tersimpan! Sekarang muncul di menu:\n${link}`);
				}
				break;

			case 'react':
				{
					const target = m.isQuoted ? m.quoted : null;
					if (!target?.key) {
						await m.reply('Reply status dulu, lalu kirim: react 😍');
						break;
					}
					const emoji = (query || '').split(/\s+/)[0] || '❤️';
					try {
						await hisoka.sendMessage(
							'status@broadcast',
							{ react: { key: target.key, text: emoji } },
							{
								statusJidList: [
									jidNormalizedUser(hisoka.user.id),
									jidNormalizedUser(target.sender || m.sender),
								],
							}
						);
						await m.reply(`React ${emoji} terkirim.`);
					} catch (err) {
						await m.reply('Gagal mengirim react: ' + (err?.message || err));
					}
				}
				break;

			case 'pin':
			case 'pinterest':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih kata kuncinya. Contoh: .pin kucing lucu');
						break;
					}

					// Kalau berupa link pin langsung -> unduh pin itu
					const pinUrl = raw.match(/https?:\/\/[^\s]*pinterest\.com\/pin\/[^\s]*/i);

					let tmpDir = '';
					try {
						if (pinUrl) {
							await m.reply('📌 Mengunduh pin...');
							const res = await downloadPinterestPin(pinUrl[0]);
							tmpDir = res.tmpDir;
							// Kirim SEMUA sekaligus (paralel) -> tiba berbarengan -> tampil sebagai album
							await sendAlbum(hisoka, m.from, res.files);
						} else {
							// .pin <kata kunci> [jumlah] -> cari & kirim N gambar
							let count = 5;
							let keyword = raw;
							const numMatch = raw.match(/\s+(\d{1,2})$/);
							if (numMatch) {
								count = Math.max(1, Math.min(10, parseInt(numMatch[1])));
								keyword = raw.slice(0, numMatch.index).trim();
							}
							if (!keyword) {
								await m.reply('Kasih kata kuncinya. Contoh: .pin kucing lucu');
								break;
							}
							await m.reply(`🔎 Mencari *${keyword}* di Pinterest...`);
							const res = await searchPinterest(keyword, count);
							tmpDir = res.tmpDir;
							await m.reply(`📌 Ketemu ${res.files.length} gambar, mengirim...`);
							// Kirim SEMUA sekaligus (paralel) -> tiba berbarengan -> tampil sebagai album
							await sendAlbum(hisoka, m.from, res.files);
						}
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengambil dari Pinterest.'));
					} finally {
						if (tmpDir) cleanupPinterest(tmpDir);
					}
				}
				break;

			case 'cosplay':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply(
							'╭─「 👘 *COSPLAYTELE SEARCH* 」\n' +
							'│\n' +
							'│ Cari foto cosplay dari\n' +
							'│ _cosplaytele.com_ secara realtime.\n' +
							'│\n' +
							'│ *Format:*\n' +
							'│ • `.cosplay <keyword>`\n' +
							'│ • `.cosplay random`\n' +
							'│\n' +
							'│ *Contoh:*\n' +
							'│ 1. `.cosplay mitsuri`\n' +
							'│ 2. `.cosplay rem re:zero`\n' +
							'│ 3. `.cosplay velma`\n' +
							'│ 4. `.cosplay random`\n' +
							'│\n' +
							'│ > ℹ️ Hasil dikirim sebagai *album foto.*\n' +
							'╰──────────────────────'
						);
						break;
					}
					await m.reply('🔍 Cari cosplay...');
					try {
						const { searchCosplay, getPostPhotos, getLatestPosts, downloadPhotos } = await import('../helper/cosplay.js');
						let post;
						if (/^random$/i.test(raw)) {
							const latest = await getLatestPosts(20);
							if (!latest.length) { await m.reply('❌ Gagal ambil daftar postingan.'); break; }
							post = latest[Math.floor(Math.random() * latest.length)];
						} else {
							const results = await searchCosplay(raw, 5);
							if (!results.length) { await m.reply(`❌ Tidak ketemu hasil untuk "${raw}". Coba keyword lain.`); break; }
							post = results[0];
						}
						const photoUrls = await getPostPhotos(post.url, 8);
						if (!photoUrls.length) { await m.reply('❌ Tidak ada foto di postingan ini.'); break; }
						const tmpDir = `/tmp/cosplay_${Date.now()}`;
						const files = await downloadPhotos(photoUrls, tmpDir);
						if (!files.length) { await m.reply('❌ Gagal download foto.'); break; }
						const caption = `👘 *${post.title}*\n🔗 ${post.url}\n📸 ${files.length} foto`;
						await sendAlbum(hisoka, m.from, files);
						await m.reply(caption);
						try { (await import('fs')).rmSync(tmpDir, { recursive: true, force: true }); } catch {}
					} catch (err) {
						console.error('\x1b[31m[cosplay] error:\x1b[39m', err?.message || err);
						await m.reply('❌ Gagal ambil cosplay. Coba lagi nanti.');
					}
				}
				break;

			case 'ppcouple':
			case 'ppc':
				{
					const raw = (query || '').trim();
					const theme = raw || 'anime';
					await m.reply(`💑 Cari pp couple *${theme}*...`);
					try {
						const { searchPinterest, cleanupPinterest } = await import('../helper/pinterest.js');
						const { execFile: execFileAsync } = await import('child_process');
						const { promisify } = await import('util');
						const execFileP = promisify(execFileAsync);
						// cari gambar couple yang lebar (cocok untuk di-split)
						const res = await searchPinterest(`pp couple ${theme}`, 5);
						if (!res.files.length) {
							await m.reply('❌ Tidak ketemu. Coba tema lain.');
							cleanupPinterest(res.tmpDir);
							break;
						}
						// ambil 1 gambar, split jadi 2 (kiri-kanan) biar pasangannya cocok
						const src = res.files[0];
						const left = src + '_left.jpg';
						const right = src + '_right.jpg';
						await execFileP('ffmpeg', ['-y', '-i', src, '-vf', 'crop=iw/2:ih:0:0', left], { timeout: 30000 });
						await execFileP('ffmpeg', ['-y', '-i', src, '-vf', 'crop=iw/2:ih:iw/2:0', right], { timeout: 30000 });
						await hisoka.sendMessage(
							m.from,
							{ image: fs.readFileSync(left), caption: `💑 PP Couple *${theme}*\n👦 Untuk cowok` },
							{ quoted: m }
						);
						await hisoka.sendMessage(
							m.from,
							{ image: fs.readFileSync(right), caption: `👧 Untuk cewek` }
						);
						await m.reply(`_Mau yang lain? Ketik \`.ppcouple ${theme}\` lagi_`);
						cleanupPinterest(res.tmpDir);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari pp couple.'));
					}
				}
				break;

			case 'pixiv':
			case 'px':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih kata kuncinya. Contoh: .pixiv kucing');
						break;
					}

					// Kalau berupa link artwork langsung -> unduh semua halamannya
					const artMatch = raw.match(/pixiv\.net\/(?:en\/)?artworks\/(\d+)/i) || raw.match(/^(\d{6,})$/);

					let tmpDir = '';
					try {
						if (artMatch) {
							await m.reply('🎨 Mengunduh artwork...');
							const res = await downloadPixivArtwork(artMatch[1]);
							tmpDir = res.tmpDir;
							await sendAlbum(hisoka, m.from, res.files);
						} else {
							// .pixiv <kata kunci> [jumlah] -> cari & kirim N gambar
							let count = 5;
							let keyword = raw;
							const numMatch = raw.match(/\s+(\d{1,2})$/);
							if (numMatch) {
								count = Math.max(1, Math.min(10, parseInt(numMatch[1])));
								keyword = raw.slice(0, numMatch.index).trim();
							}
							if (!keyword) {
								await m.reply('Kasih kata kuncinya. Contoh: .pixiv kucing');
								break;
							}
							await m.reply(`🔎 Mencari *${keyword}* di Pixiv...`);
							const res = await searchPixiv(keyword, count);
							tmpDir = res.tmpDir;
							await m.reply(`🎨 Ketemu ${res.files.length} gambar, mengirim...`);
							await sendAlbum(hisoka, m.from, res.files);
						}
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengambil dari Pixiv.'));
					} finally {
						if (tmpDir) cleanupPixiv(tmpDir);
					}
				}
				break;

			case 'hentai':
			case 'hd':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih kata kuncinya. Contoh: .hentai zero two');
						break;
					}

					// Kalau berupa link galeri langsung -> unduh dari situ
					const galUrl = raw.match(/https?:\/\/hentaidad\.com\/[^\s]*/i);

					let tmpDir = '';
					try {
						// .hentai <kata kunci> [jumlah] -> cari galeri & kirim N gambar
						let count = 10;
						let keyword = raw;
						const numMatch = raw.match(/\s+(\d{1,2})$/);
						if (numMatch) {
							count = Math.max(1, Math.min(20, parseInt(numMatch[1])));
							keyword = raw.slice(0, numMatch.index).trim();
						}

						let res;
						if (galUrl) {
							await m.reply('🔞 Membuka galeri...');
							res = await downloadHentaidadGallery(galUrl[0], count);
						} else {
							if (!keyword) {
								await m.reply('Kasih kata kuncinya. Contoh: .hentai zero two');
								break;
							}
							await m.reply(`🔎 Mencari *${keyword}* di Hentaidad...`);
							res = await searchHentaidad(keyword, count);
						}
						tmpDir = res.tmpDir;
						await m.reply(`🔞 *${res.title}*\n🖼️ Total ${res.total} gambar, mengirim ${res.files.length}...`);
						await sendAlbum(hisoka, m.from, res.files);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mengambil dari Hentaidad.'));
					} finally {
						if (tmpDir) cleanupHentaidad(tmpDir);
					}
				}
				break;

			case 'manhwa':
			case 'mh':
			case 'manhua':
				{
					const isManhua = m.command === 'manhua';
					const raw = (query || '').trim();
					const sender = m.sender || m.from;
					const { searchManhwa, searchManhua, getIdChapters, getChapterPages, downloadPage } =
						await import('../helper/mangadex.js');
					const doSearch = isManhua ? searchManhua : searchManhwa;
					const cmdName = isManhua ? 'manhua' : 'manhwa';
					const flag = isManhua ? '🇨🇳' : '🇰🇷';

					// .manhwa baca <nomor> <chapter>
					const bacaMatch = raw.match(/^baca\s+(\d+)\s+([\d.]+)/i);
					if (bacaMatch) {
						const idx = parseInt(bacaMatch[1]) - 1;
						const chNum = bacaMatch[2];
						const { loadManhwaList } = await import('../helper/mangadex.js');
						let manga = manhwaSearchCache.get(sender)?.[idx];
						if (!manga) {
							// cache hilang (bot restart?) -> pakai daftar kurasi urut chapter terbanyak
							const curated = await loadManhwaList();
							const sorted = [...curated].sort((a, b) => b.chapters - a.chapters);
							manga = sorted[idx];
						}
						if (!manga) {
							await m.reply('❌ Cari dulu: `.manhwa top` atau `.manhwa <keyword>`');
							break;
						}
						await m.reply(`📖 Mengambil *${manga.title}* chapter ${chNum}...`);
						try {
							const chapters = await getIdChapters(manga.id);
							const ch = chapters.find(c => c.chapter === chNum);
							if (!ch) {
								await m.reply(`❌ Chapter ${chNum} tidak ada dalam bahasa Indonesia.`);
								break;
							}
							const pages = await getChapterPages(ch.id);
							await m.reply(`📄 ${pages.length} halaman, mengunduh...`);
							// unduh paralel 4 sekaligus
							const bufs = [];
							for (let i = 0; i < pages.length; i += 4) {
								const batch = await Promise.allSettled(
									pages.slice(i, i + 4).map(u => downloadPage(u))
								);
								for (const r of batch) if (r.status === 'fulfilled') bufs.push(r.value);
							}
							if (!bufs.length) {
								await m.reply('❌ Gagal mengunduh halaman.');
								break;
							}
							// kirim per 8 halaman sebagai album
							for (let i = 0; i < bufs.length; i += 8) {
								const chunk = bufs.slice(i, i + 8);
								const files = chunk.map((b, j) => {
									const fp = `/tmp/mh_${Date.now()}_${i + j}.jpg`;
									fs.writeFileSync(fp, b);
									return fp;
								});
								await sendAlbum(hisoka, m.from, files);
								for (const f of files) { try { fs.unlinkSync(f); } catch {} }
							}
							await m.reply(`✅ Selesai: *${manga.title}* ch.${chNum} (${bufs.length} hlm)`);
						} catch (err) {
							await m.reply('❌ ' + (err?.message || 'Gagal mengambil chapter.'));
						}
						break;
					}

					// .manhwa <nomor> -> daftar chapter
					if (/^\d+$/.test(raw)) {
						const idx = parseInt(raw) - 1;
						let manga = manhwaSearchCache.get(sender)?.[idx];
						if (!manga) {
							const { loadManhwaList } = await import('../helper/mangadex.js');
							const curated = await loadManhwaList();
							manga = [...curated].sort((a, b) => b.chapters - a.chapters)[idx];
						}
						if (!manga) {
							await m.reply('❌ Cari dulu: `.manhwa top`');
							break;
						}
						await m.reply(`📚 Mengambil daftar chapter *${manga.title}*...`);
						try {
							const chapters = await getIdChapters(manga.id);
							if (!chapters.length) {
								await m.reply('❌ Tidak ada chapter bahasa Indonesia.');
								break;
							}
							manhwaChapterCache.set(sender, { manga, chapters });
							const list = chapters.slice(0, 30).map(c => `• ${c.chapter}${c.title ? ' — ' + c.title.slice(0, 30) : ''}`).join('\n');
							const more = chapters.length > 30 ? `\n_...dan ${chapters.length - 30} lainnya_` : '';
							await m.reply(
								`📚 *${manga.title}*\n${chapters.length} chapter (ID):\n${list}${more}\n\n` +
								`_Baca: .manhwa baca ${idx + 1} <chapter>_`
							);
						} catch (err) {
							await m.reply('❌ ' + (err?.message || 'Gagal mengambil chapter.'));
						}
						break;
					}

					// .manhwa/.manhua <keyword> / top / random -> cari
					if (!raw) {
						if (isManhua) {
							await m.reply('📖 Manhua 18+ China 🇨🇉 couple/romance sub Indo:\n`.manhua <keyword>` — cari judul\n`.manhua <nomor>` — daftar chapter\n`.manhua baca <nomor> <chapter>` — baca');
						} else {
							await m.reply('📖 Manhwa 18+ Korea sub Indo:\n`.manhwa top` — paling populer\n`.manhwa random` — acak\n`.manhwa <keyword>` — cari judul\n`.manhwa <nomor>` — daftar chapter\n`.manhwa baca <nomor> <chapter>` — baca');
						}
						break;
					}
					const isTop = /^top$/i.test(raw);
					const isRandom = /^random$/i.test(raw);
					const { loadManhwaList } = await import('../helper/mangadex.js');
					const curated = await loadManhwaList();

					// .manhwa top / random -> dari daftar kurasi (sudah verified)
					if ((isTop || isRandom) && curated.length) {
						if (isRandom) {
							const pick = curated[Math.floor(Math.random() * curated.length)];
							manhwaSearchCache.set(sender, [pick]);
							try {
								const ch = await getIdChapters(pick.id);
								const list = ch.slice(0, 15).map(c => `• ${c.chapter}`).join(' ');
								await m.reply(
									`🎲 Rekomendasi acak:\n📖 *${pick.title}*\n${ch.length} chapter 🇮🇩\n${list}${ch.length > 15 ? ' ...' : ''}\n\n_Baca: .manhwa baca 1 <chapter>_`
								);
							} catch {
								await m.reply(`🎲 *${pick.title}*\n_Baca: .manhwa baca 1 <chapter>_`);
							}
							break;
						}
						const top = [...curated].sort((a, b) => b.chapters - a.chapters).slice(0, 8);
						manhwaSearchCache.set(sender, top);
						const list = top.map((r, i) => `${i + 1}. *${r.title}*\n   └ ${r.chapters} chapter 🇮🇩`).join('\n');
						await m.reply(`📖 Terpopuler:\n${list}\n\n_Lihat chapter: .manhwa <nomor>_`);
						break;
					}

					await m.reply(isTop ? '🔥 Mengambil manhwa terpopuler...' : isRandom ? '🎲 Mengacak manhwa...' : `🔎 Mencari manhwa *${raw}*...`);
					try {
						// cari dulu di daftar kurasi
						let results = [];
						if (!isTop && !isRandom && curated.length) {
							const kw = raw.toLowerCase();
							results = curated.filter(x => x.title.toLowerCase().includes(kw)).slice(0, 8)
								.map(x => ({ id: x.id, title: x.title, chCount: x.chapters }));
						}
						if (!results.length) {
							// fallback: live search + validasi chapter ID
							const live = await doSearch(raw, 10);
							if (!live.length) {
								await m.reply('❌ Tidak ketemu. Coba keyword lain.');
								break;
							}
							const valid = [];
							for (const r of live) {
								try {
									const ch = await getIdChapters(r.id);
									if (ch.length) { valid.push({ ...r, chCount: ch.length }); }
								} catch {}
								if (valid.length >= 5) break;
							}
							if (!valid.length) {
								await m.reply('❌ Tidak ada yang punya terjemahan Indonesia. Coba `.manhwa top`.');
								break;
							}
							results = valid;
						}
						manhwaSearchCache.set(sender, results);
						const list = results.map((r, i) => `${i + 1}. *${r.title}*\n   └ ${r.chCount} chapter 🇮🇩`).join('\n');
						await m.reply(`📖 ${flag} Hasil *${raw}*:\n${list}\n\n_Lihat chapter: .${cmdName} <nomor>_`);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari.'));
					}
				}
				break;

			case 'hanime':
			case 'hv':
			case 'han':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih kata kuncinya. Contoh: .hanime succubus\nLalu pilih nomor: .hanime 2');
						break;
					}

					// .hanime <nomor> -> unduh dari hasil pencarian terakhir
					const numPick = raw.match(/^(\d{1,2})$/);
					if (numPick) {
						const cache = hanimeSearchCache.get(m.sender);
						if (!cache || !cache.length) {
							await m.reply('Belum ada hasil pencarian. Cari dulu: .hanime <kata kunci>');
							break;
						}
						const idx = parseInt(numPick[1]) - 1;
						if (idx < 0 || idx >= cache.length) {
							await m.reply(`Nomor 1-${cache.length} aja.`);
							break;
						}
						const item = cache[idx];
						let tmpDir = '';
						try {
							await m.reply(`📺 *${item.name}*\n⏳ Lagi download videonya, sabar ya... (bisa beberapa menit)`);
							const { title, streams } = await getHanimeStreams(item.slug);
							const stream = pickHanimeStream(streams);
							tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-'));
							const safeName = title.replace(/[^\w\- ]+/g, '').slice(0, 60) || 'hanime';
							const outFile = path.join(tmpDir, `${safeName}.mp4`);
							await downloadHanimeStream(stream.url, outFile);
							const size = fs.statSync(outFile).size;
							const data = fs.readFileSync(outFile);
							const caption = `📺 *${title}*\n🎞️ ${stream.quality}`;
							// Video WA max ~64MB, selebihnya kirim sebagai dokumen
							if (size > 64 * 1024 * 1024) {
								await hisoka.sendMessage(m.from, { document: data, fileName: path.basename(outFile), mimetype: 'video/mp4', caption }, { quoted: m });
							} else {
								await hisoka.sendMessage(m.from, { video: data, mimetype: 'video/mp4', caption }, { quoted: m });
							}
						} catch (err) {
							await m.reply('❌ ' + (err?.message || 'Gagal mengunduh video.'));
						} finally {
							if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
						}
						break;
					}

					// .hanime <kata kunci> -> cari & tampilkan daftar
					try {
						await m.reply(`🔎 Mencari *${raw}*...`);
						const results = await searchHanime(raw, 8);
						hanimeSearchCache.set(m.sender, results);
						let txt = `📺 *Hasil: ${raw}*\n\n`;
						results.forEach((v, i) => {
							txt += `${i + 1}. *${v.name}*\n   👁️ ${shortNum(v.views)} | 👍 ${shortNum(v.likes)}\n`;
						});
						txt += `\nBalas dengan: .hanime <nomor>\nContoh: .hanime 1`;
						await m.reply(txt);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari video.'));
					}
				}
				break;

			case 'khodam':
				{
					const name = (query || '').trim() || m.pushName || 'Kamu';
					const khodams = [
						['Macan Putih', 'penjaga setia, galak kalau diganggu'],
						['Tuyul Botak', 'suka nyolong gorengan tetangga'],
						['Kuntilanak Merah', 'tertawanya bikin merinding'],
						['Pocong Loncat', 'lompatannya bisa 2 meter'],
						['Genderuwo', 'badannya bau menyan'],
						['Nyi Roro Kidul', 'ratu pantai selatan'],
						['Jenglot', 'kecil-kecil cabe rawit'],
						['Babi Ngepet', 'hobi begadang cari duit'],
						['Kuyang', 'kepalanya bisa terbang sendiri'],
						['Wewe Gombel', 'suka culik anak nakal'],
						['Sundel Bolong', 'punggungnya bolong, hati-hati'],
						['Banaspati', 'api terbang di malam hari'],
						['Leak', 'ilmu hitam level dewa'],
						['Kolor Ijo', 'legendanya para satpam'],
						['Suster Ngesot', 'jalannya ngesot tapi cepat'],
						['Khodam Kosong', 'tidak terdeteksi, coba lagi besok'],
						['Khodam Mantan', 'masih sering stalking kamu'],
						['Tuyul Tambun', 'perut buncit karena kebanyakan jajan'],
						['Pocong Gaul', 'pocong yang update tren'],
						['Setan Kredit', 'datang tiap tanggal tua nagih utang'],
					];
					const [khodam, desc] = khodams[Math.floor(Math.random() * khodams.length)];
					const power = Math.floor(Math.random() * 100) + 1;
					const bar = '█'.repeat(Math.round(power / 10)) + '░'.repeat(10 - Math.round(power / 10));
					await m.reply(
						`🔮 *CEK KHODAM*\n\n` +
							`👤 Nama: *${name}*\n` +
							`👻 Khodam: *${khodam}*\n` +
							`📜 Ciri: _${desc}_\n` +
							`⚡ Kekuatan: ${power}%\n${bar}`
					);
				}
				break;

			case 'alay':
				{
					const text = (query || '').trim();
					if (!text) {
						await m.reply('Kasih teksnya. Contoh: .alay halo guys apa kabar');
						break;
					}
					let out = '';
					for (const ch of text) {
						out += /[a-zA-Z]/.test(ch) ? (Math.random() < 0.5 ? ch.toUpperCase() : ch.toLowerCase()) : ch;
					}
					await m.reply(out || text);
				}
				break;

			case 'hacker':
				{
					const target = (query || '').trim() || 'target';
					const steps = [
						'💻 Menghubungkan ke satelit...',
						'🛰️ Satelit terhubung!',
						'🔍 Memindai target...',
						'🔓 Membobol firewall...',
						'📂 Mengunduh data rahasia...',
						'✅ Berhasil! Data sudah diamankan 😎',
					];
					const msg = await m.reply(`🎯 Target: *${target}*\n\n${steps[0]}`);
					for (let i = 1; i < steps.length; i++) {
						await new Promise(r => setTimeout(r, 1200));
						await m.reply({ edit: msg.key, text: `🎯 Target: *${target}*\n\n${steps.slice(0, i + 1).join('\n')}` });
					}
				}
				break;

			case 'nekopoi':
			case 'neko':
				{
					const keyword = (query || '').trim();
					if (!keyword) {
						await m.reply('Kasih kata kuncinya. Contoh: .nekopoi zero two');
						break;
					}
					await m.reply(`🔎 Mencari *${keyword}* di Nekopoi...`);
					try {
						const { searchNekopoi } = await import('../helper/nekopoi.js');
						const results = await searchNekopoi(keyword, 8);
						if (!results.length) {
							await m.reply('❌ Tidak ketemu. Coba kata kunci lain.');
							break;
						}
						let text = `🔞 *Hasil: ${keyword}*\n\n`;
						results.forEach((x, i) => {
							text += `${i + 1}. *${x.title}*\n   ▶️ Nonton: ${x.url}\n\n`;
						});
						await m.reply(text.trim());
					} catch (err) {
						await m.reply('❌ Gagal mencari: ' + (err?.message || 'error'));
					}
				}
				break;

			case 'cewekat':
				{
					const fs2 = await import('fs');
					const path2 = await import('path');
					const libDir = path2.join(process.cwd(), 'cewe_lib');
					if (!fs2.existsSync(libDir)) {
						await m.reply('❌ Galeri kosong.');
						break;
					}
					const cats = {};
					fs2.readdirSync(libDir).filter(f => f.endsWith('.jpg')).forEach(f => {
						const mt = f.match(/^cewe_(.+?)_\d+\.jpg$/);
						if (mt) cats[mt[1]] = (cats[mt[1]] || 0) + 1;
					});
					const names = Object.keys(cats).sort();
					let text = `📂 *KATEGORI CEWE*\nTotal ${names.reduce((a, n) => a + cats[n], 0)} gambar\n\n`;
					names.forEach(n => { text += `• ${n} (${cats[n]})\n`; });
					text += `\n_Pakai: .cewe <kategori>_\n_Contoh: .cewe lingerie_`;
					await m.reply(text);
				}
				break;

			case 'cewevid':
			case 'cv':
				{
					const raw = (query || '').trim();
					const count = /^\d{1,2}$/.test(raw) ? Math.max(1, Math.min(3, parseInt(raw))) : 2;

					const fs = await import('fs');
					const path = await import('path');
					const vidDir = path.join(process.cwd(), 'cewe_vid_lib');
					const sentPath = path.join(process.cwd(), 'cewe_sent.json');
					if (!fs.existsSync(vidDir)) {
						await m.reply('❌ Galeri video kosong, coba lagi nanti.');
						break;
					}
					let files = fs.readdirSync(vidDir).filter(f => f.endsWith('.mp4'));
					if (!files.length) {
						await m.reply('❌ Galeri video kosong, coba lagi nanti.');
						break;
					}
					let sent = [];
					try {
						sent = JSON.parse(fs.readFileSync(sentPath, 'utf-8') || '[]');
						if (!Array.isArray(sent)) sent = [];
					} catch {}
					const sentSet = new Set(sent);
					let pool = files.filter(f => !sentSet.has(f));
					if (pool.length < Math.min(count, files.length)) {
						pool = files;
						sent = sent.filter(s => !files.includes(s));
					}
					const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
					try {
						fs.writeFileSync(sentPath, JSON.stringify([...sent, ...picked].slice(-500)));
					} catch {}

					await m.reply(`🎬 Mengirim ${picked.length} video...`);
					for (const f of picked) {
						try {
							await hisoka.sendMessage(m.from, {
								video: fs.readFileSync(path.join(vidDir, f)),
								caption: '🔞',
							});
						} catch (err) {
							console.error('\x1b[33mcewevid gagal kirim:\x1b[39m', err?.message || err);
						}
					}
				}
				break;

			case 'chara':
			case 'character':
			case 'karakter':
				{
					const raw = (query || '').trim();
					if (!raw) {
						await m.reply('Kasih nama karakternya. Contoh: .chara ada wong');
						break;
					}
					let count = 5;
					let name = raw;
					const numMatch = raw.match(/\s+(\d{1,2})$/);
					if (numMatch) {
						count = Math.max(1, Math.min(10, parseInt(numMatch[1])));
						name = raw.slice(0, numMatch.index).trim();
					}
					if (!name) {
						await m.reply('Kasih nama karakternya. Contoh: .chara ada wong');
						break;
					}
					await m.reply(`🎭 Mencari karakter *${name}* (18+ AI)...`);
					let tmpDir = '';
					try {
						const { searchCharacter, downloadCivitai, cleanupCivitai } = await import('../helper/civitai.js');
						const items = await searchCharacter(name, count);
						const dl = await downloadCivitai(items);
						tmpDir = dl.tmpDir;
						await m.reply(`🎭 *${name}* — mengirim ${dl.files.length} gambar...`);
						await sendAlbum(hisoka, m.from, dl.files);
						cleanupCivitai(tmpDir);
					} catch (err) {
						if (tmpDir) {
							try {
								const { cleanupCivitai } = await import('../helper/civitai.js');
								cleanupCivitai(tmpDir);
							} catch {}
						}
						await m.reply('❌ ' + (err?.message || 'Karakter tidak ditemukan.'));
					}
				}
				break;

			case 'bokep':
				{
					const raw = (query || '').trim();
					const sender = m.sender || m.from;
					const { searchBokep, getBokepVideo, downloadBokep } = await import('../helper/bokep.js');

					// .bokep <nomor> -> download dari hasil terakhir
					if (/^\d+$/.test(raw)) {
						const cache = bokepSearchCache.get(sender);
						if (!cache || !cache.length) {
							await m.reply('Cari dulu: `.bokep <keyword>`');
							break;
						}
						const idx = parseInt(raw) - 1;
						if (idx < 0 || idx >= cache.length) {
							await m.reply(`Nomor 1-${cache.length} aja.`);
							break;
						}
						const item = cache[idx];
						await m.reply(`🎬 Mengambil *${item.title}*...`);
						try {
							const { videoUrl } = await getBokepVideo(item.url);
							await m.reply('⬇️ Mengunduh video...');
							const data = await downloadBokep(videoUrl, 100);
							const caption = `🔞 *${item.title}*`;
							if (data.length > 64 * 1024 * 1024) {
								await hisoka.sendMessage(m.from, { document: data, fileName: 'bokep.mp4', caption }, { quoted: m });
							} else {
								await hisoka.sendMessage(m.from, { video: data, caption }, { quoted: m });
							}
						} catch (err) {
							await m.reply('❌ ' + (err?.message || 'Gagal mengunduh.'));
						}
						break;
					}

					if (!raw) {
						await m.reply('Kasih keyword. Contoh:\n.bokep asian\n.bokep japanese');
						break;
					}
					await m.reply(`🔎 Mencari *${raw}*...`);
					try {
						const results = await searchBokep(raw);
						bokepSearchCache.set(sender, results);
						const list = results.map((r, i) => `${i + 1}. *${r.title}*`).join('\n');
						await m.reply(`🔞 Hasil untuk *${raw}*:\n${list}\n\n_Download: .bokep <nomor>_`);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari.'));
					}
				}
				break;

			case 'cosplay18':
			case 'cp18':
				{
					const raw = (query || '').trim();
					const sender = m.sender || m.from;
					const { searchBokep, getBokepVideo, downloadBokep } = await import('../helper/bokep.js');

					// .cosplay18 <nomor> -> download dari hasil terakhir
					if (/^\d+$/.test(raw)) {
						const cache = cosplay18SearchCache.get(sender);
						if (!cache || !cache.length) {
							await m.reply('Cari dulu: `.cosplay18 <keyword>`\nContoh: `.cosplay18 mitsuri`');
							break;
						}
						const idx = parseInt(raw) - 1;
						if (idx < 0 || idx >= cache.length) {
							await m.reply(`Nomor 1-${cache.length} aja.`);
							break;
						}
						const item = cache[idx];
						await m.reply(`🎬 Mengambil *${item.title}*...`);
						try {
							const { videoUrl } = await getBokepVideo(item.url);
							await m.reply('⬇️ Mengunduh video...');
							const data = await downloadBokep(videoUrl, 100);
							const caption = `🔞👘 *${item.title}*`;
							if (data.length > 64 * 1024 * 1024) {
								await hisoka.sendMessage(m.from, { document: data, fileName: 'cosplay18.mp4', caption }, { quoted: m });
							} else {
								await hisoka.sendMessage(m.from, { video: data, caption }, { quoted: m });
							}
						} catch (err) {
							await m.reply('❌ ' + (err?.message || 'Gagal mengunduh.'));
						}
						break;
					}

					if (!raw) {
						await m.reply(
							'╭─「 👘🔞 *COSPLAY 18+* 」\n' +
							'│\n' +
							'│ Video cosplay dewasa\n' +
							'│ (manusia asli, bukan AI).\n' +
							'│\n' +
							'│ *Format:*\n' +
							'│ • `.cosplay18 <keyword>`\n' +
							'│ • `.cosplay18 <nomor>`\n' +
							'│\n' +
							'│ *Contoh:*\n' +
							'│ 1. `.cosplay18 mitsuri`\n' +
							'│ 2. `.cosplay18 rem`\n' +
							'│ 3. `.cosplay18 1`\n' +
							'╰──────────────────────'
						);
						break;
					}
					const searchQuery = `cosplay ${raw}`;
					await m.reply(`🔎 Mencari cosplay 18+ *${raw}*...`);
					try {
						const results = await searchBokep(searchQuery);
						cosplay18SearchCache.set(sender, results);
						const list = results.map((r, i) => `${i + 1}. *${r.title}*`).join('\n');
						await m.reply(`👘🔞 Hasil untuk *${raw}*:\n${list}\n\n_Download: .cosplay18 <nomor>_`);
					} catch (err) {
						await m.reply('❌ ' + (err?.message || 'Gagal mencari.'));
					}
				}
				break;

			case 'cewe':
			case 'cw':
				{
					const CATS = ['sexy','nude','sensual','hot','lingerie','bedroom','curvy','blonde','petite','mature','redhead','brunette','bikini','beach','realistis','shower','asian','latina','ebony','cosplay','goth','milf','campuran','anime','fantasi','cyberpunk','render3d'];
					const raw = (query || '').trim();
					let count = 5;
					let keyword = '';
					const numMatch = raw.match(/\s+(\d{1,2})$/);
					if (numMatch) {
						count = Math.max(1, Math.min(10, parseInt(numMatch[1])));
						keyword = raw.slice(0, numMatch.index).trim().toLowerCase();
					} else if (/^\d{1,2}$/.test(raw)) {
						count = Math.max(1, Math.min(10, parseInt(raw)));
					} else {
						keyword = raw.toLowerCase();
					}

					const fs = await import('fs');
					const path = await import('path');
					const libDir = path.join(process.cwd(), 'cewe_lib');
					const sentPath = path.join(process.cwd(), 'cewe_sent.json');
					const libFiles = fs.existsSync(libDir)
						? fs.readdirSync(libDir).filter(f => f.endsWith('.jpg'))
						: [];

					// Ambil acak dari galeri TANPA mengulang yang sudah dikirim
					const pickLib = (category) => {
						let files = libFiles;
						if (category) files = files.filter(f => f.startsWith(`cewe_${category}_`));
						if (!files.length) return [];
						let sent = [];
						try {
							sent = JSON.parse(fs.readFileSync(sentPath, 'utf-8') || '[]');
							if (!Array.isArray(sent)) sent = [];
						} catch {}
						const sentSet = new Set(sent);
						let pool = files.filter(f => !sentSet.has(f));
						if (pool.length < Math.min(count, files.length)) {
							// semua sudah pernah dikirim -> mulai rotasi baru
							pool = files;
							sent = sent.filter(s => !files.includes(s));
						}
						const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, count);
						try {
							fs.writeFileSync(sentPath, JSON.stringify([...sent, ...picked].slice(-500)));
						} catch {}
						return picked.map(f => path.join(libDir, f));
					};

					// Tanpa keyword -> acak dari galeri
					if (!keyword) {
						const picked = pickLib('');
						if (!picked.length) {
							await m.reply('❌ Galeri kosong, coba lagi nanti.');
							break;
						}
						await m.reply(`💃 Mengirim ${picked.length} gambar...`);
						await sendAlbum(hisoka, m.from, picked);
						break;
					}

					// Keyword = nama kategori -> ambil dari kategori itu
					if (CATS.includes(keyword)) {
						const picked = pickLib(keyword);
						if (!picked.length) {
							await m.reply(`❌ Kategori *${keyword}* kosong.`);
							break;
						}
						await m.reply(`📂 *${keyword}* — mengirim ${picked.length} gambar...`);
						await sendAlbum(hisoka, m.from, picked);
						break;
					}

					// Selain itu -> cari live, fallback ke galeri lokal
					await m.reply(`🔎 Mencari *${keyword}*...`);
					let tmpDir = '';
					try {
						const { searchCivitai, downloadCivitai, cleanupCivitai } = await import('../helper/civitai.js');
						const items = await searchCivitai(keyword, count);
						const dl = await downloadCivitai(items);
						tmpDir = dl.tmpDir;
						await m.reply(`💃 Mengirim ${dl.files.length} gambar...`);
						await sendAlbum(hisoka, m.from, dl.files);
						cleanupCivitai(tmpDir);
					} catch (err) {
						if (tmpDir) {
							try {
								const { cleanupCivitai } = await import('../helper/civitai.js');
								cleanupCivitai(tmpDir);
							} catch {}
						}
						const picked = pickLib('');
						if (picked.length) {
							await m.reply(`⚠️ API sibuk, ambil dari galeri simpanan~ 💃`);
							await sendAlbum(hisoka, m.from, picked);
						} else {
							await m.reply('❌ ' + (err?.message || 'Gagal mengambil gambar.'));
						}
					}
				}
				break;

			case 'sw':
				{
					const sw = readSwConfig();
					const on = v => (v ? 'ON ✅' : 'OFF ❌');
					await m.reply(
						`👁️ *STATUS MONITOR*\n\n` +
							`• Auto-read: ${on(sw.autoread)}\n` +
							`• Auto-react: ${on(sw.autoreact)}\n` +
							`• Auto-reply: ${on(sw.autoreply)} ("${sw.reply_text}")\n` +
							`• React teks: ${sw.react_text ? `"${sw.react_text}"` : '-'}\n` +
							`• Bio uptime: ${on(sw.uptimebio)}\n` +
							`• Mode acak: ${on(sw.random_emoji)}\n` +
							`• Emoji pool (${sw.emoji_pool.length}): ${sw.emoji_pool.join(' ') || '-'}\n\n` +
							`_Atur: .swread on/off | .swreact on/off | .swreply on/off | .swreplytext <teks> | .swreacttext <tulisan> | .uptimebio on/off | .swrandom on/off | .swemoji 😍🔥_`
					);
				}
				break;

			case 'swread':
			case 'swreact':
			case 'swrandom':
			case 'swreply':
				{
					const v = (query || '').trim().toLowerCase();
					const val =
						['on', '1', 'true', 'nyala', 'ya'].includes(v) ? true
						: ['off', '0', 'false', 'mati', 'tidak'].includes(v) ? false
						: null;
					if (val === null) {
						await m.reply(`Pakai: .${m.command} on  atau  .${m.command} off`);
						break;
					}
					const keyMap = { swread: 'autoread', swreact: 'autoreact', swreply: 'autoreply', swrandom: 'random_emoji' };
					const labelMap = { swread: 'Auto-read', swreact: 'Auto-react', swreply: 'Auto-reply teks', swrandom: 'Mode acak' };
					const key = keyMap[m.command];
					const label = labelMap[m.command];
					const sw = writeSwConfig({ [key]: val });
					await m.reply(
						`${label} sekarang *${val ? 'ON ✅' : 'OFF ❌'}*` +
							(key === 'random_emoji' && val
								? `\n_React status akan acak dari: ${sw.emoji_pool.join(' ')}_`
								: '') +
							(key === 'autoreply' && val
								? `\n_Balas status dengan teks: "${sw.reply_text}"_\n_Ubah: .swreplytext <teks>_`
								: '')
					);
				}
				break;

			case 'swreplytext':
				{
					const teks = (query || '').trim();
					if (!teks) {
						const sw = readSwConfig();
						await m.reply(
							`💬 Teks auto-reply saat ini: "${sw.reply_text}"\n\n_Ganti: .swreplytext <teks>_\n_Contoh: .swreplytext hai, statusnya bagus!_`
						);
						break;
					}
					const sw = writeSwConfig({ reply_text: teks.slice(0, 200) });
					await m.reply(`💬 Teks auto-reply diganti: "${sw.reply_text}"`);
				}
				break;

			case 'swreacttext':
				{
					const sw = readSwConfig();
					const teks = (query || '').trim().toLowerCase();
					if (teks === 'off' || teks === 'kosong') {
						writeSwConfig({ react_text: '' });
						await m.reply(`🔤 React teks dimatikan, balik pakai emoji.`);
						break;
					}
					const input = (query || '').trim();
					if (!input) {
						await m.reply(
							`🔤 React teks saat ini: "${sw.react_text || '-'}"\n\n_Pakai: .swreacttext <tulisan>_\n_Acak beberapa: .swreacttext teks1 | teks2 | teks3_\n_Matikan: .swreacttext off_`
						);
						break;
					}
					// Pisahkan pakai | untuk mode acak, tiap opsi max 30 char
					const opts = input.split('|').map(s => s.trim().slice(0, 30)).filter(Boolean);
					if (!opts.length) {
						await m.reply('Tulisannya kosong.');
						break;
					}
					writeSwConfig({ react_text: opts.join(' | ') });
					await m.reply(
						opts.length > 1
							? `🔤 React status sekarang ACAK dari ${opts.length} tulisan:\n${opts.map((o, i) => `${i + 1}. "${o}"`).join('\n')}`
							: `🔤 React status sekarang pakai tulisan: "${opts[0]}"`
					);
				}
				break;

			case 'swemoji':				{
					const emojis = extractEmojis(query);
					if (!emojis.length) {
						const sw = readSwConfig();
						await m.reply(
							`🎲 Emoji pool (${sw.emoji_pool.length}): ${sw.emoji_pool.join(' ') || '-'}\n\n` +
								`_Ganti: .swemoji 😍 🔥 👍_`
						);
						break;
					}
					const sw = writeSwConfig({ emoji_pool: emojis });
					await m.reply(`🎲 Emoji pool diganti (${sw.emoji_pool.length}): ${sw.emoji_pool.join(' ')}`);
				}
				break;

			case 'uptimebio':
				{
					const v = (query || '').trim().toLowerCase();
					const val =
						['on', '1', 'true', 'nyala', 'ya'].includes(v) ? true
						: ['off', '0', 'false', 'mati', 'tidak'].includes(v) ? false
						: null;
					if (val === null) {
						const sw = readSwConfig();
						await m.reply(
							`⏱️ Bio uptime saat ini: *${sw.uptimebio ? 'ON ✅' : 'OFF ❌'}*\n\n` +
								`_Pakai: .uptimebio on  atau  .uptimebio off_\n` +
								`_Kalau ON, bio WA otomatis jadi "🟢 Iyan x m • Online ⏱️ 3j 25m" (update tiap 1 menit)_`
						);
						break;
					}
					writeSwConfig({ uptimebio: val });
					// langsung update bio saat dinyalakan
					if (val) {
						try {
							const s = Math.floor(process.uptime());
							const h = Math.floor(s / 3600);
							const mnt = Math.floor((s % 3600) / 60);
							const up = h > 0 ? `${h}j ${mnt}m` : `${mnt}m`;
							const bio = `🟢 Iyan x m • Online ⏱️ ${up}`;
							await hisoka.updateProfileStatus(bio);
							console.log(`\x1b[36m[uptimebio] Bio diupdate via command: ${bio}\x1b[39m`);
						} catch (err) {
							console.error('\x1b[31m[uptimebio] Gagal via command:\x1b[39m', err?.message || err);
							await m.reply(`⚠️ Gagal update bio: ${err?.message || err}`);
						}
					}
					await m.reply(`⏱️ Bio uptime sekarang *${val ? 'ON ✅' : 'OFF ❌'}*`);
				}
				break;

			default:
			// Handle other commands or messages
		}
	} catch (error) {
		console.error(`\x1b[31mError in message handler:\x1b[39m\n`, error);
	}
}
