use std::{
    env, fs,
    path::{Path, PathBuf},
};

use zed_extension_api::{
    self as zed, LanguageServerId, Result, node_binary_path, process::Command,
    settings::LspSettings,
};

const KEDI_LSP_ID: &str = "kedi-lsp";
const EMBEDDED_PYTHON_LSP_ID: &str = "kedi-embedded-python";
const PYRIGHT_PACKAGE_NAME: &str = "pyright";
const EMBEDDED_PYTHON_PROXY_SOURCE: &str = include_str!("../embedded-python-proxy/server.mjs");
const EMBEDDED_PYTHON_PROXY_ENV: &str = "KEDI_EMBEDDED_PYTHON_PROXY_SOURCE";
const EMBEDDED_PYTHON_PROXY_LOADER: &str = "await import(\"data:text/javascript;charset=utf-8,\" + encodeURIComponent(process.env.KEDI_EMBEDDED_PYTHON_PROXY_SOURCE))";
const PYTHON_VIRTUALIZER_ARGS: &str =
    "[\"-c\",\"from kedi.lsp.python_virtual import main_loop; main_loop()\"]";

struct KediExtension {
    cached_pyright_entrypoint: Option<String>,
}

#[derive(Debug, Default)]
struct EmbeddedPythonSettings {
    package_version: Option<String>,
}

impl EmbeddedPythonSettings {
    fn from_lsp_settings(settings: &LspSettings) -> Self {
        let package_version = settings
            .settings
            .as_ref()
            .and_then(|s| s.get("package_version"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Self { package_version }
    }
}

impl KediExtension {
    fn extension_root() -> Result<PathBuf> {
        env::current_dir().map_err(|e| e.to_string())
    }

    fn pyright_entrypoint_path() -> Result<PathBuf> {
        let entrypoint = PathBuf::from("node_modules")
            .join(PYRIGHT_PACKAGE_NAME)
            .join("langserver.index.js");
        if !entrypoint.exists() {
            return Err(format!(
                "Embedded Python backend not found at {}.",
                entrypoint.display()
            ));
        }
        Ok(entrypoint)
    }

    fn embedded_python_backend_exists(&self) -> bool {
        Self::pyright_entrypoint_path().is_ok()
    }

    fn configured_kedi_lsp_path(worktree: &zed::Worktree) -> Option<String> {
        LspSettings::for_worktree(KEDI_LSP_ID, worktree)
            .ok()
            .and_then(|settings| settings.binary)
            .and_then(|binary| binary.path)
            .or_else(|| worktree.which(KEDI_LSP_ID))
    }

    fn python_from_shebang(path: &str, worktree: &zed::Worktree) -> Option<String> {
        let first_line = fs::read_to_string(path).ok()?.lines().next()?.to_string();
        let shebang = first_line.strip_prefix("#!")?.trim();
        let mut parts = shebang.split_whitespace();
        let program = parts.next()?;

        if program.ends_with("/env") || program == "env" {
            for arg in parts {
                if arg.starts_with('-') || arg.contains('=') {
                    continue;
                }
                return worktree.which(arg).or_else(|| Some(arg.to_string()));
            }
            return None;
        }

        Some(program.to_string())
    }

    fn looks_like_python(path: &str) -> bool {
        Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("python"))
    }

    fn virtualizer_python(worktree: &zed::Worktree) -> String {
        if let Some(kedi_lsp_path) = Self::configured_kedi_lsp_path(worktree) {
            if Self::looks_like_python(&kedi_lsp_path) {
                return kedi_lsp_path;
            }
            if let Some(interpreter) = Self::python_from_shebang(&kedi_lsp_path, worktree) {
                return interpreter;
            }
        }

        worktree
            .which("python3.11")
            .or_else(|| worktree.which("python3"))
            .or_else(|| worktree.which("python"))
            .unwrap_or_else(|| "python3".to_string())
    }

    fn installed_pyright_version(&self) -> Option<String> {
        zed::npm_package_installed_version(PYRIGHT_PACKAGE_NAME)
            .ok()
            .flatten()
    }

    fn should_install_pyright(&self, target_version: &str) -> bool {
        if !self.embedded_python_backend_exists() {
            return true;
        }

        match self.installed_pyright_version() {
            Some(installed_version) => installed_version != target_version,
            None => true,
        }
    }

    fn ensure_pyright(
        &mut self,
        id: &LanguageServerId,
        requested_version: Option<&str>,
    ) -> Result<String> {
        if let Some(cached_path) = &self.cached_pyright_entrypoint {
            if fs::metadata(cached_path).is_ok_and(|stat| stat.is_file()) {
                return Ok(cached_path.clone());
            }
        }

        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );

        let target_version = match requested_version {
            Some(version) => version.to_string(),
            None => zed::npm_package_latest_version(PYRIGHT_PACKAGE_NAME)?,
        };

        if self.should_install_pyright(&target_version) {
            zed::set_language_server_installation_status(
                id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );

            let result = zed::npm_install_package(PYRIGHT_PACKAGE_NAME, &target_version);
            if let Err(error) = result {
                if !self.embedded_python_backend_exists() {
                    return Err(error);
                }
            }
        }

        let entrypoint = Self::extension_root()?
            .join(Self::pyright_entrypoint_path()?)
            .to_string_lossy()
            .into_owned();
        self.cached_pyright_entrypoint = Some(entrypoint.clone());
        Ok(entrypoint)
    }

