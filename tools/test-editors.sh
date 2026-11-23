#!/bin/sh
# Headless checks of the editor configs: Neovim attaches the client and gets hover
# on a fixture; Helix reports the language server and the language as configured.
# A missing editor is a skip (exit 0), not a failure. Needs ablac on PATH or ABLA_COMPILER.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$root/test/fixtures-editors/hover.ab
server=$root/dist/src/main.js
status=0

[ -f "$server" ] || { echo "build first: npm run build" >&2; exit 1; }

if command -v nvim >/dev/null 2>&1; then
  out=$(mktemp)
  grammar=$(cd "$root/.." && pwd)/tree-sitter-abla
  parser=
  if [ -d "$grammar/src" ] && command -v cc >/dev/null 2>&1; then
    parser=$(mktemp -d)/abla.so
    cc -shared -fPIC -O1 -I"$grammar/src" "$grammar/src/parser.c" "$grammar/src/scanner.c" -o "$parser" || parser=
  fi
  cat >"$out.lua" <<LUA
vim.opt.runtimepath:append("$root/editors/neovim")
vim.opt.shadafile = "NONE"
vim.cmd("filetype plugin on")
require("abla").setup({ cmd = { "node", "$server", "--stdio" } })
vim.cmd("edit $fixture")
local ok = vim.wait(20000, function() return #vim.lsp.get_clients({ bufnr = 0, name = "abla" }) > 0 end, 100)
if not ok then io.stderr:write("nvim: client did not attach\n") vim.cmd("cquit 2") end
if vim.bo.filetype ~= "abla" then io.stderr:write("nvim: filetype is " .. vim.bo.filetype .. "\n") vim.cmd("cquit 3") end
-- line 6, on "result"? hover on the call to double (line 6, column 16)
local text
vim.wait(30000, function()
  local response = vim.lsp.buf_request_sync(0, "textDocument/hover", {
    textDocument = vim.lsp.util.make_text_document_params(0),
    position = { line = 5, character = 15 },
  }, 5000)
  for _, reply in pairs(response or {}) do
    if reply.result and reply.result.contents then
      text = vim.inspect(reply.result.contents)
      return true
    end
  end
  return false
end, 500)
if not text or not text:find("double", 1, true) then
  io.stderr:write("nvim: no hover for double: " .. tostring(text) .. "\n")
  vim.cmd("cquit 4")
end
print("nvim hover ok")
local parser = "$parser"
if parser ~= "" then
  vim.treesitter.language.add("abla", { path = parser })
  local tree = vim.treesitter.get_parser(0, "abla"):parse()[1]
  if tree:root():has_error() then io.stderr:write("nvim: the fixture has a tree-sitter error\n") vim.cmd("cquit 5") end
  local query = vim.treesitter.query.get("abla", "highlights")
  if not query then io.stderr:write("nvim: no highlights query\n") vim.cmd("cquit 6") end
  local names = {}
  for id, _ in query:iter_captures(tree:root(), 0) do names[query.captures[id]] = true end
  if not (names["keyword"] and names["function"] and names["type.builtin"]) then
    io.stderr:write("nvim: highlights miss keyword, function or type.builtin: " .. vim.inspect(vim.tbl_keys(names)) .. "\n") vim.cmd("cquit 7")
  end
  print("nvim tree-sitter highlights ok")
end
vim.cmd("qall!")
LUA
  if XDG_CONFIG_HOME=$(mktemp -d) XDG_STATE_HOME=$(mktemp -d) XDG_DATA_HOME=$(mktemp -d) nvim --headless -u NONE -l "$out.lua" 2>&1; then
    :
  else
    echo "FAIL nvim" >&2
    status=1
  fi
  rm -f "$out" "$out.lua"
else
  echo "SKIP nvim (not installed)"
fi

hx=$(command -v hx || command -v helix || true)
if [ -n "$hx" ]; then
  config=$(mktemp -d); mkdir -p "$config/helix"
  cp "$root/editors/helix/languages.toml" "$config/helix/languages.toml"
  grammar=$(cd "$root/.." && pwd)/tree-sitter-abla
  if [ -d "$grammar" ]; then
    # Only abla's grammar, from the sibling checkout: hx would build all 246 default ones.
    { printf 'use-grammars = { only = ["abla"] }\n\n'; sed "s|source = { git = .*|source = { path = \"$grammar\" }|" "$config/helix/languages.toml"; } > "$config/helix/languages.new"
    mv "$config/helix/languages.new" "$config/helix/languages.toml"
    mkdir -p "$config/helix/runtime/grammars" "$config/helix/runtime/queries"
    if command -v cc >/dev/null 2>&1; then
      XDG_CONFIG_HOME="$config" "$hx" --grammar build </dev/null >"$config/grammar.log" 2>&1 && [ -f "$config/helix/runtime/grammars/abla.so" ] ||
        { echo "FAIL helix: grammar build"; cat "$config/grammar.log" >&2; status=1; }
    fi
    cp -r "$root/editors/helix/queries/abla" "$config/helix/runtime/queries/abla"
  fi
  mkdir -p "$config/bin"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$server" >"$config/bin/abla-lsp"
  chmod +x "$config/bin/abla-lsp"
  health=$(PATH="$config/bin:$PATH" XDG_CONFIG_HOME="$config" HELIX_RUNTIME="$config/helix/runtime" "$hx" --health abla 2>&1 | sed 's/\x1b\[[0-9;]*m//g' || true)
  printf '%s\n' "$health"
  case $health in
    *"✓ abla-lsp"*)
      if [ -d "$grammar" ]; then
        case $health in
          *"Highlight queries: ✓"*"Textobject queries: ✓"*"Indent queries: ✓"*) echo "helix config and queries ok" ;;
          *) echo "FAIL helix: the abla queries were not found" >&2; status=1 ;;
        esac
      else echo "helix config ok" ; fi ;;
    *) echo "FAIL helix: abla-lsp is not configured and found" >&2; status=1 ;;
  esac
  rm -rf "$config"
else
  echo "SKIP helix (not installed)"
fi
exit $status
