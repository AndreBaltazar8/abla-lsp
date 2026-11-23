use zed_extension_api::{self as zed, LanguageServerId, Result};

struct Abla;

impl zed::Extension for Abla {
    fn new() -> Self {
        Abla
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let path = worktree
            .which("abla-lsp")
            .ok_or_else(|| "abla-lsp is not on PATH (npm install -g abla-lsp)".to_string())?;
        Ok(zed::Command {
            command: path,
            args: vec!["--stdio".to_string()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(Abla);
