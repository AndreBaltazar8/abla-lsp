[
  (block)
  (lambda)
  (class_body)
  (when_expression)
  (array_literal)
  (arguments)
  (parameters)
] @indent.begin

[ "}" "]" ")" ] @indent.end
[ "}" "]" ")" ] @indent.branch

(string_literal) @indent.ignore
(raw_string_literal) @indent.ignore
(block_comment) @indent.auto
