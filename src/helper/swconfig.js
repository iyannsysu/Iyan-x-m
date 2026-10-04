'use strict';

import fs from 'fs';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'swconfig.json');

const DEFAULTS = {
	// Baca status otomatis (tandai "dibaca")
	autoread: true,
	// Kirim react otomatis ke status
	autoreact: true,
	// true = emoji acak dari emoji_pool untuk semua status
	// false = pakai custom per kontak (react.json), fallback acak dari pool
	random_emoji: false,
	// Kumpulan emoji untuk mode acak (bisa diubah via .swemoji)
	emoji_pool: ['❤️', '😍', '🔥', '👍', '😮', '🥰', '💯', '👏', '😎', '🎉'],
	// Balas status otomatis dengan TEKS (via .swreply on/off, teks via .swreplytext)
	// Kalau ON, bot kirim pesan teks ke DM yang bikin status (bukan emoji react)
	autoreply: false,
	reply_text: 'hai',
	// Teks custom untuk REACT status (via .swreacttext). Kalau diisi, react pakai
	// tulisan ini gantiin emoji. Kosongkan = pakai emoji seperti biasa.
	react_text: '',
	// Bio WA otomatis tampilkan uptime bot (via .uptimebio on/off).
	// Kalau ON, bio diupdate tiap 10 menit: "🟢 Iyan x m • Online ⏱️ 3j 25m"
	uptimebio: false,
};

/**
 * Baca config status (selalu dari disk, jadi bisa diubah tanpa restart).
 * Kalau file belum ada / rusak -> pakai default dan buat file baru.
 * @returns {{autoread:boolean, autoreact:boolean, random_emoji:boolean, emoji_pool:string[]}}
 */
export function readSwConfig() {
	let file = null;
	try {
		file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8') || '{}');
	} catch {
		file = null;
	}
	const cfg = { ...DEFAULTS, ...(file || {}) };
	if (!Array.isArray(cfg.emoji_pool)) cfg.emoji_pool = [...DEFAULTS.emoji_pool];
	cfg.autoread = cfg.autoread !== false;
	cfg.autoreact = cfg.autoreact !== false;
	cfg.random_emoji = cfg.random_emoji === true;
	cfg.autoreply = cfg.autoreply === true;
	if (typeof cfg.reply_text !== 'string' || !cfg.reply_text.trim()) cfg.reply_text = 'hai';
	if (typeof cfg.react_text !== 'string') cfg.react_text = '';
	cfg.uptimebio = cfg.uptimebio === true;
	// Buat file kalau belum ada / rusak, biar user bisa edit manual
	if (!file) {
		try {
			fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
		} catch {
			// abaikan
		}
	}
	return cfg;
}

/**
 * Update sebagian config lalu simpan.
 * @param {Partial<{autoread:boolean, autoreact:boolean, random_emoji:boolean, emoji_pool:string[]}>>} patch
 */
export function writeSwConfig(patch) {
	const cfg = readSwConfig();
	const next = { ...cfg, ...patch };
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
	return next;
}

/**
 * Pilih emoji untuk status dari nomor pengirim.
 * @param {string} senderNum nomor pengirim (digit saja)
 * @param {{random_emoji:boolean, emoji_pool:string[]}} cfg
 * @returns {string} emoji atau '' kalau tidak ada yang cocok
 */
export function pickEmoji(senderNum, cfg) {
	const pool = (cfg.emoji_pool || []).filter(Boolean);

	// Mode acak: langsung ambil dari pool
	if (cfg.random_emoji) {
		if (!pool.length) return fallbackEnvEmoji();
		return pool[Math.floor(Math.random() * pool.length)];
	}

	// Mode custom: cek react.json dulu
	try {
		const reactCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'react.json'), 'utf-8') || '{}');
		const custom = reactCfg[senderNum] || reactCfg.default || '';
		if (custom) return custom;
	} catch {
		// react.json tidak ada / rusak -> lanjut ke pool
	}

	if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
	return fallbackEnvEmoji();
}

/** Fallback terakhir: env lama BOT_REACT_STATUS (kompatibilitas). */
function fallbackEnvEmoji() {
	const list = (process.env.BOT_REACT_STATUS || '').split(',').map(s => s.trim()).filter(Boolean);
	if (!list.length) return '';
	return list[Math.floor(Math.random() * list.length)];
}

/**
 * Ambil semua emoji dari teks (untuk .swemoji 😍 🔥 ...).
 * @param {string} text
 * @returns {string[]}
 */
export function extractEmojis(text) {
	const found = (text || '').match(/\p{Extended_Pictographic}/gu) || [];
	// buang duplikat, pertahankan urutan
	return [...new Set(found)];
}
