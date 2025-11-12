export interface TautulliConfig {
	baseUrl: string;
	apiKey: string;
}

export interface ArrConfig {
	baseUrl: string;
	apiKey: string;
}

export interface AppConfig {
	tautulli: TautulliConfig | null;
	sonarr: ArrConfig | null;
	radarr: ArrConfig | null;
	libraryPaths: string[];
	blockedTitles: string[];
	weights: WeightConfig;
	cachePath: string;
}

export type MediaKind = "movie" | "season";

export interface MediaSource {
	id: string;
	title: string;
	relativePath?: string | null;
	path: string;
	sizeBytes: number;
	addedAt: Date;
	lastPlayedAt?: Date | null;
	playCount: number;
	episodeIndex?: number | null;
	seasonTitle?: string | null;
	showTitle?: string | null;
	seasonKey?: string | null;
	showKey?: string | null;
	librarySectionId: number;
	librarySectionName: string;
	mediaKind: MediaKind | "episode";
}

export interface MediaUnit {
	id: string;
	kind: MediaKind;
	title: string;
	parentTitle?: string | null;
	librarySectionId: number;
	librarySectionName: string;
	sizeBytes: number;
	addedAt: Date;
	lastPlayedAt?: Date | null;
	totalPlayCount: number;
	maxItemPlayCount: number;
	itemsWithPlays: number;
	itemCount: number;
	paths: string[];
	sourceItems: MediaSource[];
}

export interface WeightConfig {
	sizeWeight: number;
	ageWeight: number;
	watchWeight: number;
}

export interface ScoringMetrics {
	sizeScore: number;
	ageScore: number;
	watchScarcityScore: number;
	playsPerYear: number;
	playsPerGb: number;
	coverageRatio: number;
	ageYears: number;
}

export interface ScoredMediaUnit extends MediaUnit {
	score: number;
	metrics: ScoringMetrics;
	isProtectedSeason?: boolean;
}
