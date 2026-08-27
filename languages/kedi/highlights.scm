(line_comment) @comment
(block_comment) @comment
(procedure_def
  body: (block
    . (block_comment) @variable))

(procedure_def
  name: (identifier) @function)

(type_def
  name: (identifier) @type)

(package_directive
  name: (identifier) @namespace)

(package_field
  name: (identifier) @property)

(package_field
  value: (package_plain_value) @text.literal)

(package_python_dependencies
  "python_dependencies" @property)

(package_dependency
  value: (package_dependency_value) @text.literal)

(module_import
  module: (module_path) @namespace)

(module_import_name
  name: (identifier) @variable)

(module_export_name
  name: (identifier) @variable)

(binding_target
  name: (identifier) @variable)

(assignment_stmt
  name: (identifier) @variable)

(assignment_block_stmt
  name: (identifier) @variable)

(loop_stmt
  binder: (identifier) @variable)

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

(subagent_directive
  name: (identifier) @label)

(max_agents_directive
  value: (positive_integer) @number)

(workflow_directive
  "workflow" @keyword
  value: (identifier) @constant)

(history_directive
  "history" @keyword
  value: (history_plain_value) @text.literal)

(history_directive "history" @keyword)

(history_field
  name: (identifier) @property)

(history_field
  value: (settings_plain_value) @text.literal)

(history_field
  value: (inline_python_expr) @embedded)

(skills_directive
  ">" @operator)

(skills_directive "skills" @keyword)

(skills_plain_value) @constant

(skills_field
  name: (identifier) @property)

(skills_field
  value: (settings_plain_value) @text.literal)

(skills_field
  value: (inline_python_expr) @embedded)

(codemode_directive
  ">" @operator)

(codemode_directive "codemode" @keyword)

(codemode_plain_value) @constant

(codemode_field
  name: (identifier) @property)

(codemode_field
  value: (settings_plain_value) @text.literal)

(codemode_field
  value: (inline_python_expr) @embedded)

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

(artifacts_field
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

(artifacts_field
  value: (artifacts_plain_value) @text.literal)

(artifacts_field
  value: (inline_python_expr) @embedded)

(input_segment
  name: (identifier) @variable)

(system_angle_segment) @variable

(call_segment
  name: (identifier) @function)

(output_segment
  name: (identifier) @variable)

(text_segment) @text.literal
(condition_text_segment) @text.literal
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
  "codemode"
  "history"
  "system"
  "mcp"
  "settings"
  "artifacts"
  "output"
  "subagent"
  "max_agents"
  "workflow"
  "profile"
  "use"
  "case"
  "data"
  "test_data"
  "metric"
  "if"
  "else"
  "loop"
  "map"
] @keyword

[
  "import"
  "export"
] @operator

"package" @keyword

[
  "="
  ":="
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
