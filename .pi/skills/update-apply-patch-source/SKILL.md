# Update bundled apply_patch source

Use this skill when refreshing the vendored Rust `apply_patch` source from the immutable local Codex checkout at `/home/igorw/Work/codex`.

## Goal

Keep CI/release self-contained. GitHub Actions builds native binaries from source committed to this repository under `vendor/apply-patch-src`; it must not clone the upstream `openai/codex` repository during package publish.

## Procedure

1. Update and validate the local Codex checkout manually if needed. Treat this path as immutable:

   ```bash
   cd /home/igorw/Work/codex
   git status --short
   git pull --ff-only
   git rev-parse HEAD
   ```

2. The sync script refuses to copy from a dirty checkout. If the checkout is clean, refresh the minimal vendored source snapshot:

   ```bash
   cd /home/igorw/Work/pi-codex-conversion/pi-codex-conversion
   npm run sync:apply-patch-source
   ```

3. Build the host-native binary from the committed snapshot, not from `/home/igorw/Work/codex`:

   ```bash
   npm run build:apply-patch
   ```

4. Validate the package:

   ```bash
   npm run check
   npm pack --dry-run --ignore-scripts
   ```

5. Inspect changed files. Expected source snapshot paths include:

   ```text
   vendor/apply-patch-src/Cargo.toml
   vendor/apply-patch-src/Cargo.lock
   vendor/apply-patch-src/UPSTREAM
   vendor/apply-patch-src/crates/codex-apply-patch/**
   vendor/apply-patch-src/crates/codex-exec-server/**
   vendor/apply-patch-src/crates/codex-utils-absolute-path/**
   ```

   Do not commit `vendor/apply-patch-src/target/`.

6. Do not run `npm publish` locally. GitHub Actions builds all platform binaries and publishes npm packages from pushes to `dev`, `main`, or `master`.

## Design notes

- `codex-apply-patch` source and `codex-utils-absolute-path` are copied from the local Codex checkout.
- `codex-exec-server` is intentionally a tiny compatibility shim that exposes only the filesystem API needed by standalone `apply_patch`; this avoids vendoring the whole Codex workspace.
- `vendor/apply-patch-src/UPSTREAM` records the exact upstream Codex commit.
