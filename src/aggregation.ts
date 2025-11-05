import type { MediaKind, MediaSource, MediaUnit } from "./types.ts";

interface AggregatedUnitBuilder {
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
	paths: Set<string>;
	sourceItems: MediaSource[];
}

export function aggregateMediaUnits(sources: MediaSource[]): MediaUnit[] {
	const map = new Map<string, AggregatedUnitBuilder>();

	for (const source of sources) {
		const { key, kind, title, parentTitle } = determineUnitIdentity(source);

		let builder = map.get(key);
		if (builder === undefined) {
			builder = {
				id: key,
				kind,
				title,
				parentTitle: parentTitle ?? null,
				librarySectionId: source.librarySectionId,
				librarySectionName: source.librarySectionName,
				sizeBytes: 0,
				addedAt: source.addedAt,
				lastPlayedAt: source.lastPlayedAt ?? null,
				totalPlayCount: 0,
				maxItemPlayCount: 0,
				itemsWithPlays: 0,
				itemCount: 0,
				paths: new Set(),
				sourceItems: [],
			};
			map.set(key, builder);
		}

		builder.sizeBytes += source.sizeBytes;
		builder.addedAt =
			source.addedAt < builder.addedAt ? source.addedAt : builder.addedAt;
		if (source.lastPlayedAt) {
			if (!builder.lastPlayedAt || source.lastPlayedAt > builder.lastPlayedAt) {
				builder.lastPlayedAt = source.lastPlayedAt;
			}
		}
		builder.totalPlayCount += source.playCount;
		builder.maxItemPlayCount = Math.max(
			builder.maxItemPlayCount,
			source.playCount,
		);
		if (source.playCount > 0) {
			builder.itemsWithPlays += 1;
		}
		builder.itemCount += 1;
		builder.paths.add(source.path);
		builder.sourceItems.push(source);

		// Update kind-specific metadata if missing
		if (kind === "season") {
			builder.parentTitle = parentTitle ?? builder.parentTitle ?? null;
		}
	}

	return Array.from(map.values()).map((builder) => ({
		id: builder.id,
		kind: builder.kind,
		title: builder.title,
		parentTitle: builder.parentTitle ?? null,
		librarySectionId: builder.librarySectionId,
		librarySectionName: builder.librarySectionName,
		sizeBytes: builder.sizeBytes,
		addedAt: builder.addedAt,
		lastPlayedAt: builder.lastPlayedAt ?? null,
		totalPlayCount: builder.totalPlayCount,
		maxItemPlayCount: builder.maxItemPlayCount,
		itemsWithPlays: builder.itemsWithPlays,
		itemCount: builder.itemCount,
		paths: Array.from(builder.paths),
		sourceItems: builder.sourceItems,
	}));
}

function determineUnitIdentity(source: MediaSource): {
	key: string;
	kind: MediaKind;
	title: string;
	parentTitle?: string | null;
} {
	if (source.mediaKind === "movie") {
		return {
			key: source.id,
			kind: "movie",
			title: source.title,
		};
	}

	const key = source.seasonKey ?? source.showKey ?? source.id;
	const title = source.seasonTitle ?? source.title;
	return {
		key,
		kind: "season",
		title,
		parentTitle: source.showTitle ?? null,
	};
}
