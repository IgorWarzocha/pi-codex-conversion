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
	assert.match(prompt, /- Prefer a single `apply_patch` call that updates all related files together when one coherent patch will do\./);
	assert.match(prompt, /- When making coordinated edits across multiple files, include them in one `apply_patch` call instead of splitting them into separate patches\./);
	assert.match(prompt, /- When multiple tool calls are independent, emit them together so they can execute in parallel instead of serializing them\./);
	assert.match(prompt, /- Use `parallel` only when tool calls are independent and can safely run at the same time\./);
	assert.match(prompt, /- Use `write_stdin` when an exec session returns `session_id`, and continue until `exit_code` is present\./);
	assert.match(prompt, /- For short or non-interactive commands, prefer the default `exec_command` wait instead of a tiny `yield_time_ms` that forces an extra follow-up call\./);
	assert.match(prompt, /- When polling a running exec session with empty `chars`, wait meaningfully between polls and do not repeatedly poll by reflex\./);
	assert.match(prompt, /- Do not request `tty` unless interactive terminal behavior is required\./);
});

test("buildCodexSystemPrompt appends fallback guidance when the base prompt has no Guidelines section", () => {
	const prompt = buildCodexSystemPrompt(`Custom prompt\n\nCurrent date: 2026-03-14\nCurrent working directory: /tmp/example-workspace`, {
		shell: "/bin/zsh",
	});

	assert.match(prompt, /Codex mode guidelines:/);
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
