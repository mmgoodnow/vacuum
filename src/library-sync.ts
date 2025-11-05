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

interface LibraryProcessingStats {
	libraryName: string;
	libraryId: number;
	fetched: number;
	imported: number;
	skippedUnsupported: number;
	skippedMissingFile: number;
	skippedDueToPath: number;
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
	let skippedUnsupported = 0;
	const libraryStats: LibraryProcessingStats[] = [];

	if (options.verbose) {
		console.log(
			`Configured library roots: ${
				config.libraryPaths.length
					? config.libraryPaths.map((root) => `"${root}"`).join(", ")
					: "none (all paths allowed)"
			}`,
		);
	}

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
		const stats: LibraryProcessingStats = {
			libraryName: library.section_name,
			libraryId: library.section_id,
			fetched: items.length,
			imported: 0,
			skippedUnsupported: 0,
			skippedMissingFile: 0,
			skippedDueToPath: 0,
		};

		for (const item of items) {
			if (!isSupportedMediaType(item.media_type)) {
				stats.skippedUnsupported += 1;
				skippedUnsupported += 1;
				continue;
			}

			const filePath = item.file;
			if (!filePath) {
				stats.skippedMissingFile += 1;
				skippedMissingFile += 1;
				continue;
			}

			if (!isPathAllowed(filePath, config.libraryPaths)) {
				stats.skippedDueToPath += 1;
				skippedDueToPath += 1;
				continue;
			}

			const fileStats = await safeStat(filePath);
			if (!fileStats) {
				stats.skippedMissingFile += 1;
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
			stats.imported += 1;
		}

		libraryStats.push(stats);
		if (options.verbose) {
			console.log(
				[
					`Processed library "${stats.libraryName}" (${stats.libraryId})`,
					`fetched ${stats.fetched}`,
					`imported ${stats.imported}`,
					stats.skippedUnsupported
						? `skipped unsupported: ${stats.skippedUnsupported}`
						: null,
					stats.skippedMissingFile
						? `missing file/metadata: ${stats.skippedMissingFile}`
						: null,
					stats.skippedDueToPath
						? `outside configured paths: ${stats.skippedDueToPath}`
						: null,
				]
					.filter(Boolean)
					.join(", "),
			);
		}
	}

	const units = aggregateMediaUnits(sources);

	if (options.verbose) {
		console.log(
			`Imported ${sources.length} source files into ${units.length} media units.`,
		);
		if (skippedUnsupported) {
			console.log(`Skipped ${skippedUnsupported} items with unsupported types.`);
		}
		if (skippedMissingFile) {
			console.log(
				`Skipped ${skippedMissingFile} items missing files or unreadable on disk.`,
			);
		}
		if (skippedDueToPath) {
			console.log(
				`Skipped ${skippedDueToPath} items outside configured library paths.`,
			);
		}
		if (!sources.length) {
			console.log(
				"No source files were accepted. Check that your configured library paths match the media file locations and that the container has those paths mounted.",
			);
		}
	}

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
