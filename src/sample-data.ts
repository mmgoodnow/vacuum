import { aggregateMediaUnits } from "./aggregation.ts";
import type { MediaSource, MediaUnit } from "./types.ts";

interface SampleOptions {
	now?: Date;
}

export function generateSampleMedia(options: SampleOptions = {}): MediaUnit[] {
	const now = options.now ?? new Date();

	const sources: MediaSource[] = [
		createMovie({
			id: "movie-1",
			title: "Forgotten Documentary",
			sizeGb: 45,
			yearsAgoAdded: 7,
			totalPlays: 0,
			now,
		}),
		createMovie({
			id: "movie-2",
			title: "Cult Classic",
			sizeGb: 68,
			yearsAgoAdded: 9,
			totalPlays: 1,
			now,
		}),
		createMovie({
			id: "movie-3",
			title: "Recent Blockbuster",
			sizeGb: 85,
			yearsAgoAdded: 0.2,
			totalPlays: 0,
			now,
		}),
		...createSeason({
			showKey: "show-1",
			showTitle: "Family Favorite",
			seasonKey: "show-1-season-1",
			seasonTitle: "Season 1",
			episodeCount: 10,
			sizeGbPerEpisode: 1.2,
			yearsAgoAdded: 6,
			playCounts: [14, 12, 9, 6, 0, 0, 0, 0, 0, 0],
			now,
		}),
		...createSeason({
			showKey: "show-2",
			showTitle: "Indie Anthology",
			seasonKey: "show-2-season-1",
			seasonTitle: "Season 1",
			episodeCount: 8,
			sizeGbPerEpisode: 1.0,
			yearsAgoAdded: 4,
			playCounts: [0, 0, 0, 0, 0, 0, 0, 0],
			now,
		}),
		...createSeason({
			showKey: "show-3",
			showTitle: "Classic Series",
			seasonKey: "show-3-season-1",
			seasonTitle: "Season 1",
			episodeCount: 22,
			sizeGbPerEpisode: 1.5,
			yearsAgoAdded: 11,
			playCounts: new Array(22).fill(0),
			now,
		}),
		...createSeason({
			showKey: "show-3",
			showTitle: "Classic Series",
			seasonKey: "show-3-season-2",
			seasonTitle: "Season 2",
			episodeCount: 22,
			sizeGbPerEpisode: 1.4,
			yearsAgoAdded: 8,
			playCounts: [
				1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
			],
			now,
		}),
	];

	return aggregateMediaUnits(sources);
}

interface CreateMovieParams {
	id: string;
	title: string;
	sizeGb: number;
	yearsAgoAdded: number;
	totalPlays: number;
	now: Date;
}

function createMovie({
	id,
	title,
	sizeGb,
	yearsAgoAdded,
	totalPlays,
	now,
}: CreateMovieParams): MediaSource {
	const addedAt = yearsAgoAddedToDate(now, yearsAgoAdded);
	return {
		id,
		title,
		relativePath: null,
		path: `/media/${title.replaceAll(" ", "_")}`,
		sizeBytes: Math.round(sizeGb * 1024 ** 3),
		addedAt,
		lastPlayedAt: totalPlays > 0 ? addedAt : null,
		playCount: totalPlays,
		librarySectionId: 1,
		librarySectionName: "Movies",
		episodeIndex: null,
		seasonTitle: null,
		showTitle: null,
		seasonKey: null,
		showKey: null,
		mediaKind: "movie",
	};
}

interface CreateSeasonParams {
	showKey: string;
	showTitle: string;
	seasonKey: string;
	seasonTitle: string;
	episodeCount: number;
	sizeGbPerEpisode: number;
	yearsAgoAdded: number;
	playCounts: number[];
	now: Date;
}

function createSeason({
	showKey,
	showTitle,
	seasonKey,
	seasonTitle,
	episodeCount,
	sizeGbPerEpisode,
	yearsAgoAdded,
	playCounts,
	now,
}: CreateSeasonParams): MediaSource[] {
	const addedAt = yearsAgoAddedToDate(now, yearsAgoAdded);
	const items: MediaSource[] = [];
	for (let i = 0; i < episodeCount; i += 1) {
		const playCount = playCounts[i] ?? 0;
		items.push({
			id: `${seasonKey}-episode-${i + 1}`,
			title: `${seasonTitle} Episode ${i + 1}`,
			relativePath: null,
			path: `/media/${showTitle.replaceAll(" ", "_")}/${seasonTitle.replaceAll(" ", "_")}/Episode_${i + 1}.mkv`,
			sizeBytes: Math.round(sizeGbPerEpisode * 1024 ** 3),
			addedAt,
			lastPlayedAt: playCount > 0 ? addedAt : null,
			playCount,
			librarySectionId: 2,
			librarySectionName: "TV",
			episodeIndex: i + 1,
			seasonTitle,
			showTitle,
			seasonKey,
			showKey,
			mediaKind: "episode",
		});
	}
	return items;
}

const YEAR_IN_MS = 1000 * 60 * 60 * 24 * 365.25;

function yearsAgoAddedToDate(now: Date, yearsAgo: number): Date {
	return new Date(now.getTime() - yearsAgo * YEAR_IN_MS);
}
