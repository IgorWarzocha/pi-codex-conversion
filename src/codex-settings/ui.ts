import { DynamicBorder, getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, SettingsList, Spacer, Text, type SettingItem } from "@earendil-works/pi-tui";
import { DEFAULT_CODEX_CONVERSION_CONFIG, normalizeCodexVerbosity, type CodexConversionConfig } from "../adapter/config.ts";
import { CHANGELOG_URL, DISCORD_URL, GITHUB_URL, ISSUE_URL, openExternalUrl } from "./links.ts";

export interface CodexSettingsScreenOptions {
	initialConfig: CodexConversionConfig;
	onChange: (nextConfig: CodexConversionConfig) => boolean;
}

export async function openCodexSettingsScreen(ctx: ExtensionContext, options: CodexSettingsScreenOptions): Promise<void> {
	let draft = { ...options.initialConfig };
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const buildItems = (): SettingItem[] => [
			{ id: "useOnAllModels", label: "Use on all models", currentValue: draft.useOnAllModels ? "on" : "off", values: ["off", "on"] },
			{ id: "fast", label: "Fast mode", currentValue: draft.fast ? "on" : "off", values: ["off", "on"] },
			{ id: "webSearch", label: "Web search", currentValue: draft.webSearch ? "on" : "off", values: ["off", "on"] },
			{ id: "imageGeneration", label: "Image generation", currentValue: draft.imageGeneration ? "on" : "off", values: ["off", "on"] },
			{ id: "verbosity", label: "Verbosity", currentValue: draft.verbosity, values: ["low", "medium", "high"] },
		];

		const container = new Container();
		const panel = new Box(1, 0);
		panel.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		let settingsList: SettingsList;
		settingsList = new SettingsList(buildItems(), 6, getSettingsListTheme(), (id, value) => {
			const nextDraft = { ...draft };
			if (id === "useOnAllModels") nextDraft.useOnAllModels = value === "on";
			if (id === "fast") nextDraft.fast = value === "on";
			if (id === "webSearch") nextDraft.webSearch = value === "on";
			if (id === "imageGeneration") nextDraft.imageGeneration = value === "on";
			if (id === "verbosity") nextDraft.verbosity = normalizeCodexVerbosity(value) ?? DEFAULT_CODEX_CONVERSION_CONFIG.verbosity;
			if (options.onChange(nextDraft)) {
				draft = nextDraft;
			}
			tui.requestRender();
		}, () => done(undefined));
		panel.addChild(settingsList);
		panel.addChild(new DynamicBorder((text) => theme.fg("dim", text)));
		panel.addChild(
			new Text(
				[
					`${theme.bold("g")} github  ${theme.fg("dim", GITHUB_URL)}`,
					`${theme.bold("c")} changes ${theme.fg("dim", CHANGELOG_URL)}`,
					`${theme.bold("d")} discord ${theme.fg("dim", DISCORD_URL)}`,
					`${theme.bold("i")} issue   ${theme.fg("dim", ISSUE_URL)}`,
				].join("\n"),
				0,
				0,
			),
		);
		panel.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Spacer(1));
		container.addChild(panel);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (handleLinkKey(data, ctx)) return;
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
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
