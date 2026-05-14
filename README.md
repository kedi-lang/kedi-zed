# Kedi for Zed

Kedi language support for Zed with:

- a local `tree-sitter-kedi` grammar
- query files for highlighting, outline, bracket matching, indentation, and Python injection
- `kedi-lsp` integration for diagnostics, formatting, rename, references, hover, document symbols, signature help, and inlay hints
- an embedded-Python proxy language server for Python hover, definition, and references inside Kedi backtick / fenced Python regions
- language snippets for common Kedi forms

The extension resolves the language server in this order:

1. `lsp.kedi-lsp.binary.path`
2. `kedi-lsp` on `PATH`
3. `python3 -m kedi.lsp.server`
4. `python -m kedi.lsp.server`

The embedded-Python proxy auto-installs `pyright` through Zed's npm package support and runs it behind a Kedi-aware LSP proxy.

For normal extension installs from Zed's extension registry, users download the packaged extension and do not need Rust installed.

For local dev-extension installs, Zed compiles the extension on the local machine and requires Rust to be installed via `rustup`. A Homebrew-only `cargo` / `rustc` setup will fail to compile Rust extensions during `Install Dev Extension`. This repository declares the required `wasm32-wasip1` target in `rust-toolchain.toml` for `rustup` users.

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

Embedded Python regions are injected as Python for syntax highlighting. Use `semantic_tokens: "combined"` if you want Kedi tree-sitter highlighting plus LSP semantic tokens together.
