import { getSettingsListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";
import {
	COMPACTION_MODELS,
	COMPACTION_REASONING_LEVELS,
	DEFAULT_CODEX_CONVERSION_CONFIG,
	normalizeCodexVerbosity,
	normalizeCompactionModel,
	normalizeCompactionReasoning,
	type CodexConversionConfig,
} from "../adapter/config.ts";
import { CHANGELOG_URL, DISCORD_URL, GITHUB_URL, ISSUE_URL, openExternalUrl } from "./links.ts";

export interface CodexSettingsScreenOptions {
	initialConfig: CodexConversionConfig;
	onChange: (nextConfig: CodexConversionConfig) => boolean;
	initialTab?: SettingsTab;
}

type SettingsTab = "general" | "compaction" | "overrides";

const TAB_ORDER: readonly SettingsTab[] = ["general", "compaction", "overrides"];

export async function openCodexSettingsScreen(ctx: ExtensionContext, options: CodexSettingsScreenOptions): Promise<void> {
	let draft = { ...options.initialConfig };
	let activeTab: SettingsTab = options.initialTab ?? "general";

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let settingsList = createSettingsList(activeTab, draft, options, (nextDraft) => {
			draft = nextDraft;
		}, done, () => tui.requestRender());

		const switchTab = () => {
			const currentIndex = TAB_ORDER.indexOf(activeTab);
			activeTab = TAB_ORDER[(currentIndex + 1) % TAB_ORDER.length] ?? "general";
			settingsList = createSettingsList(activeTab, draft, options, (nextDraft) => {
				draft = nextDraft;
			}, done, () => tui.requestRender());
			tui.requestRender();
		};

		return {
			render: (width: number) =>
				[
					rule(width, theme, "accent"),
					formatTabs(activeTab, theme),
					rule(width, theme, "borderMuted"),
					...(activeTab === "compaction" ? formatCompactionNotes(theme) : []),
					...(activeTab === "overrides" ? formatOverridesNotes(theme) : []),
					"",
					...settingsList.render(width),
					rule(width, theme, "borderMuted"),
					...formatLinks(theme),
					rule(width, theme, "accent"),
					theme.fg("dim", "  Tab to switch sections · g/c/d/i open links"),
				].map((line) => truncateToWidth(line, width, "")),
			invalidate: () => settingsList.invalidate(),
			handleInput: (data: string) => {
				if (data === "\t") {
					switchTab();
					return;
				}
				if (handleLinkKey(data, ctx)) return;
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function formatCompactionNotes(theme: Theme): string[] {
	return [
		theme.fg("dim", "  Beta: native OpenAI Responses compaction is experimental. Please report any issues."),
		theme.fg("error", "  Warning: do not turn this off mid-session; old context may be much less reliable."),
	];
}

function formatOverridesNotes(theme: Theme): string[] {
	return [
		theme.fg("dim", "  Advanced tool-surface overrides. No /codex subcommands are provided for these."),
	];
}

function rule(width: number, theme: Theme, color: "accent" | "borderMuted"): string {
	return theme.fg(color, "─".repeat(Math.max(0, width)));
}

function createSettingsList(
	tab: SettingsTab,
	draft: CodexConversionConfig,
	options: CodexSettingsScreenOptions,
	onDraftChanged: (draft: CodexConversionConfig) => void,
	done: (value?: void) => void,
	requestRender: () => void,
): SettingsList {
	let settingsList: SettingsList;
	settingsList = new SettingsList(buildItems(tab, draft), 8, getSettingsListTheme(), (id, value) => {
		const nextDraft = applySettingChange(id, value, draft);
		const previousValue = buildItems(tab, draft).find((item) => item.id === id)?.currentValue;
		if (options.onChange(nextDraft)) {
			onDraftChanged(nextDraft);
			draft = nextDraft;
		} else if (previousValue !== undefined) {
			settingsList.updateValue(id, previousValue);
		}
		requestRender();
	}, () => done(undefined));
	return settingsList;
}

function buildItems(tab: SettingsTab, draft: CodexConversionConfig): SettingItem[] {
	if (tab === "compaction") {
		return [
			{ id: "responsesCompaction", label: "Responses compaction", currentValue: (draft.responsesCompaction ?? false) ? "on" : "off", values: ["off", "on"] },
			{ id: "compactionModel", label: "Model", currentValue: draft.compactionModel, values: [...COMPACTION_MODELS] },
			{ id: "compactionReasoning", label: "Reasoning", currentValue: draft.compactionReasoning, values: [...COMPACTION_REASONING_LEVELS] },
		];
	}

	if (tab === "overrides") {
		return [
			{ id: "applyPatchOnly", label: "Apply patch only", currentValue: draft.applyPatchOnly ? "on" : "off", values: ["off", "on"] },
		];
	}

	return [
		{ id: "useOnAllModels", label: "Use on all models", currentValue: draft.useOnAllModels ? "on" : "off", values: ["off", "on"] },
		{ id: "statusLine", label: "Statusline", currentValue: draft.statusLine ? "on" : "off", values: ["off", "on"] },
		{ id: "fast", label: "Fast mode", currentValue: draft.fast ? "on" : "off", values: ["off", "on"] },
		{ id: "webSearch", label: "Web search", currentValue: draft.webSearch ? "on" : "off", values: ["off", "on"] },
		{ id: "imageGeneration", label: "Image generation", currentValue: draft.imageGeneration ? "on" : "off", values: ["off", "on"] },
		{ id: "verbosity", label: "Verbosity", currentValue: draft.verbosity, values: ["low", "medium", "high"] },
	];
}

function applySettingChange(id: string, value: string, draft: CodexConversionConfig): CodexConversionConfig {
	const nextDraft = { ...draft };
	if (id === "applyPatchOnly") nextDraft.applyPatchOnly = value === "on";
	if (id === "useOnAllModels") nextDraft.useOnAllModels = value === "on";
	if (id === "statusLine") nextDraft.statusLine = value === "on";
	if (id === "fast") nextDraft.fast = value === "on";
	if (id === "webSearch") nextDraft.webSearch = value === "on";
	if (id === "imageGeneration") nextDraft.imageGeneration = value === "on";
	if (id === "responsesCompaction") nextDraft.responsesCompaction = value === "on";
	if (id === "compactionModel") nextDraft.compactionModel = normalizeCompactionModel(value) ?? DEFAULT_CODEX_CONVERSION_CONFIG.compactionModel;
	if (id === "compactionReasoning") nextDraft.compactionReasoning = normalizeCompactionReasoning(value) ?? DEFAULT_CODEX_CONVERSION_CONFIG.compactionReasoning;
	if (id === "verbosity") nextDraft.verbosity = normalizeCodexVerbosity(value) ?? DEFAULT_CODEX_CONVERSION_CONFIG.verbosity;
	return nextDraft;
}

function formatTabs(activeTab: SettingsTab, theme: Theme): string {
	const renderTab = (tab: SettingsTab, label: string) => activeTab === tab ? theme.bold(label) : theme.fg("dim", label);
	return `  ${renderTab("general", "General")}  ${theme.fg("dim", "/")}  ${renderTab("compaction", "Compaction")}  ${theme.fg("dim", "/")}  ${renderTab("overrides", "Overrides")}`;
}

function formatLinks(theme: Theme): string[] {
	return [
		`${theme.bold("g")} github  ${theme.fg("dim", GITHUB_URL)}`,
		`${theme.bold("c")} changes ${theme.fg("dim", CHANGELOG_URL)}`,
		`${theme.bold("d")} discord ${theme.fg("dim", DISCORD_URL)}`,
		`${theme.bold("i")} issue   ${theme.fg("dim", ISSUE_URL)}`,
	];
}

function handleLinkKey(data: string, ctx: ExtensionContext): boolean {
	const target = getLinkTarget(data);
	if (!target) return false;
	openExternalUrl(target.url);
	ctx.ui.notify(target.message, "info");
	return true;
}

function getLinkTarget(data: string): { url: string; message: string } | undefined {
	switch (data) {
		case "g":
			return { url: GITHUB_URL, message: "Opened GitHub" };
		case "c":
			return { url: CHANGELOG_URL, message: "Opened changelog" };
		case "d":
			return { url: DISCORD_URL, message: "Opened Discord" };
		case "i":
			return { url: ISSUE_URL, message: "Opened issue form" };
		default:
			return undefined;
	}
}
