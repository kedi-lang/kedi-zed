(line_comment) @comment
(block_comment) @comment

(procedure_definition
  name: (identifier) @function)

(test_definition
  name: (identifier) @function)

(eval_definition
  name: (identifier) @function)

(type_definition
  name: (identifier) @type)

(generic_type
  name: (identifier) @type)

(parameter
  name: (identifier) @variable.parameter)

(field_definition
  name: (identifier) @property)

(output_placeholder
  name: (identifier) @variable)

(case_definition
  name: (identifier) @label)

(metric_definition
  name: (identifier) @label)

(substitution) @variable
(template_text) @text.literal
(string_literal) @string
(inline_python_code) @embedded
(python_code_line) @embedded
(escape_sequence) @string.escape

[
  "@test"
  "@eval"
  "case"
  "metric"
] @keyword

[
  "="
  "->"
] @operator

[
  "@"
  "~"
  ">"
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
