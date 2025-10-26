export interface MediaItem {
	id: string;
	title: string;
	librarySection?: string;
	path: string;
	sizeBytes: number;
	addedAt: Date;
	lastPlayedAt?: Date | null;
	playCount: number;
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
	ageYears: number;
}

export interface ScoredMediaItem extends MediaItem {
	score: number;
	metrics: ScoringMetrics;
}

export interface TautulliConfig {
	baseUrl: string;
	apiKey: string;
}

export interface AppConfig {
	tautulli: TautulliConfig | null;
	libraryPaths: string[];
	weights: WeightConfig;
	cachePath: string;
}
