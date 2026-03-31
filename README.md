# pi-codex-conversion

Codex-oriented adapter for [Pi](https://github.com/badlogic/pi-mono).

This package replaces Pi's default Codex/GPT experience with a narrower Codex-like surface while staying close to Pi's own runtime and prompt construction:

- swaps active tools to `exec_command`, `write_stdin`, `apply_patch`, `view_image`, and native OpenAI Codex Responses `web_search` on `openai-codex`
- preserves Pi's composed system prompt and applies a narrow Codex-oriented delta on top
- renders exec activity with Codex-style command and background-terminal labels
- renders `apply_patch` calls with Codex-style `Added` / `Edited` / `Deleted` diff blocks and Pi-style colored diff lines

![Available tools](./available-tools.png)

> [!NOTE]
> Native OpenAI Codex Responses web search runs silently. Pi does not expose native web-search usage events to extensions, so the adapter shows a one-time session notice instead of per-search tool-call history.

## Active tools in adapter mode

When the adapter is active, the LLM sees these tools:

- `exec_command` — shell execution with Codex-style `cmd` parameters and resumable sessions
- `write_stdin` — continue or poll a running exec session
- `apply_patch` — patch tool
- `view_image` — image-only wrapper around Pi's native image reading, enabled only for image-capable models
- `web_search` — native OpenAI Codex Responses web search, enabled only on the `openai-codex` provider

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
- for short or non-interactive commands, omitting `yield_time_ms` is preferred; tiny non-interactive waits are clamped upward to avoid unnecessary follow-up calls
- `write_stdin({ session_id, chars: "" })` renders like `Waited for background terminal` and is meant for occasional polling, not tight repoll loops
- `write_stdin({ session_id, chars: "y\\n" })` renders like `Interacted with background terminal`
- `view_image({ path: "/absolute/path/to/screenshot.png" })` is available on image-capable models
- `web_search` is surfaced only on `openai-codex`, and the adapter rewrites it into the native OpenAI Responses `type: "web_search"` payload instead of executing a local function tool
- when native web search is available, the adapter shows a one-time session notice; individual searches are not surfaced because Pi does not expose native web-search execution events to extensions
- `apply_patch` partial failures stay inline in the patch row so successful and failed file entries can be seen together

Raw command output is still available by expanding the tool result.

## Install

```bash
pi install npm:@howaboua/pi-codex-conversion
```

Local development:

```bash
pi install ./pi-codex-conversion
```

Alternative Git install:

```bash
pi install git:github.com/IgorWarzocha/pi-codex-conversion
```

## Publishing

This package is already configured for public npm publishes via:

- `publishConfig.access = "public"`
- `prepublishOnly` / `prepack` checks

Useful commands:

```bash
npm run publish:dry-run
npm run publish:dev
npm run release:dev
```

What they do:

- `npm run publish:dry-run` — inspect what would be published
- `npm run publish:dev` — publish the current version under the `dev` dist-tag
- `npm run release:dev` — bump the package to the next `-dev.N` prerelease and publish it under the `dev` dist-tag

Typical flow:

```bash
npm login
npm run publish:dry-run
npm run release:dev
```

For modern npm auth, just run `npm login` and complete the browser flow when prompted.

After publishing, install the dev build with:

```bash
pi install npm:@howaboua/pi-codex-conversion@dev
```

## Prompt behavior

The adapter does not build a standalone replacement prompt anymore. Instead it:

- keeps Pi's tool descriptions, Pi docs section, AGENTS/project context, skills inventory, and date/cwd when Pi already surfaced them
- adds the current shell to the transformed prompt so quoting and escaping can match the runtime environment
- rewrites the top-level role framing to Codex-style wording
- adds a small Codex delta to the existing `Guidelines` section

That keeps the prompt much closer to `pi-mono` while still steering the model toward Codex-style tool use.

## Notes

- Adapter mode activates automatically for OpenAI `gpt*` and `codex*` models.
- When you switch away from those models, Pi restores the previous active tool set.
- `view_image` resolves paths against the active session cwd and only exposes `detail: "original"` for Codex-family image-capable models.
- `web_search` is exposed only for the `openai-codex` provider and is forwarded as the native OpenAI Codex Responses web search tool.
- `apply_patch` paths stay restricted to the current working directory.
- partial `apply_patch` failures stay in the original patch block and highlight the failed entry instead of adding a second warning row.
- `exec_command` / `write_stdin` use a custom PTY-backed session manager via `node-pty` for interactive sessions.
- tiny `exec_command` waits are clamped for non-interactive commands so short runs do not burn an avoidable follow-up tool call.
- empty `write_stdin` polls are clamped to a meaningful minimum wait so long-running processes are not repolled too aggressively.
- PTY output handling applies basic terminal rewrite semantics (`\r`, `\b`, erase-in-line, and common escape cleanup) so interactive redraws replay sensibly.
- Skills inventory is reintroduced in a Codex-style section when Pi's composed prompt already exposed the underlying Pi skills inventory.

## License

MIT
