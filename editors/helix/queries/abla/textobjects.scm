(function_declaration
  (block) @function.inside) @function.around
(function_declaration
  "=" (_) @function.inside) @function.around
(operator_declaration
  (block) @function.inside) @function.around
(lambda) @function.around
(lambda (_) @function.inside)

(class_declaration
  (class_body) @class.inside) @class.around
(interface_declaration
  (class_body) @class.inside) @class.around
(class_declaration) @class.around

(parameters
  ((parameter) @parameter.inside . ","? @parameter.around) @parameter.around)
(arguments
  ((_) @parameter.inside . ","? @parameter.around) @parameter.around)

[(line_comment) (block_comment)] @comment.around

(when_arm) @conditional.around
(if_expression) @conditional.around
(when_expression) @conditional.around

[(while_statement) (do_while_statement) (for_statement)] @loop.around
