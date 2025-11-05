import type {
	MediaUnit,
	ScoredMediaUnit,
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
	targetPlaysPerGb?: number;
}

export function scoreMediaItems(
	items: MediaUnit[],
	options: ScoreOptions = {},
): ScoredMediaUnit[] {
	const weights = options.weights ?? defaultWeights;
	const now = options.now ?? new Date();
	const targetPlaysPerYear = options.targetPlaysPerYear ?? 0.5;
	const saturationAgeYears = options.saturationAgeYears ?? 5;
	const targetPlaysPerGb = options.targetPlaysPerGb ?? 0.02;

	const maxSize = Math.max(...items.map((item) => item.sizeBytes), 1);

	return items
		.map((item) => {
			const metrics = computeMetrics({
				item,
				now,
				maxSize,
				targetPlaysPerYear,
				saturationAgeYears,
				targetPlaysPerGb,
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
	item: MediaUnit;
	now: Date;
	maxSize: number;
	targetPlaysPerYear: number;
	saturationAgeYears: number;
	targetPlaysPerGb: number;
}

function computeMetrics({
	item,
	now,
	maxSize,
	targetPlaysPerYear,
	saturationAgeYears,
	targetPlaysPerGb,
}: ComputeMetricsParams): ScoringMetrics {
	const ageMs = now.getTime() - item.addedAt.getTime();
	const ageYears = Math.max(ageMs / YEAR_IN_MS, 0);
	const normalizedAge = clamp(ageYears / saturationAgeYears, 0, 1);

	const sizeScore = normalizeSize(item.sizeBytes, maxSize);

	const playsPerYear = computePlaysPerYear(item.totalPlayCount, ageYears);
	const playsPerGb = computePlaysPerGb(item.totalPlayCount, item.sizeBytes);
	const coverageRatio =
		item.itemCount === 0 ? 0 : item.itemsWithPlays / item.itemCount;
	const watchScarcity = computeWatchScarcity({
		playsPerYear,
		normalizedAge,
		targetPlaysPerYear,
		playsPerGb,
		targetPlaysPerGb,
		coverageRatio,
	});

	return {
		sizeScore,
		ageScore: normalizedAge,
		watchScarcityScore: watchScarcity,
		playsPerYear,
		playsPerGb,
		coverageRatio,
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

function computePlaysPerGb(playCount: number, sizeBytes: number): number {
	const sizeGb = sizeBytes > 0 ? sizeBytes / 1024 ** 3 : 0;
	if (sizeGb <= 0) {
		return 0;
	}
	return playCount / sizeGb;
}

interface WatchScarcityParams {
	playsPerYear: number;
	normalizedAge: number;
	targetPlaysPerYear: number;
	playsPerGb: number;
	targetPlaysPerGb: number;
	coverageRatio: number;
}

function computeWatchScarcity({
	playsPerYear,
	normalizedAge,
	targetPlaysPerYear,
	playsPerGb,
	targetPlaysPerGb,
	coverageRatio,
}: WatchScarcityParams): number {
	const playsPerYearScarcity = clamp(
		1 - playsPerYear / targetPlaysPerYear,
		0,
		1,
	);
	const playsPerGbScarcity = clamp(1 - playsPerGb / targetPlaysPerGb, 0, 1);
	const coverageScarcity = clamp(1 - coverageRatio, 0, 1);

	const compositeScarcity =
		playsPerYearScarcity * 0.5 +
		playsPerGbScarcity * 0.3 +
		coverageScarcity * 0.2;

	const ageMultiplier = 0.5 + normalizedAge * 0.5;
	return clamp(compositeScarcity * ageMultiplier, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
