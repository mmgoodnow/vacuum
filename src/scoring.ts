import type {
	MediaItem,
	ScoredMediaItem,
	ScoringMetrics,
	WeightConfig,
} from "./types.ts";

const YEAR_IN_MS = 1000 * 60 * 60 * 24 * 365.25;

export const defaultWeights: WeightConfig = {
	sizeWeight: 0.2,
	ageWeight: 0.4,
	watchWeight: 0.4,
};

export interface ScoreOptions {
	weights?: WeightConfig;
	now?: Date;
	targetPlaysPerYear?: number;
	saturationAgeYears?: number;
}

export function scoreMediaItems(
	items: MediaItem[],
	options: ScoreOptions = {},
): ScoredMediaItem[] {
	const weights = options.weights ?? defaultWeights;
	const now = options.now ?? new Date();
	const targetPlaysPerYear = options.targetPlaysPerYear ?? 0.5;
	const saturationAgeYears = options.saturationAgeYears ?? 5;

	const maxSize = Math.max(...items.map((item) => item.sizeBytes), 1);

	return items
		.map((item) => {
			const metrics = computeMetrics({
				item,
				now,
				maxSize,
				targetPlaysPerYear,
				saturationAgeYears,
			});
			const score =
				metrics.sizeScore * weights.sizeWeight +
				metrics.ageScore * weights.ageWeight +
				metrics.watchScarcityScore * weights.watchWeight;

			return {
				...item,
				metrics,
				score,
			};
		})
		.sort((a, b) => b.score - a.score);
}

interface ComputeMetricsParams {
	item: MediaItem;
	now: Date;
	maxSize: number;
	targetPlaysPerYear: number;
	saturationAgeYears: number;
}

function computeMetrics({
	item,
	now,
	maxSize,
	targetPlaysPerYear,
	saturationAgeYears,
}: ComputeMetricsParams): ScoringMetrics {
	const ageMs = now.getTime() - item.addedAt.getTime();
	const ageYears = Math.max(ageMs / YEAR_IN_MS, 0);
	const normalizedAge = clamp(ageYears / saturationAgeYears, 0, 1);

	const sizeScore = normalizeSize(item.sizeBytes, maxSize);

	const playsPerYear = computePlaysPerYear(item.playCount, ageYears);
	const watchScarcity = computeWatchScarcity({
		playsPerYear,
		normalizedAge,
		targetPlaysPerYear,
	});

	return {
		sizeScore,
		ageScore: normalizedAge,
		watchScarcityScore: watchScarcity,
		playsPerYear,
		ageYears,
	};
}

function normalizeSize(size: number, maxSize: number): number {
	const adjustedSize = Math.log10(size + 1);
	const adjustedMax = Math.log10(maxSize + 1);
	if (adjustedMax === 0) {
		return 0;
	}
	return clamp(adjustedSize / adjustedMax, 0, 1);
}

function computePlaysPerYear(playCount: number, ageYears: number): number {
	const effectiveAge = Math.max(ageYears, 0.25);
	return playCount / effectiveAge;
}

interface WatchScarcityParams {
	playsPerYear: number;
	normalizedAge: number;
	targetPlaysPerYear: number;
}

function computeWatchScarcity({
	playsPerYear,
	normalizedAge,
	targetPlaysPerYear,
}: WatchScarcityParams): number {
	const scarcity = clamp(1 - playsPerYear / targetPlaysPerYear, -1, 1);
	const positiveScarcity = Math.max(0, scarcity);
	return positiveScarcity * normalizedAge;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
