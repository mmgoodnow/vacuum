import type { TautulliConfig } from "./types.ts";

const API_PATH = "api/v2";
const DEFAULT_PAGE_SIZE = 500;

interface TautulliResponse<T> {
	response: {
		result: "success" | "error";
		message?: string;
		data: T;
	};
}

export interface TautulliLibrary {
	section_id: number;
	section_name: string;
	section_type: string;
	count: number;
}

export interface TautulliMediaItem {
	rating_key: string;
	media_type: "movie" | "show" | "season" | "episode";
	title: string;
	parent_rating_key?: string | null;
	parent_title?: string | null;
	grandparent_rating_key?: string | null;
	grandparent_title?: string | null;
	file?: string | null;
	size?: number | null;
	added_at?: number | null;
	last_played?: number | null;
	play_count?: number | null;
	media_index?: number | null;
	season_index?: number | null;
	section_id: number;
	section_name: string;
	year?: number | null;
}

interface LibraryMediaResponse {
	data: TautulliMediaItem[];
	recordsFiltered: number;
	recordsTotal: number;
}

export class TautulliClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(config: TautulliConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
	}

	async getLibraries(): Promise<TautulliLibrary[]> {
		const data = await this.request<{ libraries: TautulliLibrary[] }>(
			"get_libraries",
		);
		return data.libraries ?? [];
	}

	async getLibraryMediaItems(sectionId: number): Promise<TautulliMediaItem[]> {
		const items: TautulliMediaItem[] = [];
		let start = 0;

		while (true) {
			const page = await this.request<LibraryMediaResponse>(
				"get_library_media_info",
				{
					section_id: sectionId,
					start,
					length: DEFAULT_PAGE_SIZE,
					order_column: "title",
					order_dir: "asc",
				},
			);

			if (Array.isArray(page.data)) {
				items.push(...page.data);
			}

			if (!page.data || page.data.length < DEFAULT_PAGE_SIZE) {
				break;
			}

			start += DEFAULT_PAGE_SIZE;
		}

		return items;
	}

	private async request<T>(
		cmd: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		const url = new URL(
			API_PATH,
			this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`,
		);
		url.searchParams.set("apikey", this.apiKey);
		url.searchParams.set("cmd", cmd);

		for (const [key, value] of Object.entries(params)) {
			if (value === undefined || value === null) {
				continue;
			}
			url.searchParams.set(key, String(value));
		}

		const response = await fetch(url, {
			headers: {
				accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(
				`Tautulli request failed with status ${response.status}: ${response.statusText}`,
			);
		}

		const payload = (await response.json()) as TautulliResponse<T>;
		if (payload.response.result !== "success") {
			throw new Error(
				`Tautulli error: ${payload.response.message ?? "Unknown error"}`,
			);
		}

		return payload.response.data;
	}
}
