import type { TautulliMediaItem, TautulliClient } from "./tautulli-client.ts";
import { EpisodeCache, type CachedEpisode } from "./episode-cache.ts";
import { ProgressReporter } from "./progress-reporter.ts";

interface FetchContext {
	libraryName: string;
	showIndex: number;
	totalShows: number;
}

interface FetchOptions {
	progress?: ProgressReporter;
	verbose?: boolean;
}

export class EpisodeFetcher {
	private readonly client: TautulliClient;
	private readonly cache: EpisodeCache;
	private readonly logger: ((message: string) => void) | undefined;

	constructor(
		client: TautulliClient,
		cache: EpisodeCache,
		logger?: (message: string) => void,
	) {
		this.client = client;
		this.cache = cache;
		this.logger = logger;
	}

	async fetchEpisodesForShow(
		show: TautulliMediaItem,
		context: FetchContext,
		options: FetchOptions = {},
	): Promise<TautulliMediaItem[]> {
		const logFn = options.verbose
			? this.logger ?? ((message: string) => console.error(message))
			: undefined;
		const progress = options.progress;

		const showKey = show.rating_key;
		progress?.start(show.title);
		const showUpdatedAt = this.getUpdateToken(show);

		const cached = this.cache.load(showKey, showUpdatedAt);
		try {
			if (cached) {
				logFn?.(
					`[TV] Cache hit for "${show.title}" (${context.showIndex}/${context.totalShows})`,
				);
				return cached.map((episode) => this.toMediaItem(episode));
			}

			logFn?.(
				`[TV] Fetching episodes for "${show.title}" (${context.showIndex}/${context.totalShows})`,
			);

		const seasons = await this.client.getChildrenMetadata(show.rating_key, "show");
		logFn?.(
			`[TV] "${show.title}" has ${seasons.length} season(s); crawling episodes...`,
		);

		const episodes: CachedEpisode[] = [];
		let processedSeasons = 0;
		for (const season of seasons) {
			if (season.media_type !== "season" || !season.rating_key) {
				continue;
			}
			processedSeasons += 1;
			const seasonLabel =
				season.title ??
				(season.media_index ? `Season ${season.media_index}` : `Season #${processedSeasons}`);
			logFn?.(
				`[TV]   → ${seasonLabel}: fetching episode metadata (${processedSeasons}/${seasons.length})`,
			);
			const seasonEpisodes = await this.client.getChildrenMetadata(season.rating_key, "season");

			for (const episode of seasonEpisodes) {
				if (episode.media_type !== "episode") {
					continue;
				}
				const filePath = await this.client.getMediaItemFilePath(
					episode.rating_key,
				);
				let playCount = episode.play_count ?? null;
				if (playCount === null || playCount === undefined) {
					const lookedUp = await this.client.getEpisodePlayCount(episode.rating_key);
					playCount = lookedUp ?? null;
				}
				const cachedEpisode: CachedEpisode = {
					rating_key: episode.rating_key,
					media_type: "episode",
					title: episode.title,
					parent_rating_key: episode.parent_rating_key ?? null,
					parent_title: episode.parent_title ?? null,
					grandparent_rating_key: episode.grandparent_rating_key ?? null,
					grandparent_title: episode.grandparent_title ?? null,
					file: filePath ?? episode.file ?? null,
					added_at: episode.added_at ?? null,
					last_played: episode.last_played ?? null,
					play_count: playCount ?? null,
					media_index: episode.media_index ?? null,
					season_index: episode.season_index ?? null,
					section_id: episode.section_id,
					section_name: episode.section_name || context.libraryName,
					year: episode.year ?? null,
				};
				episodes.push(cachedEpisode);
			}
		}

			this.cache.save(showKey, showUpdatedAt, episodes);
			logFn?.(
				`[TV] Completed "${show.title}" — cached ${episodes.length} episode(s).`,
			);
			return episodes.map((episode) => this.toMediaItem(episode));
		} finally {
			progress?.finish(show.title);
		}
	}

	private getUpdateToken(item: TautulliMediaItem): number {
		const timestamp =
			Number(item.updated_at ?? item.added_at ?? Date.now() / 1000) * 1000;
		return Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now();
	}

	private toMediaItem(episode: CachedEpisode): TautulliMediaItem {
		return {
			...episode,
			section_id: episode.section_id,
			section_name: episode.section_name,
		};
	}
}