    fn kedi_lsp_command(&self, worktree: &zed::Worktree) -> Result<Command> {
        let lsp_settings = LspSettings::for_worktree(KEDI_LSP_ID, worktree)?;
        let shell_env = worktree.shell_env();

        if let Some(binary_settings) = lsp_settings.binary {
            if let Some(path) = binary_settings.path {
                let mut command = Command::new(path).envs(shell_env.clone());
                if let Some(arguments) = binary_settings.arguments {
                    command = command.args(arguments);
                }
                if let Some(env) = binary_settings.env {
                    command = command.envs(env);
                }
                return Ok(command);
            }
        }

        if let Some(path) = worktree.which(KEDI_LSP_ID) {
            return Ok(Command::new(path).envs(shell_env.clone()));
        }

        if let Some(path) = worktree.which("python3") {
            return Ok(
                Command::new(path)
                    .envs(shell_env.clone())
                    .args(["-m", "kedi.lsp.server"]),
            );
        }

        if let Some(path) = worktree.which("python") {
            return Ok(
                Command::new(path)
                    .envs(shell_env)
                    .args(["-m", "kedi.lsp.server"]),
            );
        }

        Err(
            "Could not find `kedi-lsp`, `python3`, or `python` on PATH. Configure `lsp.kedi-lsp.binary` in Zed settings.".into(),
        )
    }

    fn embedded_python_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Command> {
        let lsp_settings = LspSettings::for_worktree(EMBEDDED_PYTHON_LSP_ID, worktree).ok();
        let shell_env = worktree.shell_env();

        let env = lsp_settings
            .as_ref()
            .and_then(|settings| settings.binary.as_ref())
            .and_then(|binary| binary.env.clone());

        let settings = lsp_settings
            .as_ref()
            .map(EmbeddedPythonSettings::from_lsp_settings)
            .unwrap_or_default();

        let pyright_entrypoint = self.ensure_pyright(id, settings.package_version.as_deref())?;
        let node = node_binary_path()?;
        let virtualizer_python = Self::virtualizer_python(worktree);

        let mut command = Command::new(node)
            .envs(shell_env)
            .env(EMBEDDED_PYTHON_PROXY_ENV, EMBEDDED_PYTHON_PROXY_SOURCE)
            .env("KEDI_PYTHON_VIRTUALIZER_COMMAND", virtualizer_python)
            .env("KEDI_PYTHON_VIRTUALIZER_ARGS", PYTHON_VIRTUALIZER_ARGS)
            .args([
                "--input-type=module".to_string(),
                "--eval".to_string(),
                EMBEDDED_PYTHON_PROXY_LOADER.to_string(),
                pyright_entrypoint,
            ]);

        if let Some(env) = env {
            command = command.envs(env);
        }

        Ok(command)
    }
}

impl zed::Extension for KediExtension {
    fn new() -> Self {
        Self {
            cached_pyright_entrypoint: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Command> {
        match language_server_id.as_ref() {
            KEDI_LSP_ID => self.kedi_lsp_command(worktree),
            EMBEDDED_PYTHON_LSP_ID => self.embedded_python_command(language_server_id, worktree),
            id => Err(format!("Unsupported language server id: {id}")),
        }
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(
            LspSettings::for_worktree(language_server_id.as_ref(), worktree)?
                .initialization_options,
        )
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)?.settings)
    }
}

zed::register_extension!(KediExtension);
