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

interface RawTautulliLibrary {
	section_id: number | string;
	section_name: string;
	section_type: string;
	count: number | string;
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
	updated_at?: number | null;
}

interface LibraryMediaResponse {
	data: TautulliMediaItem[];
	recordsFiltered: number;
	recordsTotal: number;
}

interface LibraryMediaOptions {
	refresh?: boolean;
	sectionType?: string;
	ratingKey?: string;
}

interface MetadataDetailsResponse {
	metadata?: Array<{ view_count?: number | null }>;
}

export class TautulliClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly log: ((message: string) => void) | null;
	private readonly metadataFileCache = new Map<string, string | null>();
	private readonly commandLogCounters = new Map<string, number>();
	private metadataNoFileLogCount = 0;

	constructor(config: TautulliConfig, logger?: (message: string) => void) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.apiKey = config.apiKey;
		this.log = logger ?? null;
	}

	async getServerInfo(): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>("get_server_info");
	}

	async getLibraries(): Promise<TautulliLibrary[]> {
		const data = await this.request<
			RawTautulliLibrary[] | { libraries: RawTautulliLibrary[] }
		>("get_libraries");
		const libraries = Array.isArray(data)
			? data
			: Array.isArray(data?.libraries)
				? data.libraries
				: [];
		return libraries.map(normalizeLibrary);
	}

	async getLibraryMediaItems(
		sectionId: number,
		options: LibraryMediaOptions = {},
	): Promise<TautulliMediaItem[]> {
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
					include: "file",
					media_info: 1,
					grouping: options.sectionType === "show" ? 0 : undefined,
					children: options.sectionType === "show" ? 1 : undefined,
					refresh: options.refresh ? "true" : undefined,
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

	async getChildrenMetadata(
		ratingKey: string,
		mediaType: "show" | "season",
	): Promise<TautulliMediaItem[]> {
		const data = await this.request<ChildrenMetadataResponse>(
			"get_children_metadata",
			{
				rating_key: ratingKey,
				media_type: mediaType,
			},
		);

		const list = Array.isArray(data.children_list)
			? data.children_list
			: [];

		const normalized: TautulliMediaItem[] = [];
		for (const child of list) {
			const item = normalizeChildItem(child);
			if (item) {
				normalized.push(item);
			}
		}
		return normalized;
	}

	async getMediaItemFilePath(ratingKey: string): Promise<string | null> {
		if (!ratingKey) {
			return null;
		}

		if (this.metadataFileCache.has(ratingKey)) {
			return this.metadataFileCache.get(ratingKey) ?? null;
		}

		try {
			const data = await this.request<unknown>("get_metadata", {
				rating_key: ratingKey,
				include: "media_info",
			});
			const metadata = unwrapMetadataPayload(data);
			const filePath = extractFilePathFromMetadata(metadata);
			if (!filePath) {
				if (this.metadataNoFileLogCount < 5) {
					this.log?.(
						`[Tautulli] Metadata lookup for ${ratingKey} returned no file path. Sample payload: ${safeStringify(metadata)}`,
					);
				} else if (this.metadataNoFileLogCount === 5) {
					this.log?.(
						"[Tautulli] Further metadata payload logging suppressed.",
					);
				}
				this.metadataNoFileLogCount += 1;
			}
			this.metadataFileCache.set(ratingKey, filePath ?? null);
			return filePath ?? null;
		} catch (error) {
			this.metadataFileCache.set(ratingKey, null);
			throw error;
		}
	}

	async getEpisodePlayCount(ratingKey: string): Promise<number | null> {
		try {
			const data = await this.request<MetadataDetailsResponse>(
				"get_metadata",
				{
					rating_key: ratingKey,
				},
			);
			const metadata = Array.isArray(data.metadata) ? data.metadata[0] : null;
			if (metadata && metadata.view_count !== undefined && metadata.view_count !== null) {
				return Number(metadata.view_count);
			}
			return null;
		} catch (error) {
			this.log?.(
				`[Tautulli] Failed to get view count for ${ratingKey}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	async deleteMediaInfoCache(sectionId: number): Promise<string | null> {
		const result = await this.request<{ message?: string }>(
			"delete_media_info_cache",
			{ section_id: sectionId },
		);
		if (result && typeof result === "object" && "message" in result) {
			const message = result.message;
			return typeof message === "string" ? message : null;
		}
		return null;
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

		const shouldLog = this.shouldLog(cmd);
		if (shouldLog && this.log) {
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
		if (shouldLog && this.log) {
			this.log(
				`[Tautulli] Response cmd=${cmd} status=success data=${describeTautulliData(data)}`,
			);
		}

		return data;
	}

	private shouldLog(cmd: string): boolean {
		if (!this.log) {
			return false;
		}
		if (cmd !== "get_metadata") {
			return true;
		}

		const count = this.commandLogCounters.get(cmd) ?? 0;
		if (count < 5) {
			this.commandLogCounters.set(cmd, count + 1);
			return true;
		}

		if (count === 5) {
			this.commandLogCounters.set(cmd, count + 1);
			this.log(
				`[Tautulli] Suppressing further ${cmd} logs after first 5 entries.`,
			);
		} else {
			this.commandLogCounters.set(cmd, count + 1);
		}

		return false;
	}
}

function normalizeLibrary(raw: RawTautulliLibrary): TautulliLibrary {
	return {
		section_id: Number(raw.section_id),
		section_name: raw.section_name,
		section_type: raw.section_type,
		count: Number(raw.count),
	};
}

function normalizeChildItem(raw: RawChildItem): TautulliMediaItem | null {
	const ratingKey = raw.rating_key;
	const mediaType = raw.media_type;

	if (!ratingKey || !mediaType) {
		return null;
	}

	if (
		mediaType !== "movie" &&
		mediaType !== "show" &&
		mediaType !== "season" &&
		mediaType !== "episode"
	) {
		return null;
	}

	const sectionId = Number(raw.section_id ?? 0);
	const sectionName = raw.section_name ?? raw.library_name ?? "Unknown";

	return {
		rating_key: String(ratingKey),
		media_type: mediaType,
		title: raw.title ?? "",
		parent_rating_key: raw.parent_rating_key ?? null,
		parent_title: raw.parent_title ?? null,
		grandparent_rating_key: raw.grandparent_rating_key ?? null,
		grandparent_title: raw.grandparent_title ?? null,
		file: raw.file ?? null,
		size: null,
		added_at: raw.added_at ? Number(raw.added_at) : null,
		last_played: raw.last_played ? Number(raw.last_played) : null,
		play_count: raw.play_count ? Number(raw.play_count) : null,
		media_index: raw.media_index ? Number(raw.media_index) : null,
		season_index: raw.season_index ? Number(raw.season_index) : null,
		section_id: Number.isFinite(sectionId) ? sectionId : 0,
		section_name: sectionName,
		year: raw.year ? Number(raw.year) : null,
	};
}

function unwrapMetadataPayload(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") {
		return payload;
	}

	let current: unknown = payload;
	const visited = new Set<unknown>();

	while (current && typeof current === "object" && !visited.has(current)) {
		visited.add(current);
		const record = current as Record<string, unknown>;

		if ("metadata" in record && record.metadata) {
			current = record.metadata;
			continue;
		}

		if ("data" in record && record.data) {
			current = record.data;
			continue;
		}

		break;
	}

	return current;
}

const FILE_PATH_KEYS = new Set(["file", "file_path", "filepath", "fullpath", "path"]);

function extractFilePathFromMetadata(metadata: unknown): string | null {
	const visited = new Set<unknown>();
	const stack: unknown[] = [metadata];

	while (stack.length) {
		const current = stack.pop();
		if (current === undefined || current === null) {
			continue;
		}

		if (typeof current === "string") {
			if (isLikelyFileSystemPath(current)) {
				return current;
			}
			continue;
		}

		if (typeof current !== "object") {
			continue;
		}

		if (visited.has(current)) {
			continue;
		}
		visited.add(current);

		if (Array.isArray(current)) {
			for (const value of current) {
				stack.push(value);
			}
			continue;
		}

		const record = current as Record<string, unknown>;

		for (const [key, value] of Object.entries(record)) {
			if (typeof value === "string") {
				if (
					FILE_PATH_KEYS.has(key.toLowerCase()) &&
					isLikelyFileSystemPath(value)
				) {
					return value;
				}
			}
		}

		for (const value of Object.values(record)) {
			stack.push(value);
		}
	}

	return null;
}

function isLikelyFileSystemPath(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}
	if (!(trimmed.includes("/") || trimmed.includes("\\"))) {
		return false;
	}
	if (trimmed.startsWith("/library/metadata/")) {
		return false;
	}
	const segments = trimmed.split(/[\\/]/);
	const lastSegment = segments[segments.length - 1] ?? "";
	if (!lastSegment) {
		return false;
	}
	return lastSegment.includes(".");
}

function describeTautulliData(value: unknown): string {
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
}

function safeStringify(value: unknown, maxLength = 500): string {
	try {
		const serialized = JSON.stringify(value, null, 2);
		if (serialized.length > maxLength) {
			return `${serialized.slice(0, maxLength)}… (truncated)`;
		}
		return serialized;
	} catch {
		return "[unserializable payload]";
	}
}
interface ChildrenMetadataResponse {
	children_list?: RawChildItem[] | null;
}

interface RawChildItem {
	rating_key?: string | number | null;
	media_type?: string | null;
	title?: string | null;
	parent_rating_key?: string | null;
	parent_title?: string | null;
	grandparent_rating_key?: string | null;
	grandparent_title?: string | null;
	section_id?: string | number | null;
	section_name?: string | null;
	library_name?: string | null;
	added_at?: number | string | null;
	last_played?: number | string | null;
	play_count?: number | string | null;
	media_index?: number | string | null;
	season_index?: number | string | null;
	year?: number | string | null;
	file?: string | null;
}
