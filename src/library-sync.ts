import { stat } from "node:fs/promises";
import process from "node:process";
import path from "node:path";

import { aggregateMediaUnits } from "./aggregation.ts";
import { EpisodeCache } from "./episode-cache.ts";
import { EpisodeFetcher } from "./episode-fetcher.ts";
import { ProgressReporter } from "./progress-reporter.ts";
import { TautulliClient, type TautulliMediaItem } from "./tautulli-client.ts";
import type { AppConfig, MediaSource, MediaUnit } from "./types.ts";

export interface SyncOptions {
	libraryFilterIds?: number[];
	verbose?: boolean;
	showRatingKey?: string;
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
	sampleOutsidePaths: string[];
	sampleMissingFiles: string[];
	metadataLookups: number;
	metadataLookupFailures: number;
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

	const client = new TautulliClient(
		config.tautulli,
		options.verbose ? (message) => console.error(message) : undefined,
	);
	const episodeCache = new EpisodeCache(config.cachePath);
	const requestedShowKey = options.showRatingKey ?? null;
	let targetShowKey = requestedShowKey ?? null;
	let targetShowResolution: ResolvedShowTarget | null = null;
	if (targetShowKey) {
		targetShowResolution = await resolveShowTarget(client, targetShowKey);
		if (!targetShowResolution) {
			console.error(
				`[TV] Rating key ${targetShowKey} could not be resolved to a TV show or season.`,
			);
			return {
				units: [],
				sources: [],
				skippedDueToPath: 0,
				skippedMissingFile: 0,
			};
		}

		if (targetShowResolution.showRatingKey !== targetShowKey) {
			const title =
				targetShowResolution.showTitle ?? targetShowResolution.showRatingKey;
			console.error(
				`[TV] Rating key ${targetShowKey} maps to show "${title}" (${targetShowResolution.showRatingKey}).`,
			);
		} else {
			const title =
				targetShowResolution.showTitle ?? targetShowResolution.showRatingKey;
			console.error(
				`[TV] Filtering to show "${title}" (${targetShowResolution.showRatingKey}).`,
			);
		}
		if (targetShowResolution.libraryName) {
			console.error(
				`[TV] Restricting sync to library "${targetShowResolution.libraryName}" (${targetShowResolution.libraryId ?? "unknown id"}).`,
			);
		}

		targetShowKey = targetShowResolution.showRatingKey;
	}
	let processedTargetShow = false;

	const episodeFetcher = new EpisodeFetcher(
		client,
		episodeCache,
		options.verbose ? (message) => console.error(message) : undefined,
	);
	const metadataProgress = new ProgressReporter({
		label: "Getting metadata",
		stream: process.stderr,
	});
	const libraries = await client.getLibraries();
	const selectedLibraryIds =
		options.libraryFilterIds && options.libraryFilterIds.length > 0
			? new Set(options.libraryFilterIds)
			: null;
	const targetLibraryId = targetShowResolution?.libraryId ?? null;
	const normalizedTargetShowKey = targetShowKey ?? null;

	const sources: MediaSource[] = [];
	let skippedDueToPath = 0;
	let skippedMissingFile = 0;
	let skippedUnsupported = 0;
	const libraryStats: LibraryProcessingStats[] = [];

	if (options.verbose) {
		console.error(
			`Configured library roots: ${
				config.libraryPaths.length
					? config.libraryPaths.map((root) => `"${root}"`).join(", ")
					: "none (all paths allowed)"
			}`,
		);
	}

