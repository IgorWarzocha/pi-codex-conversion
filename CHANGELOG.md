# Changelog

## 1.5.9

- Fixed native Responses compaction replay when provider payloads include in-flight tail items that are not yet persisted in the session branch.

## 1.5.8

- Fixed native Responses compaction replay after compaction display messages so requests replace Pi placeholder compaction context with the native compacted window instead of failing parity checks.

## 1.5.7

- Fixed OpenAI Codex custom-provider requests so synthetic `web.run` and `image_generation` adapter tools are rewritten to native Responses tool payloads before sending.
- Fixed subagent and other RPC/no-session Codex runs failing with invalid function tool names when native web search is active.

## 1.5.6

- Added Compaction and Overrides tabs to `/codex`.
- Added optional native Responses compaction for Codex sessions, with settings for compaction model and reasoning.
- Added an `apply_patch`-only override mode for GPT/Codex models. This mode bypasses most of this extension, but still gives you the `apply_patch` tool.
- Renamed the native Codex web search tool from `web_search` to responses-native `web.run`, allowing compatibility with other extensions.
- Synced the custom OpenAI Codex provider and Pi development dependencies with Pi `0.75.3`.

## 1.5.5

- Avoid registering disabled native `web_search` and `image_generation` tools so other extensions can own those names.
- Preserve other extensions' `web_search` and `image_generation` tools when the matching Codex feature is off.
- Added a `/codex status` toggle and settings UI option for hiding the Codex footer/statusline.

## 1.5.4

- Added `/codex` settings UI.
- Added saved global config at `~/.pi/agent/pi-codex-conversion.json`.
- Added toggles for fast mode, native web search, native image generation, and using the adapter on all models.
- Added verbosity control for Responses API providers.
- Added footer status details for active Codex settings.
- Added quick links from the settings UI to GitHub, Discord, and issue filing.
- Updated Pi development dependencies to 0.74.1.

## 1.5.3

- Improved exploration output for skill reads so `SKILL.md` activity is easier to understand.

## 1.5.2

- Streamed partial `exec_command` updates while commands are still running.
- Improved background terminal responsiveness and display state.

## 1.5.1

- Cleaned up the Codex adapter prompt and tool surface.
- Fixed skill prompt injection after reload.
- Fixed adapter tool restore behavior when switching models.
- Simplified tool descriptions and README wording.
- Bundled `apply_patch` and moved publishing to GitHub Actions.

## 1.5.0

- Aligned the Codex provider with Pi 0.73 and Pi 0.74 package/API changes.
- Updated package scope for the Earendil Pi packages.
- Removed a noisy web search startup note.

## 1.0.29

- Aligned with Pi 0.72.
- Fixed cached websocket transport behavior.
- Fixed thinking-level mapping and runtime compatibility issues.

## 1.0.28

- Aligned with Pi 0.70.5 Codex provider changes.

## 1.0.27

- Marked Codex websocket failures as retryable connection errors.

## 1.0.26

- Retried stale Codex websocket reuse.

## 1.0.25

- Sanitized Codex image generation history before sending follow-up requests.

## 1.0.24

- Updated the adapter for Pi 0.70 compatibility.
- Fixed Codex websocket close race handling.

## 1.0.23

- Hotfix to remove a stale Codex max token field.

## 1.0.22

- Hotfix to omit unsupported Codex max output tokens.

## 1.0.21

- Hardened Codex provider streaming and image handling.
- Preserved Codex image generation calls in conversation history.
- Aligned websocket client behavior with Pi's Codex provider.
- Future-proofed GPT-5 reasoning effort clamping.

## 1.0.20

- Updated for Pi 0.69 typebox changes.
- Replicated Pi Codex websocket transport handling.
- Fixed Codex SSE parsing, websocket auth, stream indexing, and websocket caching.
- Moved image path guidance into prompt/tool text.
- Hardened runtime behavior and activity ordering.

## 1.0.19

- Added native Codex web search and image generation support.
- Fixed Codex custom provider packaging and session handling.
- Restored Pi's default shell renderer for `apply_patch`.

## 1.0.18

- Aligned the extension with Pi 0.67.3 APIs.
- Fixed `prepareArguments` validation regressions.

## 1.0.17

- Improved `apply_patch` fuzzy matching safety.
- Continued applying independent patch actions after file failures.
- Blocked dependent patch actions after earlier failures.
- Tightened delete matching and path canonicalization.
- Improved section-anchor matching and partial move failure reporting.

## 1.0.12

- Added structured `apply_patch` recovery hints.
- Improved `apply_patch` failure rendering.
- Capped exec session buffers at 256 MiB.

## 1.0.11

- Hotfix to show `apply_patch` failures after arguments complete.
- Hotfix to hide incomplete `apply_patch` previews.

## 1.0.10

- Rendered partial `apply_patch` failures inline.
- Added PTY polling guardrails for `write_stdin`.
- Clamped tiny `exec_command` waits for non-interactive runs.
- Clarified `write_stdin` polling behavior in the README.

## 1.0.9

- Initial public release of the Codex-style Pi adapter.
- Added Codex-style shell tools, resumable exec sessions, patch editing, and tool rendering.
- Forced bash when Pi is launched under fish while preserving fish-derived `PATH`.
