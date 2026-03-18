import test from "node:test";
import assert from "node:assert/strict";
import { hasBashAstSupport, parseShellLcPlainCommands } from "../src/shell/bash.ts";
import { summarizeShellCommand } from "../src/shell/summary.ts";
import { isSmallFormattingCommand } from "../src/shell/parse.ts";

test("classifies simple file reads as explored reads", () => {
	const summary = summarizeShellCommand("cat README.md");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [{ kind: "read", command: "cat README.md", name: "README.md", path: "README.md" }]);
});

test("tracks cd prefixes for subsequent read commands", () => {
	const summary = summarizeShellCommand("cd src && sed -n '1,20p' index.ts");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [{ kind: "read", command: "sed -n 1,20p index.ts", name: "index.ts", path: "src/index.ts" }]);
});

test("ignores printf separators between semicolon-delimited reads", () => {
	const summary = summarizeShellCommand(
		"cd vendor/toon; sed -n '1,260p' packages/toon/package.json; printf '\n---README---\n'; sed -n '1,260p' packages/toon/README.md",
	);
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/package.json",
			name: "package.json",
			path: "vendor/toon/packages/toon/package.json",
		},
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/README.md",
			name: "README.md",
			path: "vendor/toon/packages/toon/README.md",
		},
	]);
});

test("ignores printf separators between connector-delimited reads", () => {
	const summary = summarizeShellCommand(
		"cd vendor/toon && sed -n '1,260p' packages/toon/src/index.ts && printf '\n---TYPES---\n' && sed -n '1,260p' packages/toon/src/types.ts",
	);
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/src/index.ts",
			name: "index.ts",
			path: "vendor/toon/packages/toon/src/index.ts",
		},
		{
			kind: "read",
			command: "sed -n 1,260p packages/toon/src/types.ts",
			name: "types.ts",
			path: "vendor/toon/packages/toon/src/types.ts",
		},
	]);
});

test("classifies awk with a file operand as a read", () => {
	const summary = summarizeShellCommand("awk '{print $1}' Cargo.toml");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [
		{
			kind: "read",
			command: "awk '{print $1}' Cargo.toml",
			name: "Cargo.toml",
			path: "Cargo.toml",
		},
	]);
});

test("classifies python file-walk scripts as explored listing", () => {
	const py = summarizeShellCommand(`python -c "import os; print(os.listdir('.'))"`);
	assert.equal(py.maskAsExplored, true);
	assert.deepEqual(py.actions, [{ kind: "list", command: `python -c 'import os; print(os.listdir('"'"'.'"'"'))'` }]);

	const py3 = summarizeShellCommand(`python3 -c "import glob; print(glob.glob('*.rs'))"`);
	assert.equal(py3.maskAsExplored, true);
	assert.deepEqual(py3.actions, [{ kind: "list", command: `python3 -c 'import glob; print(glob.glob('"'"'*.rs'"'"'))'` }]);
});

test("keeps non-file-walking python scripts as raw runs", () => {
	const summary = summarizeShellCommand(`python -c "print('hello')"`);
	assert.equal(summary.maskAsExplored, false);
	assert.deepEqual(summary.actions, [{ kind: "run", command: `python -c 'print('"'"'hello'"'"')'` }]);
});

test("drops formatting helpers after search and list commands", () => {
	const search = summarizeShellCommand("rg -n foo src | wc -l");
	assert.equal(search.maskAsExplored, true);
	assert.deepEqual(search.actions, [{ kind: "search", command: "rg -n foo src", query: "foo", path: "src" }]);

	const list = summarizeShellCommand("rg --files | xargs echo");
	assert.equal(list.maskAsExplored, true);
	assert.deepEqual(list.actions, [{ kind: "list", command: "rg --files", path: undefined }]);
});

test("keeps mutating xargs pipelines as raw runs", () => {
	const summary = summarizeShellCommand("rg -l foo src | xargs perl -pi -e 's/foo/bar/g'");
	assert.equal(summary.maskAsExplored, false);
	assert.deepEqual(summary.actions, [{ kind: "run", command: "rg -l foo src | xargs perl -pi -e s/foo/bar/g" }]);
});

test("drops awk formatting helpers in pipelines", () => {
	const summary = summarizeShellCommand("rg --files | awk '{print $1}'");
	assert.equal(summary.maskAsExplored, true);
	assert.deepEqual(summary.actions, [{ kind: "list", command: "rg --files", path: undefined }]);
});

