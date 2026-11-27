# Kedi for Zed

Language support for [Kedi](https://kedi-lang.org), a typed orchestration
language for LLM programs: write, run, test and debug `.kedi` files in Zed.

## Features

- **Highlighting, outline, brackets and indentation** from the
  `tree-sitter-kedi` grammar, with Python regions injected as Python.
- **Language server.** Diagnostics, completion, hover, go to definition,
  references, rename, document symbols, signature help, inlay hints and
  formatting from `kedi-lsp`.
- **Embedded Python.** Completion, hover, go to definition and references from
  Pyright inside fenced Python blocks and inline backtick expressions.
  Auto-imports go into the module's Python prelude.
- **Kedi in Python.** Kedi language features inside Python docstrings whose
  first line is `kedi`.
- **Run, test and evaluate** from gutter buttons and **task: spawn**.
- **Debugging.** Breakpoints, stepping, call stack and variables through the
  Kedi debugger.
- **Snippets** for common Kedi forms.

## Getting Started

1. Open **Zed > Extensions**, search for `Kedi` and install it.
2. Open a `.kedi` file. On the first language-server start, the extension
   prepares a Python environment under `~/.kedi/editor-venv`. A
   checksum-verified uv downloads Python 3.12 and installs `kedi==0.1.8`,
   `tree-sitter-kedi==0.4.11` and `kedi-debugger==0.1.2`. No existing Python is
   needed. This needs internet access once; later starts reuse the environment.
3. Set your model provider's API key, for example in a `.env` file, and run the
   file from its gutter button.

The environment is shared with the Kedi VS Code extension. An absolute
`KEDI_HOME` relocates it. It serves the editor only: it is not your project's
environment.

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

`semantic_tokens: "combined"` keeps tree-sitter highlighting and adds the
language server's semantic tokens.

## Choosing a Python

The managed environment pins the published Kedi release. To use a development
version of Kedi, or your project's dependencies, point the extension at a Python
where Kedi is installed:

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

Then run **editor: restart language server**. Clearing `python_path` returns to
the managed environment. Zed's selected Python toolchain does not switch Kedi:
the extension API doesn't expose it.

The extension picks the Python in this order:

1. `lsp.kedi-lsp.binary.path`, an advanced override that is the server command
   itself. A Python interpreter gets `-m kedi.lsp.server` appended; any other
   executable runs as is.
2. `lsp.kedi-lsp.settings.python_path`.
3. The managed environment.

The language helpers and the debugger use the same order. They need a Python,
so a `binary.path` that isn't one falls back to the managed environment there.
A Python you select must already have Kedi; the extension never installs into
it. It never picks a workspace executable or a Python on `PATH` by itself.

Embedded Python installs `pyright` through Zed's npm support on first use and
reuses it afterwards. Set `lsp.kedi-embedded-python.settings.package_version` to
pin a version.

## Running

A run button appears in the gutter beside the first item of a `.kedi` file and
beside each `@test:` and `@eval:` block. The same tasks are in **task: spawn**:

| Task | Command |
| --- | --- |
| `kedi: run <file>` | `kedi <file>` |
| `kedi: test <file>` | `kedi <file> --test` |
| `kedi: eval <file>` | `kedi <file> --eval` |

The tasks run in Zed's terminal from the worktree root. They use `kedi` from the
terminal's `PATH`, such as an activated project environment, and fall back to
the managed environment. On Windows, use the ` (Windows)` variants; Zed has no
per-OS task override, so both sets are listed everywhere. `--test` and `--eval`
run every block in the file. To change a command, add a task with the same tag
(`kedi-file`, `kedi-test` or `kedi-eval`) to `.zed/tasks.json`.

## Debugging

Trust the worktree, save the `.kedi` file and add a `.zed/debug.json`:

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

Then run **debugger: start**. The new-process modal can also create a Kedi
launch.

- `program` is an absolute path to a saved `.kedi` file. Kedi runs the file on
  disk, so save before launching.
- `cwd` defaults to the worktree root.
- `env` maps names to strings; `null` removes an inherited variable.
- `kediAdapter` and `model` optionally override the program's defaults. Zed
  reserves `adapter` for the debugger's name.
- `stopOnEntry` defaults to `true`.

Line breakpoints, the call stack, variables, stepping, pause, continue and stop
are supported. Exception breakpoints can stop on raised Kedi exceptions, when a
model input is ready and when a model result is ready. Attach, editing
variables, arbitrary evaluation, conditional and function breakpoints are not
supported; Zed may still offer some of them, and the debugger rejects them.
Pause is cooperative: model and tool calls already in flight finish first.

The debugger runs in the same Python as the language server. The managed
environment includes it. For a Python you selected, install it yourself:
`pip install kedi-debugger`. Keep credentials out of committed debug
configurations.

## Permissions

The extension asks for `process:exec` with any command. It starts more than one
program: the managed or selected Python, a `binary.path` you configure, and
Zed's Node for the shared installer and the embedded-Python proxy. The installer
downloads verified uv and Python releases and installs the pinned packages
under your home directory. To restrict it on your machine, use Zed's
`granted_extension_capabilities` setting.

## Troubleshooting

- **No diagnostics or completion.** Open the language server log
  (**dev: open language server logs**). A failed setup is retried on the next
  start, or with **editor: restart language server**.
- **Wrong Kedi version.** Set `python_path` to the Python where your Kedi is
  installed.

## Links

- [Documentation](https://docs.kedi-lang.org/tooling/zed/)
- [Kedi on GitHub](https://github.com/kedi-lang/kedi)
- [Report an issue](https://github.com/kedi-lang/kedi-zed/issues)
- [Contributing](CONTRIBUTING.md)
