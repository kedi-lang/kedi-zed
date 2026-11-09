; Run buttons. tasks.json binds each tag to a `kedi` command.

; The whole file, from its first top-level item.
((source_file
  .
  (_) @run)
  (#set! tag kedi-file))

; `@test: <procedure>:` runs the file's tests.
((validation_block
  kw: (validation_keyword) @run @_kw
  procedure: (identifier) @procedure)
  (#eq? @_kw "test")
  (#set! tag kedi-test))

; `@eval: <procedure>:` runs the file's evaluations.
((validation_block
  kw: (validation_keyword) @run @_kw
  procedure: (identifier) @procedure)
  (#eq? @_kw "eval")
  (#set! tag kedi-eval))
