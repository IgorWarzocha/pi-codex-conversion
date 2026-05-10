import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexSystemPrompt, extractPiPromptSkills } from "../src/prompt/build-system-prompt.ts";

const PI_BASE_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- exec_command: Run a command.
- write_stdin: Write to a running exec session.
- apply_patch: Edit files by applying a patch.
- parallel: Run multiple tool calls in parallel.

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Prefer \`rg\` for search
- Use exec_command for local text-file reads

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /docs/README.md
- Additional docs: /docs

# Project Context

Project-specific instructions and guidelines:

## AGENTS.md

Be careful.

# Skills

Use installed skills when relevant.

Current date: 2026-03-14
Current working directory: /tmp/example-workspace`;

test("buildCodexSystemPrompt preserves Pi-composed sections and adds a narrow Codex delta", () => {
	const prompt = buildCodexSystemPrompt(PI_BASE_PROMPT, { shell: "/bin/bash" });

	assert.match(
		prompt,
		/^You are an expert coding assistant operating inside pi, a coding agent harness\. You help users by reading files, executing commands, editing code, and writing new files\./,
	);
	assert.match(prompt, /^Available tools:\n- exec_command: Run a command\./m);
	assert.match(prompt, /^Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):$/m);
	assert.match(prompt, /^# Project Context$/m);
	assert.match(prompt, /^## AGENTS\.md$/m);
	assert.match(prompt, /^# Skills$/m);
	assert.match(prompt, /^Current shell: \/bin\/bash$/m);
	assert.match(prompt, /^Current date: 2026-03-14$/m);
	assert.match(prompt, /^Current working directory: \/tmp\/example-workspace$/m);
	assert.match(prompt, /- Use `exec_command` for shell commands, file inspection, builds, and tests; prefer `rg` \/ `rg --files` for discovery and focused commands over truncation\./);
	assert.match(prompt, /- Use `apply_patch` for text-file changes, including creates\/deletes\/moves; group related multi-file edits into one patch\./);
	assert.match(prompt, /- Prefer the `apply_patch` tool; use shell `apply_patch` only when chaining edits with other shell steps\./);
	assert.match(prompt, /- Use `write_stdin` only for running `exec_command` sessions; poll sparingly\./);
	assert.match(prompt, /- Run independent tool calls in parallel when practical\./);
	assert.equal(prompt.match(/^Guidelines:$/gm)?.length, 1);
	assert.doesNotMatch(prompt, /Codex mode guidelines:/);
	assert.doesNotMatch(prompt, /Native `image_generation` outputs are saved/);
});

test("buildCodexSystemPrompt appends to Guidelines before Pi documentation with parenthetical", () => {
	const prompt = buildCodexSystemPrompt(`Guidelines:
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself):
- Main documentation: /docs/README.md

Current date: 2026-03-14`);

	assert.equal(prompt.match(/^Guidelines:$/gm)?.length, 1);
	assert.match(prompt, /Guidelines:\n- Be concise in your responses\n- Use `exec_command`/);
	assert.match(prompt, /\n\nPi documentation \(read only when the user asks about pi itself\):/);
});

test("buildCodexSystemPrompt inserts fallback Guidelines when the base prompt has no Guidelines section", () => {
	const prompt = buildCodexSystemPrompt(`Custom prompt\n\nCurrent date: 2026-03-14\nCurrent working directory: /tmp/example-workspace`, {
		shell: "/bin/zsh",
	});

	assert.match(prompt, /^Guidelines:$/m);
	assert.doesNotMatch(prompt, /Codex mode guidelines:/);
	assert.match(prompt, /^Current shell: \/bin\/zsh$/m);
	assert.match(prompt, /^Current date: 2026-03-14$/m);
});

test("buildCodexSystemPrompt injects skill inventory when Pi omitted it", () => {
	const prompt = buildCodexSystemPrompt(
		`You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
- Prefer \`rg\`

Current date: 2026-03-14
Current working directory: /tmp/example-workspace`,
		{
			skills: [
				{
					name: "agent-native-hardening",
					description: "Hardening workflow for JS and TS repos",
					filePath: "/skills/agent-native-hardening/SKILL.md",
				},
			],
		},
	);

	assert.match(prompt, /<skills_instructions>/);
	assert.match(prompt, /^## Skills$/m);
	assert.match(prompt, /^### Available skills$/m);
	assert.match(prompt, /- agent-native-hardening: Hardening workflow for JS and TS repos \(file: \/skills\/agent-native-hardening\/SKILL\.md\)/);
	assert.match(prompt, /^### How to use skills$/m);
	assert.match(prompt, /- Use a skill when the user names it/);
	assert.match(prompt, /^### Fallback$/m);
	assert.match(prompt, /- If a skill is missing or its path cannot be read/);
	assert.match(prompt, /<\/skills_instructions>/);
});

test("buildCodexSystemPrompt rewrites an existing shell line to the adapter shell", () => {
	const prompt = buildCodexSystemPrompt(
		`Prompt

Current shell: /bin/bash
Current date: 2026-03-14
Current working directory: /tmp/example-workspace`,
		{ shell: "/bin/zsh" },
	);

	assert.equal(prompt.match(/^Current shell:/gm)?.length, 1);
	assert.match(prompt, /^Current shell: \/bin\/zsh$/m);
});

test("buildCodexSystemPrompt rewrites fish shell lines to bash when codex mode forces bash", () => {
	const prompt = buildCodexSystemPrompt(
		`Prompt

Current shell: /usr/bin/fish
Current date: 2026-03-14
Current working directory: /tmp/example-workspace`,
		{ shell: "/bin/bash" },
	);

	assert.equal(prompt.match(/^Current shell:/gm)?.length, 1);
	assert.match(prompt, /^Current shell: \/bin\/bash$/m);
});

test("extractPiPromptSkills reads Pi-style available_skills inventory", () => {
	const skills = extractPiPromptSkills(`Prefix

<available_skills>
  <skill>
    <name>agent-native-hardening</name>
    <description>Hardening workflow for JS &amp; TS repos</description>
    <location>/skills/agent-native-hardening/SKILL.md</location>
  </skill>
</available_skills>

Suffix`);

	assert.deepEqual(skills, [
		{
			name: "agent-native-hardening",
			description: "Hardening workflow for JS & TS repos",
			filePath: "/skills/agent-native-hardening/SKILL.md",
		},
	]);
});
