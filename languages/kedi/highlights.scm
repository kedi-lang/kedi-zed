(line_comment) @comment
(block_comment) @comment
(procedure_def
  body: (block
    . (block_comment) @variable))

(procedure_def
  name: (identifier) @function)

(type_def
  name: (identifier) @type)

(module_import
  module: (identifier) @namespace)

(module_export_name
  name: (identifier) @variable)

(param
  name: (identifier) @variable.parameter)

(type_field
  name: (identifier) @property)

(type_ref
  name: (identifier) @type)

(type_apply
  name: (identifier) @type)

(validation_block
  kw: (validation_keyword) @keyword
  procedure: (identifier) @function)

(test_case
  name: (identifier) @label)

(eval_data
  name: (identifier) @label)

(eval_test_data
  name: (identifier) @label)

(eval_metric
  name: (identifier) @label)

(eval_metric
  dataset: (identifier) @variable)

(optimize_directive
  name: (identifier) @label)

(input_segment
  name: (identifier) @variable)

(call_segment
  name: (identifier) @function)

(output_segment
  name: (identifier) @variable)

(text_segment) @text.literal
(python_code) @embedded
(python_inline_body) @embedded

[
  "import"
  "export"
  "auto"
  "optimize"
  "case"
  "data"
  "test_data"
  "metric"
] @keyword

[
  "="
  "->"
  "|"
] @operator

[
  "@"
  "~"
  ">"
  "```"
  "`"
] @punctuation.special

[
  "("
  ")"
  "["
  "]"
  "<"
  ">"
  ","
  ":"
] @punctuation.delimiter
