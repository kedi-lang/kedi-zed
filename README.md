# Kedi for Zed

Kedi language support for Zed with:

- the canonical `tree-sitter-kedi` grammar from the grammar repository
- query files for highlighting, outline, bracket matching, indentation, and Python injection
- `kedi-lsp` integration for diagnostics, formatting, rename, references, hover, document symbols, signature help, and inlay hints
- an embedded-Python proxy language server for Python hover, definition, and references inside Kedi backtick / fenced Python regions
- language snippets for common Kedi forms

## Installation

### From Zed's extension registry

1. Open Zed.
2. Go to `Zed > Extensions`.
3. Search for `Kedi`.
4. Select the `Kedi` extension and click `Install`.
5. Open a `.kedi` file.

The extension grammar is pulled from `https://github.com/kedi-lang/tree-sitter-kedi` at the revision declared in `extension.toml`.

### Local dev extension

1. Clone or open this repository locally.
2. Open Zed.
3. Go to `Zed > Extensions`.
4. Choose `Install Dev Extension`.
5. Select the `kedi-zed` directory.
6. Open a `.kedi` file.

Select the Zed extension directory (`kedi-zed`), not the `tree-sitter-kedi` grammar repository. Zed reads `extension.toml`, downloads/builds the grammar from the configured repository, and starts the Kedi language servers from this extension.

At first language-server activation, the extension automatically prepares
`~/.kedi/editor-venv`. This is the same environment and installation lock used
by the Kedi VS Code extension, not a second Zed-specific environment. No host
Python installation is needed: a checksum-verified uv 0.11.21 downloads Python
3.12 and installs `kedi==0.4.0`, `tree-sitter-kedi==0.4.0`, and their dependencies.
An absolute `KEDI_HOME` overrides `~/.kedi`. Subsequent starts validate and reuse
the existing environment without reinstalling; interrupted setups can be retried.

Resolution order:

1. Explicit `lsp.kedi-lsp.binary.path` (advanced override).
2. Explicit `lsp.kedi-lsp.settings.python_path` (host Python).
3. The shared managed environment.

Host environments must already have Kedi installed. They are never modified.
The extension does not silently pick a workspace executable or Python on PATH.

The embedded-Python proxy auto-installs `pyright` through Zed's npm package support and runs it behind a Kedi-aware LSP proxy.
The Kedi server, Python-docstring server, and embedded-Python virtualizer use
the same managed or selected host interpreter. For a custom server wrapper,
set `python_path` explicitly if its Python cannot be inferred from its shebang.

Zed's current extension API does not expose the selected Python toolchain or
an interpreter-change callback. Configure `python_path` below and run
**editor: restart language server** after changing it. Clearing it restores
the managed default; changing Zed's terminal toolchain alone does not switch Kedi.

### Process capability scope

`extension.toml` requests `process:exec` with `command = "*"` because the extension
does not launch one fixed binary. It can start a user-configured
`lsp.kedi-lsp.binary.path`, a selected or managed Python, and Zed's Node binary
for the shared installer and embedded-Python proxy. The installer downloads
verified uv/Python releases and installs the pinned packages in the user's home.
Narrowing the manifest to one command would break valid user configurations.

Users who need a stricter local policy can restrict `process:exec` through Zed's
`granted_extension_capabilities` setting for their own environment.

For normal extension installs from Zed's extension registry, users download the packaged extension and do not need Rust installed.

For local dev-extension installs, Zed compiles the extension on the local machine and requires Rust to be installed via `rustup`. A Homebrew-only `cargo` / `rustc` setup will fail to compile Rust extensions during `Install Dev Extension`. This repository declares the required `wasm32-wasip1` target in `rust-toolchain.toml` for `rustup` users.
Zed may create ignored local build artifacts such as `extension.wasm` and `grammars/` while compiling a dev extension; those are not source files to publish.

Recommended settings:

```json
{
  "languages": {
    "Kedi": {
      "formatter": "language_server",
      "format_on_save": "on",
      "semantic_tokens": "combined"
    }
  }
}
```

Host Python example (also applies to the embedded virtualizer):

```json
{
  "lsp": {
    "kedi-lsp": {
      "settings": {
        "python_path": "/path/to/venv/bin/python"
      }
    }
  }
}
```

Embedded Python regions inside `.kedi` files are injected as Python for syntax highlighting. Use `semantic_tokens: "combined"` for Kedi if you want Kedi tree-sitter highlighting plus LSP semantic tokens together.

## Runtime Development and Release

`runtime/bootstrap.cjs` is the bundled installer from `kedi-vscode/runtime/bootstrap.js`.
Update it with the parent checkout's `scripts/sync_editor_runtime.mjs`; do not
edit generated code. `cargo test` checks host-Python configuration and
`cargo build --release --target wasm32-wasip1` embeds the installer in the extension.

Both pinned 0.4.0 Python packages must be available from PyPI before this
extension is released. Older releases are not a compatible fallback. This is a
release prerequisite, not something users should resolve with a private GitHub token.
