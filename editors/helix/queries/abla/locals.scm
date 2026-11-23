(function_declaration) @local.scope
(operator_declaration) @local.scope
(lambda) @local.scope
(block) @local.scope
(class_declaration) @local.scope
(for_statement) @local.scope

(parameter name: (identifier) @local.definition)
(lambda_parameters (identifier) @local.definition)
(property_declaration name: (identifier) @local.definition)
(for_statement (identifier) @local.definition)

(identifier) @local.reference
