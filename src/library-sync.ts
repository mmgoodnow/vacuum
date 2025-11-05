import { stat } from "node:fs/promises";
import path from "node:path";

import { aggregateMediaUnits } from "./aggregation.ts";
import { TautulliClient, type TautulliMediaItem } from "./tautulli-client.ts";
import type { AppConfig, MediaSource, MediaUnit } from "./types.ts";

export interface SyncOptions {
	libraryFilterIds?: number[];
	verbose?: boolean;
}

export interface SyncResult {
	units: MediaUnit[];
	sources: MediaSource[];
	skippedDueToPath: number;
	skippedMissingFile: number;
}

export async function syncMediaUnits(
	config: AppConfig,
	options: SyncOptions = {},
): Promise<SyncResult> {
	if (!config.tautulli) {
		throw new Error(
			"Tautulli is not configured. Run the configuration step first.",
		);
	}

	const client = new TautulliClient(config.tautulli);
	const libraries = await client.getLibraries();
	const selectedLibraryIds =
		options.libraryFilterIds && options.libraryFilterIds.length > 0
			? new Set(options.libraryFilterIds)
			: null;

	const sources: MediaSource[] = [];
	let skippedDueToPath = 0;
	let skippedMissingFile = 0;

	for (const library of libraries) {
		if (selectedLibraryIds && !selectedLibraryIds.has(library.section_id)) {
			continue;
		}

		if (options.verbose) {
			console.log(
				`Fetching media info for library ${library.section_name} (${library.section_id})`,
			);
		}

		const items = await client.getLibraryMediaItems(library.section_id);
		for (const item of items) {
			if (!isSupportedMediaType(item.media_type)) {
				continue;
			}

			const filePath = item.file;
			if (!filePath) {
				skippedMissingFile += 1;
				continue;
			}

			if (!isPathAllowed(filePath, config.libraryPaths)) {
				skippedDueToPath += 1;
				continue;
			}

			const fileStats = await safeStat(filePath);
			if (!fileStats) {
				skippedMissingFile += 1;
				continue;
			}

			const source = mapMediaItemToSource(
				item,
				library.section_name,
				filePath,
				fileStats,
			);
			sources.push(source);
		}
	}

	const units = aggregateMediaUnits(sources);
	return {
		units,
		sources,
		skippedDueToPath,
		skippedMissingFile,
	};
}

function isSupportedMediaType(
	mediaType: string,
): mediaType is "movie" | "episode" {
	return mediaType === "movie" || mediaType === "episode";
}

function isPathAllowed(filePath: string, allowedRoots: string[]): boolean {
	if (allowedRoots.length === 0) {
		return true;
	}
	const normalized = path.resolve(filePath);
	return allowedRoots.some((root) => {
		const resolvedRoot = path.resolve(root);
		return (
			normalized === resolvedRoot ||
			normalized.startsWith(resolvedRoot + path.sep)
		);
	});
}

interface FileStatInfo {
	size: number;
	birthtimeMs: number;
}

async function safeStat(filePath: string): Promise<FileStatInfo | null> {
	try {
		const stats = await stat(filePath);
		if (!stats.isFile()) {
			return null;
		}
		return { size: stats.size, birthtimeMs: stats.birthtimeMs };
	} catch {
		return null;
	}
}

function mapMediaItemToSource(
	item: TautulliMediaItem,
	librarySectionName: string,
	filePath: string,
	fileStats: FileStatInfo,
): MediaSource {
	const addedAt =
		fromUnixSeconds(item.added_at ?? null) ?? new Date(fileStats.birthtimeMs);
	const lastPlayedAt = fromUnixSeconds(item.last_played ?? null);

	return {
		id: item.rating_key,
		title: item.title,
		relativePath: null,
		path: filePath,
		sizeBytes: fileStats.size,
		addedAt,
		lastPlayedAt,
		playCount: item.play_count ?? 0,
		librarySectionId: item.section_id,
		librarySectionName,
		episodeIndex: item.media_index ?? null,
		seasonTitle: item.parent_title ?? null,
		showTitle: item.grandparent_title ?? null,
		seasonKey: item.parent_rating_key ?? null,
		showKey: item.grandparent_rating_key ?? null,
		mediaKind: item.media_type === "movie" ? "movie" : "episode",
	};
}

function fromUnixSeconds(value: number | null): Date | null {
	if (!value || Number.isNaN(value)) {
		return null;
	}
	return new Date(value * 1000);
}
