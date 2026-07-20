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

(assign_target
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

(profile_directive
  name: (identifier) @label)

(use_directive
  name: (identifier) @label)

(use_tool_name
  name: (identifier) @function)

(use_tool_backtick
  name: (identifier) @function)

(mcp_field
  name: (identifier) @property)

(settings_field
  name: (identifier) @property)

(model_directive
  value: (model_plain_value) @text.literal)

(model_directive
  value: (inline_python_expr) @embedded)

(effort_directive
  value: (effort_plain_value) @text.literal)

(effort_directive
  value: (inline_python_expr) @embedded)

(approval_directive
  value: (approval_plain_value) @text.literal)

(approval_directive
  value: (inline_python_expr) @embedded)

(mcp_field
  value: (mcp_plain_value) @text.literal)

(mcp_field
  value: (inline_python_expr) @embedded)

(settings_field
  value: (settings_plain_value) @text.literal)

(settings_field
  value: (inline_python_expr) @embedded)

(input_segment
  name: (identifier) @variable)

(system_angle_segment) @variable

(call_segment
  name: (identifier) @function)

(output_segment
  name: (identifier) @variable)

(text_segment) @text.literal
(type_string) @text.literal
(python_code) @embedded
(python_inline_body) @embedded

(agent_directive
  value: (adapter_plain_value) @label)

(agent_field
  name: (identifier) @label)

(agent_field
  value: (agent_command_plain_value) @text.literal)

(agent_field
  value: (inline_python_expr) @embedded)

(adapter_directive
  value: (adapter_plain_value) @label)

(adapter_directive
  value: (inline_python_expr) @embedded)

(template_block_stmt
  ">>" @keyword)

(raw_invoke_stmt
  "<<" @keyword)

[
  "auto"
  "optimize"
  "agent"
  "adapter"
  "model"
  "effort"
  "approval"
  "system"
  "mcp"
  "settings"
  "profile"
  "use"
  "case"
  "data"
  "test_data"
  "metric"
] @keyword

[
  "import"
  "export"
] @operator

[
  "="
  "->"
  "|"
] @operator

[
  "@"
  "~"
  "<"
  ">"
  "```"
  "`"
] @punctuation.special

[
  "("
  ")"
  "["
  "]"
  ","
  ":"
] @punctuation.delimiter
