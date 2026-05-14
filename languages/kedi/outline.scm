(procedure_def
  name: (identifier) @name) @item

(type_def
  name: (identifier) @name) @item

(validation_block
  kw: (validation_keyword) @context
  procedure: (identifier) @name) @item

(test_case
  name: (identifier) @name) @item

(eval_data
  name: (identifier) @name) @item

(eval_test_data
  name: (identifier) @name) @item

(eval_metric
  name: (identifier) @name) @item

(optimize_directive
  name: (identifier) @name) @item
