-- Neovim (0.11 or newer) client for abla-lsp.
--
--   vim.opt.runtimepath:append("/path/to/abla-lsp/editors/neovim")
--   require("abla").setup({ cmd = { "abla-lsp", "--stdio" } })
--
-- With nvim-lspconfig instead, copy the `configs.abla` block below.
local M = {}

local function root_dir(buffer, on_dir)
  local name = vim.api.nvim_buf_get_name(buffer)
  local found = vim.fs.find({ "abla.toml", "abla.lock", ".git" }, { path = name, upward = true })[1]
  on_dir(found and vim.fs.dirname(found) or vim.fs.dirname(name))
end

function M.config(options)
  options = options or {}
  return {
    cmd = options.cmd or { "abla-lsp", "--stdio" },
    filetypes = { "abla" },
    root_dir = root_dir,
    settings = options.settings or {},
  }
end

function M.setup(options)
  vim.filetype.add({ extension = { ab = "abla" } })
  vim.lsp.config("abla", M.config(options))
  vim.lsp.enable("abla")
end

return M