	if (options.verbose) {
		if (libraries.length === 0) {
			console.error(
				"Tautulli returned no libraries. Verify the API key and permissions.",
			);
			try {
				const info = await client.getServerInfo();
				console.error(
					`Tautulli server info: ${JSON.stringify(info, null, 2)}`,
				);
			} catch (error) {
				console.error(
					`Unable to fetch server info, check connectivity and API key. Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		} else {
			console.error(
				`Discovered ${libraries.length} libraries: ${libraries
					.map((library) => `"${library.section_name}" (#${library.section_id})`)
					.join(", ")}`,
			);
		}
	}

	for (const library of libraries) {
		if (targetShowKey && processedTargetShow) {
			break;
		}

		if (selectedLibraryIds && !selectedLibraryIds.has(library.section_id)) {
			if (options.verbose) {
				console.error(
					`Skipping library ${library.section_name} (${library.section_id}) because it is not in the filter list.`,
				);
			}
			continue;
		}

		if (targetLibraryId && library.section_id !== targetLibraryId) {
			continue;
		}

		if (targetShowKey && library.section_type !== "show") {
			continue;
		}

		if (options.verbose) {
			console.error(
				`Fetching media info for library ${library.section_name} (${library.section_id})`,
			);
		}

		const items = await client.getLibraryMediaItems(library.section_id, {
			sectionType: library.section_type,
		});
		const stats: LibraryProcessingStats = {
			libraryName: library.section_name,
			libraryId: library.section_id,
			fetched: items.length,
			imported: 0,
			skippedUnsupported: 0,
			skippedMissingFile: 0,
			skippedDueToPath: 0,
			sampleOutsidePaths: [],
			sampleMissingFiles: [],
			metadataLookups: 0,
			metadataLookupFailures: 0,
		};
		let metadataResolutionLogs = 0;
		const itemsToProcess =
			normalizedTargetShowKey && library.section_type === "show"
				? items.filter((item) =>
						doesItemMatchShow(item, normalizedTargetShowKey),
					)
				: items;
		metadataProgress.setExpectedTotal(itemsToProcess.length || undefined);
		if (!itemsToProcess.length) {
			if (targetShowKey) {
				console.error(
					`[TV] Rating key ${targetShowKey} not found in library "${library.section_name}".`,
				);
			}
			continue;
		}

		if (options.verbose && items.length > 0) {
			const [firstItem] = items;
			if (firstItem) {
				const rawPreview = JSON.stringify(firstItem, null, 2);
				const truncatedPreview =
					rawPreview.length > 800
						? `${rawPreview.slice(0, 800)} … (truncated)`
						: rawPreview;
				console.error(
					`  Sample raw item: keys=${Object.keys(firstItem).join(", ")}\n${truncatedPreview}`,
				);
			}
		}

		const verboseLogging = options.verbose ?? false;
		const processItem = async (item: TautulliMediaItem): Promise<void> => {
			metadataProgress.start(item.title);
			try {
				if (!isSupportedMediaType(item.media_type)) {
					stats.skippedUnsupported += 1;
					skippedUnsupported += 1;
					return;
				}

				let filePath = item.file ?? null;
				if (!filePath || filePath.length === 0) {
					stats.metadataLookups += 1;
					try {
						const resolvedPath = await client.getMediaItemFilePath(
							item.rating_key,
						);
						if (resolvedPath) {
							filePath = resolvedPath;
							if (verboseLogging && metadataResolutionLogs < 5) {
								console.error(
									`    Resolved file via metadata for "${item.title}": ${resolvedPath}`,
								);
							}
							metadataResolutionLogs += 1;
						} else {
							stats.metadataLookupFailures += 1;
						}
					} catch (error) {
						stats.metadataLookupFailures += 1;
						if (verboseLogging) {
							console.error(
								`    Failed to resolve file for "${item.title}" (${item.rating_key}): ${
									error instanceof Error ? error.message : String(error)
								}`,
							);
						}
					}
				}

				if (!filePath) {
					stats.skippedMissingFile += 1;
					if (stats.sampleMissingFiles.length < 3) {
						stats.sampleMissingFiles.push(
							`${item.title} (${item.rating_key ?? "unknown key"})`,
						);
					}
					skippedMissingFile += 1;
					return;
				}

				if (!isPathAllowed(filePath, config.libraryPaths)) {
					stats.skippedDueToPath += 1;
					if (stats.sampleOutsidePaths.length < 3) {
						stats.sampleOutsidePaths.push(filePath);
					}
					skippedDueToPath += 1;
					return;
				}

				const fileStats = await safeStat(filePath);
				if (!fileStats) {
					stats.skippedMissingFile += 1;
					if (stats.sampleMissingFiles.length < 3) {
						stats.sampleMissingFiles.push(filePath);
					}
					skippedMissingFile += 1;
					return;
				}

				const source = mapMediaItemToSource(
					item,
					library.section_name,
					filePath,
					fileStats,
				);
				sources.push(source);
				stats.imported += 1;
			} finally {
				metadataProgress.finish(item.title);
			}
		};

		const totalShows =
			library.section_type === "show"
				? items.filter((item) => item.media_type === "show").length
				: 0;
		let processedShows = 0;
		let showProgress: ProgressReporter | null = null;
		if (totalShows > 0) {
			console.error(
				`[TV] Processing ${totalShows} show(s) in "${library.section_name}"...`,
			);
			showProgress = new ProgressReporter({
				label: `Processing ${library.section_name}`,
			});
			showProgress.setExpectedTotal(totalShows);
			metadataProgress.setCarriageReturnEnabled(false);
		} else {
			metadataProgress.setCarriageReturnEnabled(true);
		}

		for (const item of itemsToProcess) {
			if (library.section_type === "show" && item.media_type === "show") {
				processedShows += 1;
				const episodes = await episodeFetcher.fetchEpisodesForShow(
					item,
					{
						libraryName: library.section_name,
						showIndex: processedShows,
						totalShows,
					},
					{
						...(showProgress ? { progress: showProgress } : {}),
						verbose: options.verbose ?? false,
					},
				);
				for (const episode of episodes) {
					await processItem(episode);
				}
				if (targetShowKey) {
					processedTargetShow = true;
				}
				continue;
			}

			await processItem(item);
		}

		metadataProgress.end();
		metadataProgress.setCarriageReturnEnabled(true);
		showProgress?.end();

		libraryStats.push(stats);
		if (options.verbose) {
			console.error(
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
					stats.metadataLookups
						? `metadata lookups: ${stats.metadataLookups}`
						: null,
					stats.metadataLookupFailures
						? `metadata lookup failures: ${stats.metadataLookupFailures}`
						: null,
				]
					.filter(Boolean)
					.join(", "),
			);
			if (stats.sampleOutsidePaths.length) {
				console.error(
					`  Sample outside-path file: ${stats.sampleOutsidePaths.join(", ")}`,
				);
			}
			if (stats.sampleMissingFiles.length) {
				console.error(
					`  Sample missing/unreadable entry: ${stats.sampleMissingFiles.join(", ")}`,
				);
			}
			if (!stats.imported && stats.fetched > 0) {
				console.error(
					"  No items imported from this library. Check path configuration and filesystem access.",
				);
			}
			if (stats.fetched === 0) {
				console.error(
					"  Library returned zero items from Tautulli. Confirm the library is enabled in Tautulli.",
				);
			}
		}
	}

	const units = aggregateMediaUnits(sources);

	if (options.verbose) {
		console.error(
			`Imported ${sources.length} source files into ${units.length} media units.`,
		);
		const totalMetadataLookups = libraryStats.reduce(
			(sum, stats) => sum + stats.metadataLookups,
			0,
		);
		const totalMetadataFailures = libraryStats.reduce(
			(sum, stats) => sum + stats.metadataLookupFailures,
			0,
		);
		if (totalMetadataLookups) {
			console.error(
				`Performed ${totalMetadataLookups} metadata lookups (${totalMetadataFailures} failed).`,
			);
		}
		if (skippedUnsupported) {
			console.error(
				`Skipped ${skippedUnsupported} items with unsupported types.`,
			);
		}
		if (skippedMissingFile) {
			console.error(
				`Skipped ${skippedMissingFile} items missing files or unreadable on disk.`,
			);
		}
		if (skippedDueToPath) {
			console.error(
				`Skipped ${skippedDueToPath} items outside configured library paths.`,
			);
		}
		if (!sources.length) {
			console.error(
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
	playCount: Number(item.play_count ?? 0) || 0,
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

interface ResolvedShowTarget {
	showRatingKey: string;
	showTitle: string | null;
	libraryId: number | null;
	libraryName: string | null;
}

async function resolveShowTarget(
	client: TautulliClient,
	ratingKey: string,
): Promise<ResolvedShowTarget | null> {
	const metadata = await client.getMetadataSummary(ratingKey);
	if (!metadata) {
		return null;
	}
	const mediaType = (metadata.media_type ?? "").toLowerCase();
	if (!mediaType) {
		return null;
	}

	let showRatingKey: string | null = null;
	let showTitle: string | null = null;

	if (mediaType === "show") {
		showRatingKey = metadata.rating_key;
		showTitle = metadata.title ?? null;
	} else if (mediaType === "season") {
		showRatingKey = metadata.parent_rating_key ?? null;
		showTitle = metadata.parent_title ?? metadata.title ?? null;
	} else if (mediaType === "episode") {
		showRatingKey =
			metadata.grandparent_rating_key ?? metadata.parent_rating_key ?? null;
		showTitle =
			metadata.grandparent_title ??
			metadata.parent_title ??
			metadata.title ??
			null;
	} else {
		return null;
	}

	if (!showRatingKey) {
		return null;
	}

	const libraryIdValue = metadata.section_id;
	const normalizedLibraryId =
		typeof libraryIdValue === "number"
			? libraryIdValue
			: libraryIdValue !== null && libraryIdValue !== undefined
				? Number(libraryIdValue)
				: null;

	return {
		showRatingKey,
		showTitle,
		libraryId:
			normalizedLibraryId !== null && Number.isFinite(normalizedLibraryId)
				? normalizedLibraryId
				: null,
		libraryName: metadata.library_name ?? null,
	};
}

function doesItemMatchShow(
	item: TautulliMediaItem,
	targetKey: string,
): boolean {
	const itemKey = normalizeKey(item.rating_key);
	if (item.media_type === "show") {
		return itemKey === targetKey;
	}
	const parentKey = normalizeKey(item.parent_rating_key);
	const grandparentKey = normalizeKey(item.grandparent_rating_key);
	if (item.media_type === "season") {
		return parentKey === targetKey || itemKey === targetKey;
	}
	return parentKey === targetKey || grandparentKey === targetKey;
}

function normalizeKey(value: string | null | undefined): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	const str = String(value);
	return str.length ? str : null;
}
