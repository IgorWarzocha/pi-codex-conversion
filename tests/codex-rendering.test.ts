import test from "node:test";
import assert from "node:assert/strict";
import { renderGroupedExecCommandCall } from "../src/tools/codex-rendering.ts";
import { createExecCommandTracker } from "../src/tools/exec-command-state.ts";

function createTheme() {
	return {
		fg: (_role: string, text: string) => text,
		bold: (text: string) => text,
	};
}

test("renderGroupedExecCommandCall coalesces consecutive read-only calls like Codex", () => {
	const theme = createTheme();
	const text = renderGroupedExecCommandCall(
		[
			[{ kind: "search", command: "rg -n shimmer_spans src", query: "shimmer_spans", path: "src" }],
			[{ kind: "read", command: "cat shimmer.rs", name: "shimmer.rs", path: "shimmer.rs" }],
			[{ kind: "read", command: "cat status_indicator_widget.rs", name: "status_indicator_widget.rs", path: "status_indicator_widget.rs" }],
		],
		"done",
		theme,
	);

	assert.equal(text, "• Explored\n  └ Search shimmer_spans in src\n    Read shimmer.rs, status_indicator_widget.rs");
});

test("exec tracker hides earlier grouped exploring rows and keeps the latest visible", () => {
	const tracker = createExecCommandTracker();
	tracker.recordStart("call-1", "cat alpha.ts");
	tracker.recordStart("call-2", "cat beta.ts");

	const first = tracker.getRenderInfo("call-1", "cat alpha.ts");
	const second = tracker.getRenderInfo("call-2", "cat beta.ts");

	assert.equal(first.hidden, true);
	assert.equal(second.hidden, false);
	assert.deepEqual(
		second.actionGroups,
		[
			[{ kind: "read", command: "cat alpha.ts", name: "alpha.ts", path: "alpha.ts" }],
			[{ kind: "read", command: "cat beta.ts", name: "beta.ts", path: "beta.ts" }],
		],
	);
});

test("exec tracker resolves persistent session completion to the originating tool call", () => {
	const tracker = createExecCommandTracker();
	tracker.recordStart("call-1", "npm test");
	tracker.recordPersistentSession("call-1", 101);
	tracker.recordEnd("call-1");

	tracker.recordStart("call-2", "npm test");
	tracker.recordPersistentSession("call-2", 202);
	tracker.recordEnd("call-2");

	tracker.recordSessionFinished(101);

	assert.equal(tracker.getRenderInfo("call-1", "npm test").status, "done");
	assert.equal(tracker.getRenderInfo("call-2", "npm test").status, "running");
	assert.equal(tracker.getState("npm test"), "running");

	tracker.recordSessionFinished(202);

	assert.equal(tracker.getRenderInfo("call-2", "npm test").status, "done");
	assert.equal(tracker.getState("npm test"), "done");
});

test("renderGroupedExecCommandCall keeps distinct reads that share a basename", () => {
	const theme = createTheme();
	const text = renderGroupedExecCommandCall(
		[
			[{ kind: "read", command: "cat src/index.ts", name: "index.ts", path: "src/index.ts" }],
			[{ kind: "read", command: "cat tests/index.ts", name: "index.ts", path: "tests/index.ts" }],
		],
		"done",
		theme,
	);

	assert.equal(text, "• Explored\n  └ Read src/index.ts, tests/index.ts");
});

test("renderGroupedExecCommandCall annotates SKILL.md reads with the skill directory", () => {
	const theme = createTheme();
	const text = renderGroupedExecCommandCall(
		[
			[
				{
					kind: "read",
					command: "cat /home/user/.pi/agent/skills/anti-ai-copy/SKILL.md",
					name: "SKILL.md",
					path: "/home/user/.pi/agent/skills/anti-ai-copy/SKILL.md",
				},
			],
			[{ kind: "read", command: "cat AGENTS.md", name: "AGENTS.md", path: "AGENTS.md" }],
		],
		"done",
		theme,
	);

	assert.equal(text, "• Explored\n  └ Read anti-ai-copy skill, AGENTS.md");
});

test("renderGroupedExecCommandCall only annotates SKILL.md reads under skills directories", () => {
	const theme = createTheme();
	const text = renderGroupedExecCommandCall(
		[
			[
				{
					kind: "read",
					command: "cat /repo/docs/SKILL.md",
					name: "SKILL.md",
					path: "/repo/docs/SKILL.md",
				},
			],
		],
		"done",
		theme,
	);

	assert.equal(text, "• Explored\n  └ Read SKILL.md");
});

test("renderGroupedExecCommandCall preserves earlier reads when a coalesced batch ends with a skill", () => {
	const theme = createTheme();
	const text = renderGroupedExecCommandCall(
		[
			[{ kind: "read", command: "cat README.md", name: "README.md", path: "README.md" }],
			[
				{
					kind: "read",
					command: "cat /home/user/.pi/agent/skills/anti-ai-copy/SKILL.md",
					name: "SKILL.md",
					path: "/home/user/.pi/agent/skills/anti-ai-copy/SKILL.md",
				},
			],
		],
		"done",
		theme,
	);

	assert.equal(text, "• Explored\n  └ Read README.md, anti-ai-copy skill");
});

test("renderGroupedExecCommandCall keeps multiple skill reads human-readable", () => {
	const theme = createTheme();
	const text = renderGroupedExecCommandCall(
		[
			[
				{
					kind: "read",
					command: "cat /home/user/.pi/agent/skills/anti-ai-copy/SKILL.md",
					name: "SKILL.md",
					path: "/home/user/.pi/agent/skills/anti-ai-copy/SKILL.md",
				},
			],
			[
				{
					kind: "read",
					command: "cat /home/user/.pi/agent/skills/skill-creator/SKILL.md",
					name: "SKILL.md",
					path: "/home/user/.pi/agent/skills/skill-creator/SKILL.md",
				},
			],
		],
		"done",
		theme,
	);

	assert.equal(text, "• Explored\n  └ Read anti-ai-copy skill, skill-creator skill");
});
