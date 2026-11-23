; Comments
(line_comment) @comment
(block_comment) @comment

; Literals
(integer_literal) @number
(float_literal) @number.float
(boolean_literal) @constant.builtin.boolean
(null_literal) @constant.builtin
(string_literal) @string
(raw_string_literal) @string
(string_content) @string
(escape_sequence) @string.escape
(interpolated_identifier) @variable
(interpolation "${" @punctuation.special "}" @punctuation.special)

; Declarations
(function_declaration name: (identifier) @function)
(operator_declaration name: (_) @function)
(class_declaration name: (identifier) @type)
(interface_declaration name: (identifier) @type)
(type_alias (identifier) @type)
(type_parameter (identifier) @type)
(property_declaration name: (identifier) @variable)
(parameter name: (identifier) @variable.parameter)
(lambda_parameters (identifier) @variable.parameter)
(function_declaration receiver: (receiver_type (identifier) @type))
(property_declaration receiver: (receiver_type (identifier) @type))

; Types
(type_name (identifier) @type)
(qualified_type (identifier) @namespace)
(receiver_type (identifier) @type)
((type_name (identifier) @type.builtin)
 (#match? @type.builtin "^(any|array|bool|char|f32|f64|float|i8|i16|i32|i64|int|never|string|u8|u16|u32|u64|void|cstring|Map|Cell|Fn|FnMut|FnNoEscape|FnOnce|Generator|Mutex|Shared|Task|Thread|Weak|Borrow)$"))

; Calls
(call_expression (identifier) @function.call)
(call_expression (member_expression name: (identifier) @function.method.call))
(call_expression (safe_member_expression name: (identifier) @function.method.call))
(generic_call (identifier) @function.call)
(postfix_lambda_call (identifier) @function.call)
(postfix_lambda_call (member_expression name: (identifier) @function.method.call))
(member_expression name: (identifier) @property)
(safe_member_expression name: (identifier) @property)
(subparser_expression "$" @punctuation.special (identifier) @function.macro)
[(subparser_brace) (subparser_raw)] @string.special

; Annotations and labels
(annotation "@" @attribute (identifier) @attribute)
(labeled_loop (identifier) @label)
(break_expression (identifier) @label)
(continue_expression (identifier) @label)

(this_expression) @variable.builtin

; Keywords
[
  "fun" "class" "interface" "val" "var" "type" "extend" "operator" "where"
] @keyword

[
  "private" "export" "abstract" "sealed" "resource" "trusted" "noescape"
  "compile" "extern" "override" "open" "own" "vararg" "by"
] @keyword.modifier

[ "import" "contract" "as" ] @keyword.import

[ "if" "else" "when" "is" ] @keyword.conditional
[ "for" "while" "do" "in" "break" "continue" "until" ] @keyword.repeat
[ "return" "yield" ] @keyword.return
[ "defer" "await" "region" "atomic" "generator" "task" "thread" "move" ] @keyword

(else_pattern) @keyword.conditional

; Operators and punctuation
[
  "+" "-" "*" "/" "%" "==" "!=" "<" "<=" ">" ">=" "&&" "||" "!" "~" "&" "|" "^"
  "<<" ">>" ">>>" "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>="
  ".." "??" "?." "->" "#" "?"
] @operator

[ "(" ")" "[" "]" "{" "}" ] @punctuation.bracket
[ "," ";" "." ":" ] @punctuation.delimiter

; Plain identifiers last, so every rule above wins
(identifier) @variable
