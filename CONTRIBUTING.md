# Contributing

Read `docs/KEDI_DSL.md` before changing language support. It is a mirror of
the Kedi repository's DSL reference and must stay identical to it.

## Dev Extension

1. Install Rust through `rustup`. A Homebrew-only `cargo`/`rustc` cannot build
   Zed extensions. `rust-toolchain.toml` declares the `wasm32-wasip2` target.
2. In Zed, open **Zed > Extensions**, choose **Install Dev Extension** and
   select this directory (not the `tree-sitter-kedi` grammar repository).
3. Open a `.kedi` file.

Zed builds the extension and the grammar pinned in `extension.toml`. It leaves
ignored build outputs such as `extension.wasm` and `grammars/`. Rebuild the dev
extension after source or grammar pin changes: Cargo builds alone don't update
the installed `extension.wasm` or `grammars/kedi.wasm`.

## Checks

```sh
cargo test --locked
RUSTC="$(rustup which rustc)" cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --release --target wasm32-wasip2
node --test embedded-python-proxy/*.test.mjs
```

These cover host-Python configuration, debugger registration, launch schema
conversion, stdio descriptors, missing-package hints and the embedded-Python
proxy. A raw `wasm32-wasip1` module cannot be loaded as `extension.wasm`. The
explicit `RUSTC` lets Clippy use rustup's compiler instead of the repository's
compiler-selection wrapper (`scripts/rustup-rustc`).

For a manual debugger check, install the dev extension, open
`examples/debug.kedi`, launch it, break on `> show:`, inspect `message` and the
procedure stack, step, continue and stop. It makes no provider calls.

## Managed Runtime

`runtime/bootstrap.cjs` is generated from `kedi-vscode/runtime/bootstrap.js`.
Don't edit it: update it with the parent Kedi checkout's
`scripts/sync_editor_runtime.mjs`. The Rust build embeds it in the WebAssembly
component.

## Releasing

1. The runtime pins (`kedi`, `tree-sitter-kedi`, `kedi-debugger`) must be on
   PyPI, and the Kedi wheel must contain the debugger hooks
   (`kedi.debugging.DebugEvent`, `observe_execution`). Version metadata alone is
   not enough; older releases are not a compatible fallback.
2. Bump `version` in `extension.toml` and `Cargo.toml` together.
3. Open a pull request on
   [zed-industries/extensions](https://github.com/zed-industries/extensions)
   that points the `extensions/kedi` submodule at the release commit and
   updates the version in `extensions.toml`.
