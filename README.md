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

The extension resolves the language server in this order:

1. `lsp.kedi-lsp.binary.path`
2. Workspace-local `.venv/bin/kedi-lsp` or `venv/bin/kedi-lsp` (Windows
   `Scripts/kedi-lsp.exe` is also checked)
3. `kedi-lsp` on `PATH`
4. `python -m kedi.lsp.server` as a fallback

The embedded-Python proxy auto-installs `pyright` through Zed's npm package support and runs it behind a Kedi-aware LSP proxy.
For scope-aware Python interop, it reuses the Python interpreter from the configured `kedi-lsp` script when possible, so the virtualizer imports the same installed `kedi` package as the main language server.

### Process capability scope

`extension.toml` requests `process:exec` with `command = "*"` because the extension
does not launch one fixed binary. It can start a user-configured
`lsp.kedi-lsp.binary.path`, a workspace-local `kedi-lsp`, a `kedi-lsp` found on
`PATH`, a `python` fallback for `python -m kedi.lsp.server`, and Zed's Node
binary for the embedded-Python proxy.
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
    },
    "Python": {
      "semantic_tokens": "combined"
    }
  }
}
```

Language server override example:

```json
{
  "lsp": {
    "kedi-lsp": {
      "binary": {
        "path": "/opt/homebrew/bin/python3.11",
        "arguments": ["-m", "kedi.lsp.server"]
      }
    }
  }
}
```

Embedded Python regions are injected as Python for syntax highlighting. Use `semantic_tokens: "combined"` for Kedi if you want Kedi tree-sitter highlighting plus LSP semantic tokens together. Use it for Python too if you want Kedi semantic tokens inside Python `kedi` docstrings.