test("supports shell wrapper commands and helper pipelines", () => {
	assert.deepEqual(summarizeShellCommand("bash -lc 'head -n50 Cargo.toml'").actions, [
		{ kind: "read", command: "head -n50 Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" },
	]);

	assert.deepEqual(summarizeShellCommand("/bin/bash -lc 'sed -n 1,10p Cargo.toml'").actions, [
		{ kind: "read", command: "sed -n 1,10p Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" },
	]);

	assert.deepEqual(summarizeShellCommand("/bin/zsh -lc 'sed -n 1,10p Cargo.toml'").actions, [
		{ kind: "read", command: "sed -n 1,10p Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" },
	]);

	assert.deepEqual(summarizeShellCommand("bash -lc 'cd foo && cat foo.txt'").actions, [
		{ kind: "read", command: "cat foo.txt", name: "foo.txt", path: "foo/foo.txt" },
	]);

	assert.equal(summarizeShellCommand("bash -lc 'cd foo && bar'").maskAsExplored, false);

	assert.deepEqual(summarizeShellCommand("cat tui/Cargo.toml | sed -n '1,200p'").actions, [
		{ kind: "read", command: "cat tui/Cargo.toml", name: "Cargo.toml", path: "tui/Cargo.toml" },
	]);

	assert.deepEqual(summarizeShellCommand("ls -la | sed -n '1,120p'").actions, [
		{ kind: "list", command: "ls -la", path: undefined },
	]);

	assert.deepEqual(summarizeShellCommand("yes | rg --files").actions, [{ kind: "list", command: "rg --files", path: undefined }]);
	assert.deepEqual(summarizeShellCommand("rg --files | nl -ba").actions, [{ kind: "list", command: "rg --files", path: undefined }]);
});

