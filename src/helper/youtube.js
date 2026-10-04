'use strict';

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

// Pakai yt-dlp yang sudah tersedia, jangan install ulang
const YTDLP = process.env.YTDLP_PATH || '/home/hatch/workspace/tiktokbot/venv/bin/yt-dlp';

// Durasi maksimal lagu: 20 menit (biar file tidak terlalu besar)
const MAX_DURATION = 20 * 60;

/**
 * Cari video YouTube pertama dari kata kunci lalu unduh audionya (mp3).
 * @param {string} query kata kunci pencarian, mis. "iqro - maher zain"
 * @returns {Promise<{file: string, title: string, duration: number}>}
 */
export async function downloadYouTubeAudio(query) {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'));

	try {
		// 1. Cari info video pertama (tanpa download)
		const { stdout } = await execFileAsync(
			YTDLP,
			[
				'--no-playlist',
				'--extractor-args',
				'youtube:player_client=android',
				'--dump-json',
				'--socket-timeout',
				'30',
				`ytsearch1:${query}`,
			],
			{ timeout: 90000, maxBuffer: 10 * 1024 * 1024 }
		);

		let info;
		try {
			info = JSON.parse(stdout.trim().split('\n').pop());
		} catch {
			throw new Error('Tidak ketemu hasilnya, coba kata kunci lain.');
		}

		if (!info || !info.id) {
			throw new Error('Tidak ketemu hasilnya, coba kata kunci lain.');
		}

		const duration = Number(info.duration || 0);
		if (duration > MAX_DURATION) {
			throw new Error(`Kepanjangan (${Math.round(duration / 60)} mnt), maksimal 20 menit.`);
		}

		const title = info.title || info.id;

		// 2. Unduh audio -> mp3
		await execFileAsync(
			YTDLP,
			[
				'--no-playlist',
				'--extractor-args',
				'youtube:player_client=android',
				'--retries',
				'3',
				'--socket-timeout',
				'30',
				'--extract-audio',
				'--audio-format',
				'mp3',
				'--audio-quality',
				'0',
				'-o',
				path.join(tmpDir, '%(id)s.%(ext)s'),
				info.webpage_url || `https://www.youtube.com/watch?v=${info.id}`,
			],
			{ timeout: 600000 }
		);

		const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp3'));
		if (!files.length) {
			throw new Error('File audio tidak ditemukan setelah download.');
		}

		return { file: path.join(tmpDir, files[0]), title, duration };
	} catch (err) {
		// Bersihkan temp kalau gagal
		fs.rmSync(tmpDir, { recursive: true, force: true });
		if (err && /^(Tidak ketemu|Kepanjangan|File audio)/.test(err.message)) throw err;
		throw new Error('Gagal mengunduh audio. Coba lagi atau ganti kata kunci.');
	}
}

/**
 * Hapus file hasil download beserta direktori temp-nya.
 * @param {string} filePath path file dari downloadYouTubeAudio()
 */
export function cleanupYouTubeAudio(filePath) {
	try {
		fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
	} catch {
		// abaikan
	}
}
