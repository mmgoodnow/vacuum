import { rm } from "node:fs/promises";
import path from "node:path";
import inquirer from "inquirer";

import { loadOrCreateConfig, saveConfig } from "./config.ts";
import { EpisodeCache } from "./episode-cache.ts";
import { syncMediaUnits } from "./library-sync.ts";
import { defaultWeights, scoreMediaItems } from "./scoring.ts";
import {
	RadarrClient,
	SonarrClient,
	type ExternalIds,
} from "./arr-clients.ts";
import {
	TautulliClient,
	type TautulliMetadataSummary,
} from "./tautulli-client.ts";
import type {
	AppConfig,
	ArrConfig,
	MediaUnit,
	ScoredMediaUnit,
	WeightConfig,
} from "./types.ts";

interface RunOptions {
	verbose: boolean;
	output: "table" | "tsv";
	perLibrary: boolean;
	showRatingKey?: string;
}

const DEFAULT_RUN_OPTIONS: RunOptions = {
	verbose: false,
	output: "table",
	perLibrary: false,
};

const MAX_PURGE_CHOICES = 75;

async function promptOrExit<T = Record<string, unknown>>(
	questions: unknown,
): Promise<T> {
	try {
		const result = await inquirer.prompt(questions as any);
		return result as T;
	} catch (error) {
		if (isExitPromptError(error)) {
			process.exit(0);
		}
		throw error;
	}
}

function isExitPromptError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const candidate = error as { name?: string };
	return candidate.name === "ExitPromptError";
}

async function main(): Promise<void> {
	const cliArgs = process.argv.slice(2);
	const { action: requestedAction, flags, params } = parseCliArgs(cliArgs);
	const showParam = params["show-rating-key"] ?? params.show;
	const runOptions: RunOptions = {
		...DEFAULT_RUN_OPTIONS,
		verbose: hasFlag(flags, "--verbose", "-v"),
		output: hasFlag(flags, "--tsv") ? "tsv" : "table",
		perLibrary: hasFlag(flags, "--per-library"),
		...(showParam ? { showRatingKey: showParam } : {}),
	};

	logInfo("🧹 Vacuum — Plex library space recovery helper", runOptions);

	if (requestedAction === "help" || hasFlag(flags, "--help", "-h")) {
		printCliUsage();
		return;
	}

	let config = await loadOrCreateConfig();

	if (requestedAction && requestedAction !== "interactive") {
		await runAction(requestedAction, config, runOptions);
		return;
	}

	let exit = false;

		while (!exit) {
			const { action } = await promptOrExit<{ action: MenuAction }>([
				{
					type: "list",
					name: "action",
					message: "What would you like to do?",
				choices: [
					{ name: "Sync libraries via Tautulli and rank", value: "sync" },
					{
						name: "Select media to delete (interactive)",
						value: "purge",
					},
					{
						name: "Edit ignored titles",
						value: "blocklist",
					},
					{ name: "Adjust scoring weights", value: "weights" },
					{ name: "Edit configuration", value: "config" },
					{
						name: "Drop stale Tautulli entries (refresh media cache)",
						value: "prune",
					},
					{ name: "Quit", value: "quit" },
				],
			},
		]);

		if (action === "quit") {
			exit = true;
			continue;
		}

		config = await runAction(action, config, runOptions);
	}

	console.log("Goodbye!");
}

type MenuAction =
	| "sync"
	| "purge"
	| "blocklist"
	| "weights"
	| "config"
	| "prune"
	| "quit"
	| "interactive"
	| "help";

function parseCliArgs(
	args: string[],
): { action: MenuAction; flags: Set<string>; params: Record<string, string> } {
	let command: string | undefined;
	const flags = new Set<string>();
	const params: Record<string, string> = {};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!command && arg && !arg.startsWith("-")) {
			command = arg;
			continue;
		}

		if (!arg) {
			continue;
		}

		if (arg.startsWith("--")) {
			const withoutPrefix = arg.slice(2);
			const eqIndex = withoutPrefix.indexOf("=");
			if (eqIndex !== -1) {
				const name = withoutPrefix.slice(0, eqIndex);
				const inlineValue = withoutPrefix.slice(eqIndex + 1);
				params[name] = inlineValue;
				continue;
			}
			const name = withoutPrefix;
			const next = args[i + 1];
			if (next && !next.startsWith("-")) {
				params[name] = next;
				i += 1;
			} else {
				flags.add(`--${name}`);
			}
		} else {
			flags.add(arg);
		}
	}

	const action = getCliAction(command);
	return { action, flags, params };
}

