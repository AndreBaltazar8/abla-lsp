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
  mkdir -p "$config/bin"
  printf '#!/bin/sh\nexec node "%s" "$@"\n' "$server" >"$config/bin/abla-lsp"
  chmod +x "$config/bin/abla-lsp"
  health=$(PATH="$config/bin:$PATH" XDG_CONFIG_HOME="$config" "$hx" --health abla 2>&1 | sed 's/\x1b\[[0-9;]*m//g' || true)
  printf '%s\n' "$health"
  case $health in
    *"✓ abla-lsp"*) echo "helix config ok" ;;
    *) echo "FAIL helix: abla-lsp is not configured and found" >&2; status=1 ;;
  esac
  rm -rf "$config"
else
  echo "SKIP helix (not installed)"
fi
exit $status
