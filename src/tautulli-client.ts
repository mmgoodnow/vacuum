import type { TautulliConfig } from "./types.ts";

const API_PATH = "api/v2";
const DEFAULT_PAGE_SIZE = 500;

interface TautulliSuccessResponse<T> {
    result: "success";
    message?: string;
    data: T;
}

interface TautulliErrorResponse {
    result: "error";
    message?: string;
    data?: unknown;
}

type TautulliResponse<T> =
    | { response: TautulliSuccessResponse<T> }
    | { response: TautulliErrorResponse };

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
	private readonly log: ((message: string) => void) | null;

	constructor(config: TautulliConfig, logger?: (message: string) => void) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.log = logger ?? null;
	}

	async getServerInfo(): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>("get_server_info");
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

		if (this.log) {
			const safeUrl = new URL(url);
			safeUrl.searchParams.set("apikey", "***");
			this.log(
				`[Tautulli] Request cmd=${cmd} url=${safeUrl.toString()}`,
			);
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
            this.log?.(
                `[Tautulli] Response cmd=${cmd} status=error message=${payload.response.message ?? "(none)"}`,
            );
            throw new Error(
                `Tautulli error: ${payload.response.message ?? "Unknown error"}`,
            );
        }

        const data = payload.response.data;
        if (this.log) {
            const describeData = (value: unknown): string => {
                if (value === null || value === undefined) {
                    return String(value);
                }
                if (Array.isArray(value)) {
                    return `array(len=${value.length})`;
                }
                if (typeof value === "object") {
                    return `object(keys=${Object.keys(value).join(",")})`;
                }
                return String(value);
            };

            this.log(
                `[Tautulli] Response cmd=${cmd} status=success data=${describeData(data)}`,
            );
        }

        return data;
	}
}
