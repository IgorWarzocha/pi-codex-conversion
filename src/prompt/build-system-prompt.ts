export interface PromptSkill {
	name: string;
	description: string;
	filePath: string;
}

const CODEX_GUIDELINES = [
	"Prefer a single `apply_patch` call that updates all related files together when one coherent patch will do.",
	"When multiple tool calls are independent, emit them together so they can execute in parallel instead of serializing them.",
	"Use `parallel` only when tool calls are independent and can safely run at the same time.",
	"Use `write_stdin` when an exec session returns `session_id`, and continue until `exit_code` is present.",
	"When polling a running exec session with empty `chars`, wait meaningfully between polls and do not repeatedly poll by reflex.",
	"Do not request `tty` unless interactive terminal behavior is required.",
];

function insertBeforeTrailingContext(prompt: string, section: string): string {
	const currentDateIndex = prompt.lastIndexOf("\nCurrent date:");
	if (currentDateIndex !== -1) {
		return `${prompt.slice(0, currentDateIndex)}\n\n${section}${prompt.slice(currentDateIndex)}`;
	}
	return `${prompt}\n\n${section}`;
}

function injectShell(prompt: string, shell?: string): string {
	if (!shell) {
		return prompt;
	}
	if (/\nCurrent shell:/.test(prompt)) {
		return prompt.replace(/(^Current shell:) .*$/m, `$1 ${shell}`);
	}
	return insertBeforeTrailingContext(prompt, `Current shell: ${shell}`);
}

function decodeXml(text: string): string {
	return text
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

export function extractPiPromptSkills(prompt: string): PromptSkill[] {
	const skillsBlockMatch = prompt.match(/<available_skills>\n([\s\S]*?)\n<\/available_skills>/);
	if (!skillsBlockMatch) {
		return [];
	}

	const skillMatches = skillsBlockMatch[1].matchAll(
		/<skill>\n\s*<name>([\s\S]*?)<\/name>\n\s*<description>([\s\S]*?)<\/description>\n\s*<location>([\s\S]*?)<\/location>\n\s*<\/skill>/g,
	);

	return Array.from(skillMatches, (match) => ({
		name: decodeXml(match[1].trim()),
		description: decodeXml(match[2].trim()),
		filePath: decodeXml(match[3].trim()),
	}));
}

function injectSkills(prompt: string, skills: PromptSkill[]): string {
	if (skills.length === 0 || /\n## Skills\b/.test(prompt) || /<skills_instructions>/.test(prompt)) {
		return prompt;
	}

	const lines = [
		"<skills_instructions>",
		"## Skills",
		"A skill is a set of local instructions in a `SKILL.md` file.",
		"### Available skills",
	];

	for (const skill of skills) {
		lines.push(`- ${skill.name}: ${skill.description} (file: ${skill.filePath})`);
	}

	lines.push("### How to use skills");
	lines.push("- Use a skill when the user names it (`$SkillName` or plain text) or when the request clearly matches its description.");
	lines.push("- Use the minimal required set of skills. If multiple apply, use them together and state the order briefly.");
	lines.push("- For each selected skill, open its `SKILL.md`, resolve relative paths from the skill directory first, load only the files you need, and prefer existing scripts/assets/templates over recreating them.");
	lines.push("### Fallback");
	lines.push("- If a skill is missing or its path cannot be read, say so briefly and continue with the best fallback approach.");
	lines.push("</skills_instructions>");

	return insertBeforeTrailingContext(prompt, lines.join("\n"));
}

function injectGuidelines(prompt: string): string {
	const match = prompt.match(/(^Guidelines:\n)([\s\S]*?)(\n\n(?:Pi documentation:|# Project Context|# Skills|Current date:))/m);
	if (!match || match.index === undefined) {
		const fallbackSection = `Codex mode guidelines:\n${CODEX_GUIDELINES.map((line) => `- ${line}`).join("\n")}`;
		return insertBeforeTrailingContext(prompt, fallbackSection);
	}

	const [, header, body, suffix] = match;
	const existingLines = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "));
	const existing = new Set(existingLines.map((line) => line.slice(2)));
	const additions = CODEX_GUIDELINES.filter((line) => !existing.has(line)).map((line) => `- ${line}`);
	if (additions.length === 0) {
		return prompt;
	}

	const normalizedBody = body.trimEnd();
	const replacement = `${header}${normalizedBody}\n${additions.join("\n")}${suffix}`;
	return `${prompt.slice(0, match.index)}${replacement}${prompt.slice(match.index + match[0].length)}`;
}

export function buildCodexSystemPrompt(basePrompt: string, options: { skills?: PromptSkill[]; shell?: string } = {}): string {
	return injectShell(injectSkills(injectGuidelines(basePrompt), options.skills ?? []), options.shell);
}
