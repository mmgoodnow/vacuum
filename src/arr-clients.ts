import type { ArrConfig } from "./types.ts";

export interface ExternalIds {
	tvdbId?: number | null;
	tmdbId?: number | null;
	imdbId?: string | null;
}

interface SonarrSeason {
	seasonNumber: number;
	monitored: boolean;
}

interface SonarrSeries {
	id: number;
	title: string;
	tvdbId?: number | null;
	tmdbId?: number | null;
	imdbId?: string | null;
	seasons?: SonarrSeason[];
	monitored?: boolean;
}

interface RadarrMovie {
	id: number;
	title: string;
	tmdbId?: number | null;
	imdbId?: string | null;
	monitored: boolean;
}

export class SonarrClient {
	private readonly baseUrl: URL;
	private readonly apiKey: string;
	private readonly log: ((message: string) => void) | null;
	private seriesCache: SonarrSeries[] | null = null;

	constructor(config: ArrConfig, logger?: (message: string) => void) {
		this.baseUrl = new URL(
			config.baseUrl.endsWith("/")
				? config.baseUrl
				: `${config.baseUrl}/`,
		);
		this.apiKey = config.apiKey;
		this.log = logger ?? null;
	}

	async findSeriesByExternalIds(
		ids: ExternalIds,
	): Promise<SonarrSeries | null> {
		const seriesList = await this.getSeriesIndex();
		return (
			seriesList.find((series) => matchesExternalIds(series, ids)) ?? null
		);
	}

	async unmonitorSeasons(
		seriesId: number,
		seasonNumbers: number[],
	): Promise<void> {
		if (!seasonNumbers.length) {
			return;
		}
		const series = await this.request<SonarrSeries>(
			"GET",
			`/series/${seriesId}`,
		);
		const seasons = Array.isArray(series.seasons)
			? [...series.seasons]
			: [];
		let modified = false;
		for (const season of seasons) {
			if (
				seasonNumbers.includes(season.seasonNumber) &&
				season.monitored
			) {
				season.monitored = false;
				modified = true;
			}
		}
		if (!modified) {
			this.log?.(
				`[Sonarr] No monitored seasons matched for series ${seriesId}.`,
			);
			return;
		}
		const payload = { ...series, seasons };
		await this.request("PUT", `/series/${seriesId}`, payload);
		this.log?.(
			`[Sonarr] Updated series ${seriesId}, disabled seasons ${seasonNumbers.join(", ")}.`,
		);
	}

	private async getSeriesIndex(): Promise<SonarrSeries[]> {
		if (this.seriesCache) {
			return this.seriesCache;
		}
		this.seriesCache = await this.request<SonarrSeries[]>("GET", "/series");
		return this.seriesCache;
	}

	private async request<T>(
		method: "GET" | "PUT",
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = new URL(`api/v3${path}`, this.baseUrl);
		const init: RequestInit = {
			method,
			headers: {
				"Content-Type": "application/json",
				"X-Api-Key": this.apiKey,
			},
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}
		const response = await fetch(url, init);
		if (!response.ok) {
			throw new Error(
				`Sonarr request ${method} ${path} failed: ${response.status} ${response.statusText}`,
			);
		}
		if (response.status === 204) {
			return undefined as T;
		}
		return (await response.json()) as T;
	}
}

export class RadarrClient {
	private readonly baseUrl: URL;
	private readonly apiKey: string;
	private readonly log: ((message: string) => void) | null;
	private movieCache: RadarrMovie[] | null = null;

	constructor(config: ArrConfig, logger?: (message: string) => void) {
		this.baseUrl = new URL(
			config.baseUrl.endsWith("/")
				? config.baseUrl
				: `${config.baseUrl}/`,
		);
		this.apiKey = config.apiKey;
		this.log = logger ?? null;
	}

	async findMovieByExternalIds(
		ids: ExternalIds,
	): Promise<RadarrMovie | null> {
		const movies = await this.getMovieIndex();
		return (
			movies.find((movie) => matchesMovieExternalIds(movie, ids)) ?? null
		);
	}

	async unmonitorMovie(movieId: number): Promise<void> {
		const movie = await this.request<RadarrMovie>(
			"GET",
			`/movie/${movieId}`,
		);
		if (!movie.monitored) {
			this.log?.(`[Radarr] Movie ${movieId} already unmonitored.`);
			return;
		}
		const payload = { ...movie, monitored: false };
		await this.request("PUT", `/movie/${movieId}`, payload);
		this.log?.(`[Radarr] Unmonitored movie ${movie.title} (${movieId}).`);
	}

	private async getMovieIndex(): Promise<RadarrMovie[]> {
		if (this.movieCache) {
			return this.movieCache;
		}
		this.movieCache = await this.request<RadarrMovie[]>("GET", "/movie");
		return this.movieCache;
	}

	private async request<T>(
		method: "GET" | "PUT",
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = new URL(`api/v3${path}`, this.baseUrl);
		const init: RequestInit = {
			method,
			headers: {
				"Content-Type": "application/json",
				"X-Api-Key": this.apiKey,
			},
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
		}
		const response = await fetch(url, init);
		if (!response.ok) {
			throw new Error(
				`Radarr request ${method} ${path} failed: ${response.status} ${response.statusText}`,
			);
		}
		if (response.status === 204) {
			return undefined as T;
		}
		return (await response.json()) as T;
	}
}

function matchesExternalIds(series: SonarrSeries, ids: ExternalIds): boolean {
	if (ids.tvdbId && series.tvdbId === ids.tvdbId) {
		return true;
	}
	if (ids.tmdbId && series.tmdbId === ids.tmdbId) {
		return true;
	}
	if (ids.imdbId && ids.imdbId && series.imdbId) {
		return series.imdbId.toLowerCase() === ids.imdbId.toLowerCase();
	}
	return false;
}

function matchesMovieExternalIds(
	movie: RadarrMovie,
	ids: ExternalIds,
): boolean {
	if (ids.tmdbId && movie.tmdbId === ids.tmdbId) {
		return true;
	}
	if (ids.imdbId && movie.imdbId) {
		return movie.imdbId.toLowerCase() === ids.imdbId.toLowerCase();
	}
	return false;
}
