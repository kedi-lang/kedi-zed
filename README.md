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
3.12 and installs `kedi==0.4.0`, `tree-sitter-kedi==0.4.1`,
`kedi-debugger==0.1.0`, and their dependencies.
An absolute `KEDI_HOME` overrides `~/.kedi`. Subsequent starts validate and reuse
the existing environment without reinstalling; interrupted setups can be retried.

Resolution order:

1. Explicit `lsp.kedi-lsp.binary.path` (advanced override).
2. Explicit `lsp.kedi-lsp.settings.python_path` (host Python).
3. The shared managed environment.

Host environments must already have Kedi installed. They are never modified.
The extension does not silently pick a workspace executable or Python on PATH.

The embedded-Python proxy auto-installs `pyright` through Zed's npm package support
and runs it behind a Kedi-aware LSP proxy. Subsequent starts reuse the installed
backend without querying the registry, so an npm outage or certificate failure
does not disable an existing installation. Set
`lsp.kedi-embedded-python.settings.package_version` to select or update to a
specific version. First installation and explicit version changes still require
working certificate validation; the extension never disables TLS checks.
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

Embedded Python completion uses Pyright and the Kedi virtualizer. It preserves
snippets, resolves suggestions lazily, and projects additional edits back into
Kedi. Auto-imports go into the module's Python prelude, not a synthetic helper
scope. Stale suggestions and edits that cannot be safely mapped are rejected.
This requires a Kedi environment containing the completion projection API.

Directive suggestions describe their purpose and preserve `>`. Colons and
backtick delimiters do not trigger Kedi completion. Backticks are not paired
automatically; the explicit `pyblock` snippet remains available for a Python
fence scaffold.

Native input substitutions also complete visible captures, raw-invoke outputs,
procedure names, parameters, outer-scope values, and Python bindings without
executing the program. Incomplete input substitutions and backtick expressions
retain the surrounding scope. Inside Python, Pyright supplies attribute and
method suggestions using the same selected interpreter and generated Kedi stubs.

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

## Debugging

The extension registers the `kedi` debug adapter through Zed extension API
`0.7.0`, including the new-process modal and a launch configuration schema.
Explicitly trust the worktree before debugging. Add `.zed/debug.json`:

```json
[
  {
    "adapter": "kedi",
    "label": "Kedi: Current File",
    "request": "launch",
    "program": "$ZED_FILE",
    "cwd": "$ZED_WORKTREE_ROOT",
    "args": [],
    "env": {},
    "stopOnEntry": true
  }
]
```

Save the active `.kedi` file, then run **debugger: start** and select the task.
The new-process modal can also create a Kedi launch. The program must resolve
to an absolute saved `.kedi` path; `cwd` defaults to the worktree root. Zed
substitutes its task variables before sending the launch to the backend.

Debugging reuses the language services' Python selection: explicit
`lsp.kedi-lsp.settings.python_path`, the interpreter identified by an advanced
server executable/shebang, or the shared `~/.kedi/editor-venv`. This Python runs
`-m kedi_debugger --stdio` and owns the debuggee's project dependencies. It is
resolved again for each session; changing Zed's terminal Python toolchain alone
does not change Kedi. TCP, custom DAP binary overrides, and attach are rejected;
configure `python_path` to select another interpreter.
Only recognizable Python executable names or direct Python shebangs (including
`/usr/bin/env python3` and `/usr/bin/env -S python3 ...`) are inferred. Shell
wrappers, unrelated Python tools, and shebangs that change the environment require
an explicit `python_path`; they are not run as Python.

Managed mode installs `kedi-debugger` automatically alongside Kedi. Existing
managed environments are upgraded under the same lock shared with VS Code;
subsequent starts verify and reuse the complete installation.

An explicitly selected host environment is never modified. Install the debugger
there yourself. Until the matching releases are published, use the local source
packages:

```sh
uv pip install --python /absolute/path/to/selected/python -e /path/to/kedi -e /path/to/kedi/debugger
```