function hasFlag(flags: Set<string>, ...aliases: string[]): boolean {
	return aliases.some((alias) => flags.has(alias));
}

function getCliAction(command?: string): MenuAction {
	switch (command) {
		case "sync":
			return "sync";
		case "blocklist":
			return "blocklist";
		case "weights":
			return "weights";
		case "config":
			return "config";
		case "prune":
			return "prune";
		case "help":
			return "help";
		case undefined:
		default:
			return "interactive";
	}
}

async function runAction(
	action: MenuAction,
	config: AppConfig,
	options: RunOptions,
): Promise<AppConfig> {
	switch (action) {
		case "sync":
			await syncAndRank(config, options);
			return config;
		case "weights":
			return adjustWeights(config);
		case "config":
			return reconfigure(config);
		case "blocklist":
			return editBlockedTitles(config);
		case "purge":
			await purgeMediaUnits(config, options);
			return config;
		case "prune":
			await dropStaleEntries(config, options);
			return config;
		case "quit":
		default:
			return config;
	}
}

function logInfo(message: string, options: RunOptions): void {
	if (options.output === "tsv") {
		console.error(message);
	} else {
		console.log(message);
	}
}

function printCliUsage(): void {
	console.log(`Usage: node src/index.ts [command] [options]

Commands:
  sync        Run "Sync libraries via Tautulli" once and exit.
  purge       Interactive flow to select ranked items and delete their files.
  weights     Enter the weight adjustment workflow.
  config      Enter configuration editing.
  prune       Drop stale Tautulli entries by refreshing media cache.
  help        Show this help text.

Options:
  -v, --verbose   Enable detailed logging for supported commands.
      --tsv       Output full rankings as tab-separated values.
      --per-library  Group output by library (tables show top 25 each; TSV adds library_rank).
      --show <rating_key>  Limit sync to a single show (rating key from Plex/Tautulli).

With no command, the interactive menu launches as before.`);
}

function printScoredTable(items: ScoredMediaUnit[]): void {
	if (!items.length) {
		console.log("No items to display yet.");
		return;
	}

	const formatTitle = (item: ScoredMediaUnit): string => {
		if (item.kind === "season" && item.parentTitle) {
			return `${item.parentTitle} — ${item.title}`;
		}
		return item.title;
	};

	const rows = items.map((item, index) => ({
		"#": index + 1,
		Kind: item.kind === "movie" ? "🎬" : "📺",
		Title: formatTitle(item),
		Section: item.librarySectionName,
		"Size (GB)": formatNumber(item.sizeBytes / 1024 ** 3, 2),
		"Age (years)": formatNumber(item.metrics.ageYears, 1),
		Plays: item.totalPlayCount,
		"Plays / year": formatNumber(item.metrics.playsPerYear, 2),
		"Plays / GB": formatNumber(item.metrics.playsPerGb, 3),
		"Coverage %": formatNumber(item.metrics.coverageRatio * 100, 1),
		Score: formatNumber(item.score, 3),
	}));

	console.table(rows);
}

function printScoredTsv(items: ScoredMediaUnit[], options: RunOptions): void {
	const headers = [
		"rank",
		...(options.perLibrary ? ["library_rank"] : []),
		"kind",
		"title",
		"section",
		"size_gb",
		"age_years",
		"plays",
		"plays_per_year",
		"plays_per_gb",
		"coverage_pct",
		"score",
	];
	console.log(headers.join("\t"));

	const libraryRanks = new Map<string, number>();

	const formatTitle = (item: ScoredMediaUnit): string => {
		if (item.kind === "season" && item.parentTitle) {
			return `${item.parentTitle} — ${item.title}`;
		}
		return item.title;
	};

	items.forEach((item, index) => {
		const libraryKey = `${item.librarySectionId}`;
		const currentRank = (libraryRanks.get(libraryKey) ?? 0) + 1;
		libraryRanks.set(libraryKey, currentRank);

		const row = [
			String(index + 1),
			...(options.perLibrary ? [String(currentRank)] : []),
			item.kind,
			formatTitle(item),
			item.librarySectionName,
			formatNumber(item.sizeBytes / 1024 ** 3, 2),
			formatNumber(item.metrics.ageYears, 1),
			String(item.totalPlayCount),
			formatNumber(item.metrics.playsPerYear, 2),
			formatNumber(item.metrics.playsPerGb, 3),
			formatNumber(item.metrics.coverageRatio * 100, 1),
			formatNumber(item.score, 3),
		];
		console.log(row.join("\t"));
	});
}

