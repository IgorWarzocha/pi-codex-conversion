# pi-codex-conversion

Codex-oriented adapter for [Pi](https://github.com/badlogic/pi-mono).

This package replaces Pi's default Codex/GPT experience with a narrower Codex-like surface while staying close to Pi's own runtime and prompt construction:

- swaps active tools to `exec_command`, `write_stdin`, `apply_patch`, and `view_image`
- preserves Pi's composed system prompt and applies a narrow Codex-oriented delta on top
- renders exec activity with Codex-style command and background-terminal labels

![Available tools](./available-tools.png)

## Active tools in adapter mode

When the adapter is active, the LLM sees these tools:

- `exec_command` — shell execution with Codex-style `cmd` parameters and resumable sessions
- `write_stdin` — continue or poll a running exec session
- `apply_patch` — patch tool
- `view_image` — image-only wrapper around Pi's native image reading, enabled only for image-capable models

Notably:

- there is **no** dedicated `read`, `edit`, or `write` tool in adapter mode
- local text-file inspection should happen through `exec_command`
- file creation and edits should default to `apply_patch`
- Pi may still expose additional runtime tools such as `parallel`; the prompt is written to tolerate that instead of assuming a fixed four-tool universe

## Layout

- `src/index.ts` — extension entrypoint, model gating, tool-set swapping, prompt transformation
- `src/adapter/` — model detection and active-tool constants
- `src/tools/` — Pi tool wrappers, exec session management, and execution rendering
- `src/shell/` — shell tokenization, parsing, and exploration summaries
- `src/patch/` — patch parsing, path policy, and execution
- `src/prompt/` — Codex delta transformer over Pi's composed prompt
- `tests/` — deterministic unit tests

## Checks

```bash
npm run typecheck
npm test
npm run check
```

## Examples

- `rg -n foo src` -> `Explored / Search foo in src`
- `rg --files src | head -n 50` -> `Explored / List src`
- `cat README.md` -> `Explored / Read README.md`
- `exec_command({ cmd: "npm test", yield_time_ms: 1000 })` may return `session_id`, then continue with `write_stdin`
- `write_stdin({ session_id, chars: "" })` renders like `Waited for background terminal`
- `write_stdin({ session_id, chars: "y\\n" })` renders like `Interacted with background terminal`
- `view_image({ path: "/absolute/path/to/screenshot.png" })` is available on image-capable models

Raw command output is still available by expanding the tool result.

## Install

```bash
pi install ./pi-codex-conversion
```

From GitHub:

```bash
pi install git:github.com/IgorWarzocha/pi-codex-conversion
```

## Prompt behavior

The adapter does not build a standalone replacement prompt anymore. Instead it:

- keeps Pi's tool descriptions, Pi docs section, AGENTS/project context, skills inventory, and date/cwd when Pi already surfaced them
- rewrites the top-level role framing to Codex-style wording
- adds a small Codex delta to the existing `Guidelines` section

That keeps the prompt much closer to `pi-mono` while still steering the model toward Codex-style tool use.

## Notes

- Adapter mode activates automatically for OpenAI `gpt*` and `codex*` models.
- When you switch away from those models, Pi restores the previous active tool set.
- `view_image` resolves paths against the active session cwd and only exposes `detail: "original"` for Codex-family image-capable models.
- `apply_patch` paths stay restricted to the current working directory.
- `exec_command` / `write_stdin` use a custom PTY-backed session manager via `node-pty` for interactive sessions.
- PTY output handling applies basic terminal rewrite semantics (`\r`, `\b`, erase-in-line, and common escape cleanup) so interactive redraws replay sensibly.
- Skills inventory is reintroduced in a Codex-style section when Pi's composed prompt already exposed the underlying Pi skills inventory.

## License

MIT
