import type { MediaItem } from "./types.ts";

interface SampleOptions {
	now?: Date;
}

export function generateSampleMedia(options: SampleOptions = {}): MediaItem[] {
	const now = options.now ?? new Date();

	return [
		createSample({
			id: "m1",
			title: "Forgotten Documentary",
			sizeGb: 45,
			yearsAgoAdded: 7,
			plays: 0,
			now,
		}),
		createSample({
			id: "m2",
			title: "Cult Classic",
			sizeGb: 68,
			yearsAgoAdded: 9,
			plays: 1,
			now,
		}),
		createSample({
			id: "m3",
			title: "Recent Blockbuster",
			sizeGb: 85,
			yearsAgoAdded: 0.2,
			plays: 0,
			now,
		}),
		createSample({
			id: "m4",
			title: "Family Favorite",
			sizeGb: 12,
			yearsAgoAdded: 6,
			plays: 14,
			now,
		}),
		createSample({
			id: "m5",
			title: "Indie Film",
			sizeGb: 8,
			yearsAgoAdded: 4,
			plays: 0,
			now,
		}),
		createSample({
			id: "m6",
			title: "Classic Series Pilot",
			sizeGb: 1.2,
			yearsAgoAdded: 11,
			plays: 0,
			now,
		}),
		createSample({
			id: "m7",
			title: "Animated Adventure",
			sizeGb: 38,
			yearsAgoAdded: 5.5,
			plays: 2,
			now,
		}),
		createSample({
			id: "m8",
			title: "Concert Recording",
			sizeGb: 52,
			yearsAgoAdded: 3,
			plays: 1,
			now,
		}),
	];
}

interface CreateSampleParams {
	id: string;
	title: string;
	sizeGb: number;
	yearsAgoAdded: number;
	plays: number;
	now: Date;
}

function createSample({
	id,
	title,
	sizeGb,
	yearsAgoAdded,
	plays,
	now,
}: CreateSampleParams): MediaItem {
	const addedAt = new Date(now.getTime() - yearsAgoAdded * YEAR_IN_MS);
	return {
		id,
		title,
		path: `/media/${title.replaceAll(" ", "_")}`,
		sizeBytes: Math.round(sizeGb * 1024 ** 3),
		addedAt,
		lastPlayedAt: plays > 0 ? addedAt : null,
		playCount: plays,
	};
}

const YEAR_IN_MS = 1000 * 60 * 60 * 24 * 365.25;
