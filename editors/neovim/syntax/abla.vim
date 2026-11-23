" Vim syntax for Abla (no tree-sitter needed).
if exists("b:current_syntax")
  finish
endif

syn keyword ablaControl await break continue defer do else for if in return until when while yield
syn keyword ablaDeclaration class fun interface val var
syn keyword ablaModifier abstract compile extern noescape own resource trusted by constructor generator move region task thread
syn keyword ablaImport import
syn keyword ablaBoolean true false
syn keyword ablaNull null
syn keyword ablaType any array bool float i8 i16 i32 i64 int never string u8 u16 u32 u64 void Borrow Cell Fn FnMut FnNoEscape FnOnce Generator Mutex Shared Task Thread Weak
syn match ablaTypeName "\<[A-Z][A-Za-z0-9_]*\>"
syn match ablaNumber "\<0[xX][0-9A-Fa-f]\+\(_[0-9A-Fa-f]\+\)*\>"
syn match ablaNumber "\<[0-9]\+\(_[0-9]\+\)*\(\.[0-9]\+\(_[0-9]\+\)*\)\=\([eE][+-]\=[0-9]\+\)\=\>"
syn match ablaAnnotation "@[A-Za-z_][A-Za-z0-9_]*"
syn match ablaCompileTime "#"
syn match ablaEscape contained "\\\(u[0-9A-Fa-f]\{4}\|.\)"
syn match ablaInterpolation contained "\$[A-Za-z_][A-Za-z0-9_]*"
syn region ablaInterpolationBlock contained matchgroup=ablaInterpolation start="\${" end="}" contains=TOP
syn region ablaString start=+"+ skip=+\\\\\|\\"+ end=+"+ contains=ablaEscape,ablaInterpolation,ablaInterpolationBlock
syn region ablaString start=+"""+ end=+"""+ contains=ablaEscape,ablaInterpolation,ablaInterpolationBlock
syn match ablaDocComment "///.*$" contains=@Spell
syn match ablaComment "//.*$" contains=@Spell
syn region ablaComment start="/\*" end="\*/" contains=@Spell,ablaComment

hi def link ablaControl Conditional
hi def link ablaDeclaration Keyword
hi def link ablaModifier StorageClass
hi def link ablaImport Include
hi def link ablaBoolean Boolean
hi def link ablaNull Constant
hi def link ablaType Type
hi def link ablaTypeName Type
hi def link ablaNumber Number
hi def link ablaAnnotation PreProc
hi def link ablaCompileTime Macro
hi def link ablaEscape SpecialChar
hi def link ablaInterpolation Special
hi def link ablaString String
hi def link ablaDocComment SpecialComment
hi def link ablaComment Comment

let b:current_syntax = "abla"
