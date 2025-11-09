import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CachedEpisode {
	rating_key: string;
	media_type: "episode";
	title: string;
	parent_rating_key?: string | null;
	parent_title?: string | null;
	grandparent_rating_key?: string | null;
	grandparent_title?: string | null;
	file?: string | null;
	added_at?: number | null;
	last_played?: number | null;
	play_count?: number | null;
	media_index?: number | null;
	season_index?: number | null;
	section_id: number;
	section_name: string;
	year?: number | null;
}

interface CacheRow {
	show_updated_at: number;
	fetched_at: number;
	payload: string;
}

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export class EpisodeCache {
	private readonly db: DatabaseSync;

	constructor(databasePath: string) {
		const dir = path.dirname(databasePath);
		mkdirSync(dir, { recursive: true });
		this.db = new DatabaseSync(databasePath);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS episode_cache (
				show_key TEXT PRIMARY KEY,
				show_updated_at INTEGER NOT NULL,
				fetched_at INTEGER NOT NULL,
				payload TEXT NOT NULL
			);
		`);
	}

	load(showKey: string, showUpdatedAt: number): CachedEpisode[] | null {
		const row = this.db
			.prepare("SELECT show_updated_at, fetched_at, payload FROM episode_cache WHERE show_key = ?")
			.get(showKey) as CacheRow | undefined;

		if (!row) {
			return null;
		}

		if (row.show_updated_at !== showUpdatedAt) {
			this.delete(showKey);
			return null;
		}

		const fetchedAt = Number(row.fetched_at ?? 0);
		if (!Number.isFinite(fetchedAt)) {
			this.delete(showKey);
			return null;
		}

		if (Date.now() - fetchedAt > CACHE_TTL_MS) {
			this.delete(showKey);
			return null;
		}

		if (typeof row.payload !== "string") {
			this.delete(showKey);
			return null;
		}

		try {
			const parsed = JSON.parse(row.payload) as CachedEpisode[];
			return parsed;
		} catch {
			this.delete(showKey);
			return null;
		}
	}

	save(showKey: string, showUpdatedAt: number, episodes: CachedEpisode[]): void {
		const payload = JSON.stringify(episodes);
		const fetchedAt = Date.now();
		const normalizedUpdatedAt = Number(showUpdatedAt) || 0;
		this.db
			.prepare(
				`INSERT INTO episode_cache (show_key, show_updated_at, fetched_at, payload)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(show_key) DO UPDATE SET
					show_updated_at=excluded.show_updated_at,
					fetched_at=excluded.fetched_at,
					payload=excluded.payload`,
			)
			.run(showKey, normalizedUpdatedAt, fetchedAt, payload);
	}

	clear(): void {
		this.db.exec("DELETE FROM episode_cache");
	}

	private delete(showKey: string): void {
		this.db
			.prepare("DELETE FROM episode_cache WHERE show_key = ?")
			.run(showKey);
	}
}