async function syncAndRank(
	config: AppConfig,
	options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<void> {
	if (!config.tautulli) {
		logInfo(
			"\nTautulli is not configured yet. Choose 'Edit configuration' first.",
			options,
		);
		return;
	}

	logInfo("\nSyncing libraries via Tautulli...", options);
	try {
		const result = await syncMediaUnits(config, {
			verbose: options.verbose,
			...(options.showRatingKey ? { showRatingKey: options.showRatingKey } : {}),
		});
		if (result.units.length === 0) {
			console.log("No media items were discovered.");
			return;
		}
		const blockedSet = new Set(
			config.blockedTitles
				.map((title) => normalizeTitle(title))
				.filter((value): value is string => Boolean(value)),
		);
		let units = result.units;
		if (blockedSet.size > 0) {
			const filtered = units.filter((unit) => !isUnitBlocked(unit, blockedSet));
			const blockedCount = units.length - filtered.length;
			if (blockedCount > 0) {
				logInfo(
					`Filtered ${blockedCount} item(s) via blocklist (${config.blockedTitles.join(", ")})`,
					options,
				);
			}
			units = filtered;
		}
		if (units.length === 0) {
			logInfo(
				"All discovered items were blocked by your title filter.",
				options,
			);
			return;
		}

		const scored = scoreMediaItems(units, {
			weights: config.weights,
		});

		if (options.output === "tsv") {
			printScoredTsv(scored, options);
		} else if (options.perLibrary) {
			printPerLibraryTables(scored, options);
		} else {
			printScoredTable(scored.slice(0, 25));
		}
		logInfo(
			`\nRanked ${result.units.length} units. Skipped ${result.skippedDueToPath} outside configured paths, ${result.skippedMissingFile} missing files.`,
			options,
		);
	} catch (error) {
		console.error("Failed to sync libraries:", error);
	}
}

async function adjustWeights(current: AppConfig): Promise<AppConfig> {
	console.log("\nCurrent weights:", current.weights);
	const updatedWeights = await promptForWeights(current.weights);
	const normalized = normalizeWeights(updatedWeights);

	const updatedConfig: AppConfig = {
		...current,
		weights: normalized,
	};

	await saveConfig(updatedConfig);
	console.log("Updated weights saved.");
	return updatedConfig;
}

async function dropStaleEntries(
	config: AppConfig,
	options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<void> {
	if (!config.tautulli) {
		logInfo(
			"\nTautulli is not configured yet. Choose 'Edit configuration' first.",
			options,
		);
		return;
	}

	logInfo(
		"\nDropping stale entries by clearing Tautulli media cache and refreshing libraries...",
		options,
	);
	const verbose = options.verbose;
	const episodeCache = new EpisodeCache(config.cachePath);
	episodeCache.clear();
	const client = new TautulliClient(
		config.tautulli,
		verbose ? (message) => console.error(message) : undefined,
	);
	const libraries = await client.getLibraries();
	if (!libraries.length) {
		logInfo("No libraries were returned by Tautulli.", options);
		return;
	}

	let refreshed = 0;
	for (const library of libraries) {
		try {
			if (verbose) {
				console.error(
					`- Clearing cache for ${library.section_name} (${library.section_id})`,
				);
			}
			const message = await client.deleteMediaInfoCache(library.section_id);
			if (message && verbose) {
				console.error(`  ${message}`);
			}
			await client.getLibraryMediaItems(library.section_id, {
				refresh: true,
				sectionType: library.section_type,
			});
			if (verbose) {
				console.error("  Refreshed from Plex.");
			}
			refreshed += 1;
		} catch (error) {
			console.error(
				`  Failed to refresh ${library.section_name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	logInfo(
		`\nCompleted refresh for ${refreshed} ${
			refreshed === 1 ? "library" : "libraries"
		}. Run 'node src/index.ts sync --verbose' to verify the stale entries are gone.`,
		options,
	);
}

async function purgeMediaUnits(
	config: AppConfig,
	options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<void> {
	if (!config.tautulli) {
		logInfo(
			"\nTautulli is not configured yet. Choose 'Edit configuration' first.",
			options,
		);
		return;
	}

	const verboseLogger =
		options.verbose ? (message: string) => console.error(message) : undefined;
	const tautulliClient = new TautulliClient(
		config.tautulli,
		verboseLogger,
	);
	const sonarrClient = config.sonarr
		? new SonarrClient(config.sonarr, verboseLogger)
		: null;
	const radarrClient = config.radarr
		? new RadarrClient(config.radarr, verboseLogger)
		: null;

	console.log("\nSyncing libraries via Tautulli (read-only)...");
	const syncResult = await syncMediaUnits(config, {
		verbose: options.verbose,
	});
	if (!syncResult.units.length) {
		console.log("No media items were discovered; nothing to delete.");
		return;
	}

	const scored = scoreMediaItems(syncResult.units, {
		weights: config.weights,
	});
	const selectableUnits = scored.slice(0, MAX_PURGE_CHOICES);
	const choices = selectableUnits.map((unit, index) => ({
		name: formatDeletionChoiceLabel(unit, index + 1),
		value: unit.id,
		disabled: unit.isProtectedSeason
			? "Protected season (skipped automatically)"
			: undefined,
	}));

	if (!choices.length) {
		console.log("No ranked items available for deletion.");
		return;
	}

	const selectionAnswer = await promptOrExit<{ selectedUnitIds: string[] }>(
		[
			{
				type: "checkbox",
				name: "selectedUnitIds",
				message:
					"Select the media units you want to delete (space to toggle, enter to continue)",
				choices,
				pageSize: Math.min(choices.length, 15),
				loop: false,
			},
		],
	);
	const { selectedUnitIds } = selectionAnswer;

	if (!selectedUnitIds.length) {
		console.log("No items were selected.");
		return;
	}

	const selectedUnits = selectableUnits.filter((unit) =>
		selectedUnitIds.includes(unit.id),
	);
	const candidates = collectDeletionCandidates(
		selectedUnits,
		config.libraryPaths,
	);
	if (!candidates.length) {
		console.log(
			"Selected items fall outside your configured library paths; nothing to delete.",
		);
		return;
	}

	const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
	const totalSizeBytes = candidates.reduce(
		(sum, candidate) => sum + candidate.sizeBytes,
		0,
	);

	const sonarrTargets =
		sonarrClient && selectedUnits.some((unit) => unit.kind === "season")
			? await buildSonarrTargets(selectedUnits, tautulliClient)
			: [];
	const radarrTargets =
		radarrClient && selectedUnits.some((unit) => unit.kind === "movie")
			? await buildRadarrTargets(selectedUnits, tautulliClient)
			: [];

	console.log("\nDeletion summary:");
	for (const unit of selectedUnits) {
		const matchingFiles = unit.sourceItems.filter((source) =>
			candidatePaths.has(source.path),
		).length;
		console.log(
			`  • ${formatUnitTitle(unit)} — ${matchingFiles} file(s), ${formatBytes(unit.sizeBytes)}`,
		);
	}
	console.log(
		`\nThis will permanently remove ${candidates.length} file(s), reclaiming roughly ${formatBytes(totalSizeBytes)}.`,
	);

	if (sonarrTargets.length) {
		console.log("\nSonarr matches to unmonitor:");
		for (const target of sonarrTargets) {
			console.log(
				`  • ${target.showTitle}: seasons ${target.seasonNumbers.join(", ")}`,
			);
		}
	}
	if (radarrTargets.length) {
		console.log("\nRadarr matches to unmonitor:");
		for (const target of radarrTargets) {
			console.log(`  • ${target.title}`);
		}
	}

	const applySonarrUpdates = Boolean(sonarrTargets.length && sonarrClient);
	const applyRadarrUpdates = Boolean(radarrTargets.length && radarrClient);

	const phraseAnswer = await promptOrExit<{ typedPhrase: string }>(
		[
			{
				type: "input",
				name: "typedPhrase",
				message: 'Type DELETE (all caps) to confirm permanent deletion.',
				validate: (input: string) =>
				input.trim().toUpperCase() === "DELETE"
					? true
						: "Please type DELETE exactly to continue.",
			},
		],
	);
	const { typedPhrase } = phraseAnswer;
	if (typedPhrase.trim().toUpperCase() !== "DELETE") {
		console.log("Deletion cancelled.");
		return;
	}

	let deleted = 0;
	const failures: string[] = [];
	for (const candidate of candidates) {
		try {
			await rm(candidate.path);
			deleted += 1;
			console.log(`Deleted ${candidate.path}`);
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err?.code === "ENOENT") {
				console.warn(`Not found (already removed): ${candidate.path}`);
				continue;
			}
			const message = err?.message ?? String(error);
			failures.push(`${candidate.path}: ${message}`);
		}
	}

	console.log(
		`\nDeleted ${deleted} file(s); reclaimed approximately ${formatBytes(totalSizeBytes)}.`,
	);
	if (failures.length) {
		console.error("Some files could not be deleted:");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
	}

	if (applySonarrUpdates && sonarrClient) {
		await applySonarrActions(sonarrClient, sonarrTargets);
	}
	if (applyRadarrUpdates && radarrClient) {
	 await applyRadarrActions(radarrClient, radarrTargets);
	}
}

interface DeletionCandidate {
	path: string;
	sizeBytes: number;
}

function collectDeletionCandidates(
	units: ScoredMediaUnit[],
	allowedRoots: string[],
): DeletionCandidate[] {
	const unique = new Map<string, DeletionCandidate>();
	for (const unit of units) {
		for (const source of unit.sourceItems) {
			if (!source.path || !isPathAllowed(source.path, allowedRoots)) {
				continue;
			}
			if (unique.has(source.path)) {
				continue;
			}
			unique.set(source.path, {
				path: source.path,
				sizeBytes: source.sizeBytes,
			});
		}
	}
	return Array.from(unique.values());
}

function isPathAllowed(filePath: string, allowedRoots: string[]): boolean {
	if (allowedRoots.length === 0) {
		return true;
	}
	const normalized = path.resolve(filePath);
	return allowedRoots.some((root) => {
		const resolved = path.resolve(root);
		return (
			normalized === resolved || normalized.startsWith(resolved + path.sep)
		);
	});
}

function formatDeletionChoiceLabel(
	unit: ScoredMediaUnit,
	rank: number,
): string {
	const size = formatBytes(unit.sizeBytes);
	const plays = `${unit.totalPlayCount} play${unit.totalPlayCount === 1 ? "" : "s"}`;
	const title = formatUnitTitle(unit);
	return `[#${rank}] ${title} — ${size}, ${plays}`;
}

function formatUnitTitle(unit: ScoredMediaUnit): string {
	if (unit.kind === "season" && unit.parentTitle) {
		return `${unit.parentTitle} — ${unit.title}`;
	}
	return unit.title;
}

function normalizeTitle(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	return normalized.length ? normalized : null;
}

function isUnitBlocked(unit: MediaUnit, blocked: Set<string>): boolean {
	if (!blocked.size) {
		return false;
	}
	for (const title of collectUnitTitles(unit)) {
		const normalized = normalizeTitle(title);
		if (normalized && blocked.has(normalized)) {
			return true;
		}
	}
	return false;
}

function collectUnitTitles(unit: MediaUnit): string[] {
	const titles = new Set<string>();
	if (unit.title) {
		titles.add(unit.title);
	}
	if (unit.parentTitle) {
		titles.add(unit.parentTitle);
	}
	for (const source of unit.sourceItems) {
		if (source.title) {
			titles.add(source.title);
		}
		if (source.showTitle) {
			titles.add(source.showTitle);
		}
		if (source.seasonTitle) {
			titles.add(source.seasonTitle);
		}
	}
	return Array.from(titles);
}

interface SonarrTarget {
	showKey: string;
	showTitle: string;
	seasonNumbers: number[];
	externalIds: ExternalIds;
}

interface RadarrTarget {
	ratingKey: string;
	title: string;
	externalIds: ExternalIds;
}

async function buildSonarrTargets(
	units: ScoredMediaUnit[],
	tautulliClient: TautulliClient,
): Promise<SonarrTarget[]> {
	const metadataCache = new Map<string, TautulliMetadataSummary | null>();
	const targets = new Map<string, { showTitle: string; seasons: Set<number>; externalIds: ExternalIds }>();

	for (const unit of units) {
		if (unit.kind !== "season") {
			continue;
		}
		const showKey = getShowRatingKey(unit);
		const seasonNumber = inferSeasonNumber(unit);
		if (!showKey || seasonNumber === null) {
			continue;
		}
		const summary = await getMetadataSummaryCached(
			metadataCache,
			tautulliClient,
			showKey,
		);
		if (!summary) {
			continue;
		}
		const ids = extractExternalIds(summary);
		if (!ids) {
			continue;
		}
		const showTitle =
			unit.parentTitle ??
			unit.sourceItems.find((source) => source.showTitle)?.showTitle ??
			"Unknown show";

		const existing = targets.get(showKey);
		if (existing) {
			existing.seasons.add(seasonNumber);
		} else {
			targets.set(showKey, {
				showTitle,
				seasons: new Set([seasonNumber]),
				externalIds: ids,
			});
		}
	}

	return Array.from(targets.entries()).map(([showKey, value]) => ({
		showKey,
		showTitle: value.showTitle,
		seasonNumbers: Array.from(value.seasons).sort((a, b) => a - b),
		externalIds: value.externalIds,
	}));
}

async function buildRadarrTargets(
	units: ScoredMediaUnit[],
	tautulliClient: TautulliClient,
): Promise<RadarrTarget[]> {
	const metadataCache = new Map<string, TautulliMetadataSummary | null>();
	const targets = new Map<string, RadarrTarget>();

	for (const unit of units) {
		if (unit.kind !== "movie") {
			continue;
		}
		const ratingKey = unit.id;
		const summary = await getMetadataSummaryCached(
			metadataCache,
			tautulliClient,
			ratingKey,
		);
		if (!summary) {
			continue;
		}
		const ids = extractExternalIds(summary);
		if (!ids) {
			continue;
		}
		const title = formatUnitTitle(unit);
		targets.set(ratingKey, { ratingKey, title, externalIds: ids });
	}

	return Array.from(targets.values());
}

async function applySonarrActions(
	client: SonarrClient,
	targets: SonarrTarget[],
): Promise<void> {
	for (const target of targets) {
		try {
			const series = await client.findSeriesByExternalIds(
				target.externalIds,
			);
			if (!series) {
				console.error(
					`[Sonarr] Could not match show "${target.showTitle}" by external IDs.`,
				);
				continue;
			}
			await client.unmonitorSeasons(series.id, target.seasonNumbers);
		} catch (error) {
			console.error(
				`[Sonarr] Failed to update "${target.showTitle}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}

async function applyRadarrActions(
	client: RadarrClient,
	targets: RadarrTarget[],
): Promise<void> {
	for (const target of targets) {
		try {
			const movie = await client.findMovieByExternalIds(
				target.externalIds,
			);
			if (!movie) {
				console.error(
					`[Radarr] Could not match movie "${target.title}" by external IDs.`,
				);
				continue;
			}
			await client.unmonitorMovie(movie.id);
		} catch (error) {
			console.error(
				`[Radarr] Failed to update "${target.title}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}

function getShowRatingKey(unit: ScoredMediaUnit): string | null {
	for (const source of unit.sourceItems) {
		if (source.showKey) {
			return source.showKey;
		}
	}
	return null;
}

function inferSeasonNumber(unit: ScoredMediaUnit): number | null {
	const fromTitle = extractSeasonNumber(unit.title);
	if (fromTitle !== null) {
		return fromTitle;
	}
	for (const source of unit.sourceItems) {
		const fromSource = extractSeasonNumber(source.seasonTitle ?? null);
		if (fromSource !== null) {
			return fromSource;
		}
	}
	return null;
}

function extractSeasonNumber(value: string | null): number | null {
	if (!value) {
		return null;
	}
	const specialsMatch = value.match(/special/i);
	if (specialsMatch) {
		return 0;
	}
	const match = value.match(/season\s*(\d+)/i);
	if (match) {
		return Number(match[1]);
	}
	return null;
}

async function getMetadataSummaryCached(
	cache: Map<string, TautulliMetadataSummary | null>,
	client: TautulliClient,
	ratingKey: string | null,
): Promise<TautulliMetadataSummary | null> {
	if (!ratingKey) {
		return null;
	}
	if (cache.has(ratingKey)) {
		return cache.get(ratingKey) ?? null;
	}
	const summary = await client.getMetadataSummary(ratingKey);
	cache.set(ratingKey, summary ?? null);
	return summary ?? null;
}

function extractExternalIds(
	summary: TautulliMetadataSummary,
): ExternalIds | null {
	const ids: ExternalIds = {};
	for (const guid of summary.guids ?? []) {
		const normalized = guid.toLowerCase();
		if (normalized.includes("tvdb://")) {
			ids.tvdbId = parseIntId(normalized, /tvdb:\/\/(\d+)/);
		} else if (normalized.includes("tmdb://")) {
			ids.tmdbId = parseIntId(normalized, /tmdb:\/\/(\d+)/);
		} else if (normalized.includes("imdb://")) {
			const match = normalized.match(/imdb:\/\/(tt\d+)/);
			if (match) {
				ids.imdbId = match[1] ?? null;
			}
		}
	}

	if (ids.tvdbId || ids.tmdbId || ids.imdbId) {
		return ids;
	}
	return null;
}

function parseIntId(text: string, pattern: RegExp): number | null {
	const match = text.match(pattern);
	if (!match) {
		return null;
	}
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

async function reconfigure(current: AppConfig): Promise<AppConfig> {
	console.log(
		"\nReconfiguring setup. Leave fields blank to keep existing values.",
	);

	const answers = await promptOrExit<{
		tautulliUrl: string;
		tautulliApiKey: string;
		libraryPaths: string[];
		blockedTitles: string[];
	}>([
		{
			type: "input",
			name: "tautulliUrl",
			message: "Tautulli base URL",
			default: current.tautulli?.baseUrl ?? "",
			filter: (value: string) => value.trim(),
		},
		{
			type: "password",
			name: "tautulliApiKey",
			message: "Tautulli API key",
			default: current.tautulli?.apiKey ?? "",
			mask: "*",
			filter: (value: string) => value.trim(),
		},
		{
			type: "input",
			name: "libraryPaths",
			message: "Library paths (comma separated)",
			default: current.libraryPaths.join(", "),
			filter: (value: string) =>
				value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
		},
		{
			type: "input",
			name: "blockedTitles",
			message: "Blocked titles (comma separated)",
			default: current.blockedTitles.join(", "),
			filter: (value: string) =>
				value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
		},
	]);

	const sonarr = await promptForArrSettings("Sonarr", current.sonarr);
	const radarr = await promptForArrSettings("Radarr", current.radarr);

	const updatedConfig: AppConfig = {
		...current,
		tautulli:
			answers.tautulliUrl && answers.tautulliApiKey
				? {
						baseUrl: answers.tautulliUrl,
						apiKey: answers.tautulliApiKey,
					}
				: null,
		sonarr,
		radarr,
		libraryPaths: [...answers.libraryPaths],
		blockedTitles: [...answers.blockedTitles],
	};

	await saveConfig(updatedConfig);
	console.log("Configuration updated.");
	return updatedConfig;
}

async function editBlockedTitles(current: AppConfig): Promise<AppConfig> {
	const defaultText =
		current.blockedTitles.length > 0
			? `${current.blockedTitles.join("\n")}\n`
			: "";
	const { blockedText } = await promptOrExit<{ blockedText: string }>([
		{
			type: "editor",
			name: "blockedText",
			message:
				"Edit the list of blocked titles (one per line). Saved on editor exit.",
			default: defaultText,
		},
	]);
	const updatedList = blockedText
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);

	const updatedConfig: AppConfig = {
		...current,
		blockedTitles: updatedList,
	};
	await saveConfig(updatedConfig);
	console.log(
		`Blocked titles updated (${updatedList.length} entr${updatedList.length === 1 ? "y" : "ies"}).`,
	);
	return updatedConfig;
}

async function promptForArrSettings(
	kind: "Sonarr" | "Radarr",
	existing: ArrConfig | null,
): Promise<ArrConfig | null> {
	const { enable } = await promptOrExit<{ enable: boolean }>([
		{
			type: "confirm",
			name: "enable",
			message: `Enable ${kind} integration?`,
			default: Boolean(existing),
		},
	]);
	if (!enable) {
		return null;
	}

	const answers = await promptOrExit<{
		baseUrl: string;
		apiKey: string;
	}>([
		{
			type: "input",
			name: "baseUrl",
			message: `${kind} base URL`,
			default: existing?.baseUrl ?? "",
			filter: (value: string) => value.trim(),
		},
		{
			type: "password",
			name: "apiKey",
			message: `${kind} API key`,
			default: existing?.apiKey ?? "",
			mask: "*",
			filter: (value: string) => value.trim(),
		},
	]);

	if (!answers.baseUrl || !answers.apiKey) {
		console.warn(`${kind} settings incomplete, disabling integration.`);
		return null;
	}

	return {
		baseUrl: answers.baseUrl,
		apiKey: answers.apiKey,
	};
}

function printPerLibraryTables(
	items: ScoredMediaUnit[],
	options: RunOptions,
): void {
	const grouped = groupByLibrary(items);
	for (const [sectionId, sectionItems] of grouped) {
		const sample = sectionItems[0];
		const sectionName = sample?.librarySectionName ?? sectionId;
		logInfo(`\nSection: ${sectionName}`, options);
		printScoredTable(sectionItems.slice(0, 25));
	}
}

function groupByLibrary(
	items: ScoredMediaUnit[],
): Map<string, ScoredMediaUnit[]> {
	const map = new Map<string, ScoredMediaUnit[]>();
	for (const item of items) {
		const key = `${item.librarySectionId}`;
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(item);
		} else {
			map.set(key, [item]);
		}
	}
	for (const bucket of map.values()) {
		bucket.sort((a, b) => b.score - a.score);
	}
	return map;
}

async function promptForWeights(current: WeightConfig): Promise<WeightConfig> {
	const answers = await promptOrExit<{
		sizeWeight: number;
		ageWeight: number;
		watchWeight: number;
	}>([
		{
			type: "number",
			name: "sizeWeight",
			message: "Weight for file size",
			default: current.sizeWeight,
			validate: validateNonNegative,
		},
		{
			type: "number",
			name: "ageWeight",
			message: "Weight for age",
			default: current.ageWeight,
			validate: validateNonNegative,
		},
		{
			type: "number",
			name: "watchWeight",
			message: "Weight for watch scarcity",
			default: current.watchWeight,
			validate: validateNonNegative,
		},
	]);

	return {
		sizeWeight: Number(answers.sizeWeight ?? defaultWeights.sizeWeight),
		ageWeight: Number(answers.ageWeight ?? defaultWeights.ageWeight),
		watchWeight: Number(answers.watchWeight ?? defaultWeights.watchWeight),
	};
}

function normalizeWeights(weights: WeightConfig): WeightConfig {
	const total =
		weights.sizeWeight + weights.ageWeight + weights.watchWeight || 1;
	return {
		sizeWeight: weights.sizeWeight / total,
		ageWeight: weights.ageWeight / total,
		watchWeight: weights.watchWeight / total,
	};
}

function validateNonNegative(value: unknown): true | string {
	const num = Number(value);
	return Number.isFinite(num) && num >= 0
		? true
		: "Enter a non-negative number";
}

function formatNumber(value: number, digits: number): string {
	return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let idx = 0;
	let value = bytes;
	while (value >= 1024 && idx < units.length - 1) {
		value /= 1024;
		idx += 1;
	}
	const precision = value >= 10 ? 1 : 2;
	return `${value.toFixed(precision)} ${units[idx]}`;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