test("supports fd and find summaries", () => {
	assert.deepEqual(summarizeShellCommand("fd -t f src/").actions, [{ kind: "list", command: "fd -t f src/", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("fd main src").actions, [{ kind: "search", command: "fd main src", query: "main", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("find . -name '*.rs'").actions, [{ kind: "search", command: "find . -name '*.rs'", query: "*.rs", path: "." }]);
	assert.deepEqual(summarizeShellCommand("find src -type f").actions, [{ kind: "list", command: "find src -type f", path: "src" }]);
});

test("tracks cwd for list commands and strips powershell wrappers", () => {
	assert.deepEqual(summarizeShellCommand("cd codex-rs && rg --files").actions, [{ kind: "list", command: "rg --files", path: "codex-rs" }]);
	assert.deepEqual(summarizeShellCommand("powershell -Command Get-ChildItem").actions, [{ kind: "run", command: "Get-ChildItem" }]);
	assert.deepEqual(summarizeShellCommand("pwsh -NoProfile -c 'Write-Host hi'").actions, [{ kind: "run", command: "Write-Host hi" }]);
});

test("covers additional codex parser cases", () => {
	assert.deepEqual(summarizeShellCommand("grep -R CODEX_SANDBOX_ENV_VAR -n core/src/spawn.rs").actions, [
		{ kind: "search", command: "grep -R CODEX_SANDBOX_ENV_VAR -n core/src/spawn.rs", query: "CODEX_SANDBOX_ENV_VAR", path: "spawn.rs" },
	]);
	assert.deepEqual(summarizeShellCommand("grep -R 'src/main.rs' -n .").actions, [
		{ kind: "search", command: "grep -R src/main.rs -n .", query: "src/main.rs", path: "." },
	]);
	assert.deepEqual(summarizeShellCommand("grep -R 'COD`EX_SANDBOX' -n").actions, [
		{ kind: "search", command: "grep -R 'COD`EX_SANDBOX' -n", query: "COD`EX_SANDBOX", path: undefined },
	]);
	assert.deepEqual(summarizeShellCommand("rg --colors=never -n foo src").actions, [
		{ kind: "search", command: "rg --colors=never -n foo src", query: "foo", path: "src" },
	]);
	assert.deepEqual(summarizeShellCommand("head -n50 Cargo.toml").actions, [
		{ kind: "read", command: "head -n50 Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" },
	]);
	assert.deepEqual(summarizeShellCommand("tail -n+10 README.md").actions, [
		{ kind: "read", command: "tail -n+10 README.md", name: "README.md", path: "README.md" },
	]);
	assert.deepEqual(summarizeShellCommand("cat -- ./-strange-file-name").actions, [
		{ kind: "read", command: "cat -- ./-strange-file-name", name: "-strange-file-name", path: "./-strange-file-name" },
	]);
	assert.deepEqual(summarizeShellCommand("sed -n '12,20p' Cargo.toml").actions, [
		{ kind: "read", command: "sed -n 12,20p Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" },
	]);
});

test("classifies ripgrep searches separately from command runs", () => {
	const search = summarizeShellCommand("rg -n adapter pi-codex-conversion");
	assert.equal(search.maskAsExplored, true);
	assert.deepEqual(search.actions, [{ kind: "search", command: "rg -n adapter pi-codex-conversion", query: "adapter", path: "pi-codex-conversion" }]);

	const run = summarizeShellCommand("npm test");
	assert.equal(run.maskAsExplored, false);
	assert.deepEqual(run.actions, [{ kind: "run", command: "npm test" }]);
});

test("matches more codex parser scenarios", () => {
	assert.deepEqual(summarizeShellCommand("git status").actions, [{ kind: "run", command: "git status" }]);
	assert.deepEqual(summarizeShellCommand("git grep TODO src").actions, [{ kind: "search", command: "git grep TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("git ls-files src").actions, [{ kind: "list", command: "git ls-files src", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("git status | wc -l").actions, [{ kind: "run", command: "git status | wc -l" }]);
	assert.deepEqual(summarizeShellCommand("bash -lc 'rg --files webview/src | sed -n'").actions, [{ kind: "list", command: "rg --files webview/src", path: "webview" }]);
	assert.deepEqual(summarizeShellCommand("bash -lc 'rg --files | head -n 50'").actions, [{ kind: "list", command: "rg --files", path: undefined }]);
	assert.deepEqual(summarizeShellCommand("rg --files-with-matches TODO src").actions, [{ kind: "search", command: "rg --files-with-matches TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("rg --files-without-match TODO src").actions, [{ kind: "search", command: "rg --files-without-match TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("grep --files-with-matches TODO src").actions, [{ kind: "search", command: "grep --files-with-matches TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("grep --files-without-match TODO src").actions, [{ kind: "search", command: "grep --files-without-match TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("rga -l TODO src").actions, [{ kind: "search", command: "rga -l TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("ag TODO src").actions, [{ kind: "search", command: "ag TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("ack TODO src").actions, [{ kind: "search", command: "ack TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("pt TODO src").actions, [{ kind: "search", command: "pt TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("cd -- -weird && cat foo.txt").actions, [{ kind: "read", command: "cat foo.txt", name: "foo.txt", path: "-weird/foo.txt" }]);
	assert.deepEqual(summarizeShellCommand("cd dir1 dir2 && cat foo.txt").actions, [{ kind: "read", command: "cat foo.txt", name: "foo.txt", path: "dir2/foo.txt" }]);
	assert.deepEqual(summarizeShellCommand("eza --color=always src").actions, [{ kind: "list", command: "eza --color=always src", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("exa -I target .").actions, [{ kind: "list", command: "exa -I target .", path: "." }]);
	assert.deepEqual(summarizeShellCommand("tree -L 2 src").actions, [{ kind: "list", command: "tree -L 2 src", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("du -d 2 .").actions, [{ kind: "list", command: "du -d 2 .", path: "." }]);
	assert.deepEqual(summarizeShellCommand("less -p TODO README.md").actions, [{ kind: "read", command: "less -p TODO README.md", name: "README.md", path: "README.md" }]);
	assert.deepEqual(summarizeShellCommand("more README.md").actions, [{ kind: "read", command: "more README.md", name: "README.md", path: "README.md" }]);
	assert.deepEqual(summarizeShellCommand("grep -R TODO src").actions, [{ kind: "search", command: "grep -R TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("grep -R 'foo/bar' -n .").actions, [{ kind: "search", command: "grep -R foo/bar -n .", query: "foo/bar", path: "." }]);
	assert.deepEqual(summarizeShellCommand("ls --time-style=long-iso ./dist").actions, [{ kind: "list", command: "ls --time-style=long-iso ./dist", path: "." }]);
});

test("matches additional upstream parity scenarios", () => {
	assert.deepEqual(summarizeShellCommand(`bash -lc 'rg -n "navigate-to-route" -S'`).actions, [
		{ kind: "search", command: "rg -n navigate-to-route -S", query: "navigate-to-route", path: undefined },
	]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'rg -n "BUG|FIXME|TODO|XXX|HACK" -S | head -n 200'`).actions, [
		{ kind: "search", command: "rg -n 'BUG|FIXME|TODO|XXX|HACK' -S", query: "BUG|FIXME|TODO|XXX|HACK", path: undefined },
	]);
	assert.deepEqual(summarizeShellCommand("zsh -lc 'cat README.md'").actions, [
		{ kind: "read", command: "cat README.md", name: "README.md", path: "README.md" },
	]);
	assert.deepEqual(summarizeShellCommand("head Cargo.toml").actions, [{ kind: "read", command: "head Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" }]);
	assert.deepEqual(summarizeShellCommand("tail -n 30 README.md").actions, [{ kind: "read", command: "tail -n 30 README.md", name: "README.md", path: "README.md" }]);
	assert.deepEqual(summarizeShellCommand("tail README.md").actions, [{ kind: "read", command: "tail README.md", name: "README.md", path: "README.md" }]);
	assert.deepEqual(summarizeShellCommand("npm run build").actions, [{ kind: "run", command: "npm run build" }]);
	assert.deepEqual(summarizeShellCommand("egrep -R TODO src").actions, [{ kind: "search", command: "egrep -R TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("fgrep -l TODO src").actions, [{ kind: "search", command: "fgrep -l TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("grep -L TODO src").actions, [{ kind: "search", command: "grep -L TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand("grep -R COD`EX_SANDBOX -n").actions, [{ kind: "search", command: "grep -R 'COD`EX_SANDBOX' -n", query: "COD`EX_SANDBOX", path: undefined }]);
	assert.deepEqual(summarizeShellCommand("true && rg --files").actions, [{ kind: "list", command: "rg --files", path: undefined }]);
	assert.deepEqual(summarizeShellCommand("rg --files && true").actions, [{ kind: "list", command: "rg --files", path: undefined }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'tail -n+10 README.md'`).actions, [{ kind: "read", command: "tail -n+10 README.md", name: "README.md", path: "README.md" }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'rg --files | head -n 1'`).actions, [{ kind: "list", command: "rg --files", path: undefined }]);
	assert.deepEqual(summarizeShellCommand(String.raw`cat "pkg\src\main.rs"`).actions, [{ kind: "read", command: String.raw`cat 'pkg\src\main.rs'`, name: "main.rs", path: String.raw`pkg\src\main.rs` }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'echo foo > bar'`).actions, [{ kind: "run", command: "echo foo > bar" }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'rg --version && node -v && pnpm -v && rg --files | wc -l && rg --files | head -n 40'`).actions, [{ kind: "run", command: "rg --version && node -v && pnpm -v && rg --files | wc -l && rg --files | head -n 40" }]);
	assert.deepEqual(summarizeShellCommand(`rg -l QkBindingController presentation/src/main/java | xargs perl -pi -e 's/QkBindingController/QkController/g'`).actions, [{ kind: "run", command: `rg -l QkBindingController presentation/src/main/java | xargs perl -pi -e s/QkBindingController/QkController/g` }]);
	assert.deepEqual(summarizeShellCommand(`rg --files | nl -ba | foo`).actions, [{ kind: "run", command: "rg --files | nl -ba | foo" }]);
	assert.deepEqual(summarizeShellCommand(`sed -n '260,640p' exec/src/event_processor_with_human_output.rs | nl -ba`).actions, [{ kind: "read", command: "sed -n 260,640p exec/src/event_processor_with_human_output.rs", name: "event_processor_with_human_output.rs", path: "exec/src/event_processor_with_human_output.rs" }]);
	assert.deepEqual(summarizeShellCommand(`yes | rg -n 'foo bar' -S`).actions, [{ kind: "search", command: `rg -n 'foo bar' -S`, query: "foo bar", path: undefined }]);
	assert.deepEqual(summarizeShellCommand(`ls -I '*.test.js'`).actions, [{ kind: "list", command: `ls -I '*.test.js'`, path: undefined }]);
	assert.deepEqual(summarizeShellCommand(`/usr/local/bin/powershell.exe -Command 'Write-Host hi'`).actions, [{ kind: "run", command: "Write-Host hi" }]);
});

test("matches formatting-helper classification", () => {
	for (const command of ["wc -l", "tr -d x", "cut -d : -f 1", "sort", "uniq", "tee out", "column", "yes", "printf hello"]) {
		assert.equal(isSmallFormattingCommand(command.split(" ")), true, command);
	}
	assert.equal(isSmallFormattingCommand(["awk", "{print $1}"]), true);
	assert.equal(isSmallFormattingCommand(["awk", "{print $1}", "Cargo.toml"]), false);
	assert.equal(isSmallFormattingCommand(["head", "-n", "40"]), true);
	assert.equal(isSmallFormattingCommand(["head", "-n", "40", "file.txt"]), false);
	assert.equal(isSmallFormattingCommand(["tail", "-n", "+10"]), true);
	assert.equal(isSmallFormattingCommand(["tail", "-n", "+10", "file.txt"]), false);
	assert.equal(isSmallFormattingCommand(["sed", "-n", "12,20p", "Cargo.toml"]), false);
	assert.equal(isSmallFormattingCommand(["sed", "-n"]), true);
});

test("covers remaining upstream parser edge cases", () => {
	assert.deepEqual(summarizeShellCommand(`bash -lc 'cd /Users/pakrym/code/codex && rg -n "codex_api" codex-rs -S | head -n 50'`).actions, [
		{ kind: "search", command: "rg -n codex_api codex-rs -S", query: "codex_api", path: "codex-rs" },
	]);
	assert.deepEqual(summarizeShellCommand(`rg -n 'foo bar' -S`).actions, [{ kind: "search", command: `rg -n 'foo bar' -S`, query: "foo bar", path: undefined }]);
	assert.deepEqual(summarizeShellCommand(`grep -R src/main.rs -n .`).actions, [{ kind: "search", command: "grep -R src/main.rs -n .", query: "src/main.rs", path: "." }]);
	assert.deepEqual(summarizeShellCommand(`ag -l TODO src`).actions, [{ kind: "search", command: "ag -l TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand(`ack -l TODO src`).actions, [{ kind: "search", command: "ack -l TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand(`pt -l TODO src`).actions, [{ kind: "search", command: "pt -l TODO src", query: "TODO", path: "src" }]);
	assert.deepEqual(summarizeShellCommand(`head -n50 Cargo.toml`).actions, [{ kind: "read", command: "head -n50 Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'head -n50 Cargo.toml'`).actions, [{ kind: "read", command: "head -n50 Cargo.toml", name: "Cargo.toml", path: "Cargo.toml" }]);
	assert.deepEqual(summarizeShellCommand(`rg --files | head -n 1`).actions, [{ kind: "list", command: "rg --files", path: undefined }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'tail -n+10 README.md'`).actions, [{ kind: "read", command: "tail -n+10 README.md", name: "README.md", path: "README.md" }]);
	assert.deepEqual(summarizeShellCommand(`pwsh -NoProfile -c 'Write-Host hi'`).actions, [{ kind: "run", command: "Write-Host hi" }]);
	assert.equal(isSmallFormattingCommand([]), false);
});

test("ports bash tree-sitter plain-command parsing", () => {
	assert.equal(hasBashAstSupport(), true);
	assert.deepEqual(parseShellLcPlainCommands(["bash", "-lc", "ls && pwd; echo 'hi there' | wc -l"]), [
		["ls"],
		["pwd"],
		["echo", "hi there"],
		["wc", "-l"],
	]);
	assert.deepEqual(parseShellLcPlainCommands(["bash", "-lc", `echo "/usr"'/'"local"/bin`]), [["echo", "/usr/local/bin"]]);
	assert.deepEqual(parseShellLcPlainCommands(["bash", "-lc", `rg -n "foo" -g"*.py" src`]), [["rg", "-n", "foo", "-g*.py", "src"]]);
	assert.equal(parseShellLcPlainCommands(["bash", "-lc", `echo "$HOME"`]), undefined);
	assert.equal(parseShellLcPlainCommands(["bash", "-lc", "ls > out.txt"]), undefined);
	assert.equal(parseShellLcPlainCommands(["bash", "-lc", "FOO=bar ls"]), undefined);
	assert.equal(parseShellLcPlainCommands(["bash", "-lc", "ls || (pwd && echo hi)"]), undefined);
});

test("uses bash AST rejection to avoid false explored summaries", () => {
	assert.deepEqual(summarizeShellCommand(`bash -lc 'ls > out.txt'`).actions, [{ kind: "run", command: "ls > out.txt" }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'FOO=bar rg --files'`).actions, [{ kind: "run", command: "FOO=bar rg --files" }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'echo "$HOME" && rg --files'`).actions, [{ kind: "run", command: `echo "$HOME" && rg --files` }]);
	assert.deepEqual(summarizeShellCommand(`bash -lc 'ls || (pwd && echo hi)'`).actions, [{ kind: "run", command: "ls || (pwd && echo hi)" }]);
});