Managed Python is `~/.kedi/editor-venv/bin/python` (Windows:
`~/.kedi/editor-venv/Scripts/python.exe`), adjusted for `KEDI_HOME`. It also needs
a compatible local Kedi runtime and your project/provider dependencies; select
a prepared project Python when appropriate. Preflight imports `kedi_debugger`
and the required `DebugEvent` / `observe_execution` symbols from `kedi.debugging`;
an importable module without those hooks is not sufficient.
Missing/incompatible-package errors identify the selected Python
and give the local install command. The LSP remains independent
of this optional package in host mode. Managed setup includes both packages.

`args` is a string array; `env` maps names to strings or `null` for the debuggee.
A `null` value removes an inherited environment variable; an empty string sets
it to empty. Use `.zed/debug.json` for removals; the generic new-process modal's
environment API supplies string values only.
Environment names must be nonempty and contain neither `=` nor NUL; paths,
arguments and environment values cannot contain NUL. Interpreter overrides
(`python`, `pythonPath`, `interpreter`, `pythonExecutable`) in launch arguments
are rejected; use `lsp.kedi-lsp.settings.python_path` instead.
Optional `model` selects the Kedi model. Use `kediAdapter` for a model-adapter
override (for example `"kediAdapter": "pydantic"`): Zed reserves `adapter` for
the debugger name, so the extension maps `kediAdapter` to the backend's
`adapter` launch field. Entry stop defaults to true and can be disabled.

The backend feeds Zed's native source breakpoints, stack, scopes/variables,
stepping, pause/continue, and stop controls. There is no custom inspector or
expression engine. Arbitrary evaluation, mutation, attach, conditional/function
breakpoints, reverse stepping, and Python-internal stepping are unsupported.
Pause is cooperative; already-running model/tool work and external deadlines
may continue. Save changes and restart rather than expecting hot reload.
The backend exposes native exception-breakpoint filters for raised Kedi
exceptions, model input ready, and model result ready (`exceptions`,
`model_input`, `model_result`).

UI/API limitations: API 0.7.0 exposes neither a worktree-trust query nor an
unsaved-buffer save hook to this extension. Trust the project and save sources
before launch; Kedi executes on-disk files. Zed may still show unsupported
breakpoint/evaluation actions, which the backend rejects. Native UI can clear
variables at termination; no persistent post-run inspector is added.

Do not commit secrets in debug configurations or enable DAP communication logs
for sensitive runs. The extension does not log payloads or interpreter-probe
output; model prompts and results can still contain sensitive application data.

API references: [Zed debugger extensions](https://zed.dev/docs/extensions/debugger-extensions),
[debug configuration](https://zed.dev/docs/debugger), and
[worktree trust](https://zed.dev/docs/worktree-trust).
In a parent Kedi source checkout, `debugger/README.md` describes backend controls
and inspection boundaries; `debugger/src/kedi_debugger/server.py` is the
authoritative launch validation and environment-merge contract. This extension
validates literal inputs first; the backend checks the substituted paths and
whether the program and working directory exist.

## Runtime Development and Release

`runtime/bootstrap.cjs` is the bundled installer from `kedi-vscode/runtime/bootstrap.js`.
Update it with the parent checkout's `scripts/sync_editor_runtime.mjs`; do not
edit generated code. `cargo test` checks host-Python configuration and
`cargo build --release --target wasm32-wasip1` embeds the installer in the extension.

Run `cargo test --locked`,
`RUSTC="$(rustup which rustc)" cargo clippy --locked --all-targets -- -D warnings`,
and `cargo build --locked --release --target wasm32-wasip1` for debugger
registration, schema/launch conversion, stdio descriptors and missing-package
hints. Existing proxy checks use `node --test embedded-python-proxy/*.test.mjs`.
For native UI verification, install the dev extension, open `examples/debug.kedi`,
launch the task above, break on `> show:`, inspect `message` and the procedure
stack, step, continue, and stop. The fixture performs no provider calls.
The explicit `RUSTC` lets Clippy use rustup's compiler directly instead of the
repository's compiler-selection shell wrapper.

The pinned `kedi==0.4.0`, `tree-sitter-kedi==0.4.1`, and `kedi-debugger==0.1.0`
packages must be available from PyPI before this extension is released. Verify
that the Kedi wheel contains the required debugger hooks, not only its version.
If that Kedi version was published without them, publish a new version and
update the runtime pin first. Older releases are not a compatible fallback. This is a
release prerequisite, not something users should resolve with a private GitHub token.
