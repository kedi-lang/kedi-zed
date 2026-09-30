use std::{
    env, fs,
    path::{Path, PathBuf},
};

use zed_extension_api::{
    self as zed, node_binary_path, process::Command, settings::LspSettings, LanguageServerId,
    Result,
};

mod debugger;
mod runtime;

const KEDI_LSP_ID: &str = "kedi-lsp";
const EMBEDDED_PYTHON_LSP_ID: &str = "kedi-embedded-python";
const KEDI_PYTHON_DOCSTRINGS_LSP_ID: &str = "kedi-python-docstrings";
const PYRIGHT_PACKAGE_NAME: &str = "pyright";
const EMBEDDED_PYTHON_PROXY_SOURCE: &str = include_str!("../embedded-python-proxy/server.mjs");
const PYTHON_COMPLETION_SOURCE: &str = include_str!("../embedded-python-proxy/completion.mjs");
const EMBEDDED_PYTHON_PROXY_ENV: &str = "KEDI_EMBEDDED_PYTHON_PROXY_SOURCE";
const EMBEDDED_PYTHON_PROXY_LOADER: &str = "await import(\"data:text/javascript;charset=utf-8,\" + encodeURIComponent(process.env.KEDI_EMBEDDED_PYTHON_PROXY_SOURCE))";

struct KediExtension;

fn ensure_pyright_package(
    requested: Option<&str>,
    installed: Option<&str>,
    latest: impl FnOnce() -> Result<String>,
    install: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    // A valid local backend must not depend on registry access at every startup.
    let target = match requested.or(installed) {
        Some(version) => version.to_string(),
        None => latest()?,
    };
    if installed != Some(target.as_str()) {
        install(&target)?;
    }
    Ok(())
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
        if !entrypoint.is_file() {
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
    }

    fn python_from_shebang(path: &str, worktree: &zed::Worktree) -> Option<String> {
        let root = PathBuf::from(worktree.root_path());
        let worktree_source = Path::new(path)
            .strip_prefix(&root)
            .ok()
            .and_then(|relative| relative.to_str())
            .and_then(|relative| worktree.read_text_file(relative).ok());
        let source = worktree_source.or_else(|| fs::read_to_string(path).ok())?;
        runtime::python_from_shebang(&source, |program| worktree.which(program))
    }

    fn python_command(worktree: &zed::Worktree, id: Option<&LanguageServerId>) -> Result<Command> {
        let settings = LspSettings::for_worktree(KEDI_LSP_ID, worktree)?;
        if let Some(path) = runtime::configured_python(settings.settings.as_ref())? {
            return Ok(Command::new(path).envs(worktree.shell_env()));
        }
        if let Some(kedi_lsp_path) = Self::configured_kedi_lsp_path(worktree) {
            if runtime::looks_like_python(&kedi_lsp_path) {
                return Ok(Command::new(kedi_lsp_path).envs(worktree.shell_env()));
            }
            if let Some(interpreter) = Self::python_from_shebang(&kedi_lsp_path, worktree) {
                return Ok(Command::new(interpreter).envs(worktree.shell_env()));
            }
            return Err("Cannot identify Python from the custom Kedi server executable. Set lsp.kedi-lsp.settings.python_path for the language helpers and debugger.".into());
        }
        Ok(Command::new(runtime::managed_python(worktree, id)?)
            .envs(worktree.shell_env())
            .arg("-I"))
    }

    fn installed_pyright_version(&self) -> Option<String> {
        zed::npm_package_installed_version(PYRIGHT_PACKAGE_NAME)
            .ok()
            .flatten()
    }

    fn ensure_pyright(
        &mut self,
        id: &LanguageServerId,
        requested_version: Option<&str>,
    ) -> Result<String> {
        let installed = self
            .installed_pyright_version()
            .filter(|_| self.embedded_python_backend_exists());
        let result = ensure_pyright_package(
            requested_version,
            installed.as_deref(),
            || {
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::CheckingForUpdate,
                );
                zed::npm_package_latest_version(PYRIGHT_PACKAGE_NAME)
            },
            |version| {
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                zed::npm_install_package(PYRIGHT_PACKAGE_NAME, version)
            },
        );
        if let Err(error) = result {
            zed::set_language_server_installation_status(
                id,
                &zed::LanguageServerInstallationStatus::Failed(error.clone()),
            );
            return Err(error);
        }

        let entrypoint = Self::extension_root()?
            .join(Self::pyright_entrypoint_path()?)
            .to_string_lossy()
            .into_owned();
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::None,
        );
        Ok(entrypoint)
    }

    fn kedi_lsp_command(&self, worktree: &zed::Worktree, id: &LanguageServerId) -> Result<Command> {
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

        Ok(Self::python_command(worktree, Some(id))?.args(["-m", "kedi.lsp.server"]))
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
        let python = Self::python_command(worktree, Some(id))?;
        let mut virtualizer_args = python.args;
        virtualizer_args.extend([
            "-c".into(),
            "from kedi.lsp.python_virtual import main_loop; main_loop()".into(),
        ]);
        let virtualizer_args =
            zed::serde_json::to_string(&virtualizer_args).map_err(|error| error.to_string())?;

        let mut command = Command::new(node)
            .envs(shell_env)
            .env(EMBEDDED_PYTHON_PROXY_ENV, EMBEDDED_PYTHON_PROXY_SOURCE)
            .env("KEDI_PYTHON_COMPLETION_SOURCE", PYTHON_COMPLETION_SOURCE)
            .env("KEDI_PYTHON_VIRTUALIZER_COMMAND", python.command)
            .env("KEDI_PYTHON_VIRTUALIZER_ARGS", virtualizer_args)
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
        Self
    }

    fn get_dap_binary(
        &mut self,
        adapter_name: String,
        config: zed::DebugTaskDefinition,
        user_provided_debug_adapter_path: Option<String>,
        worktree: &zed::Worktree,
    ) -> Result<zed::DebugAdapterBinary> {
        debugger::check_adapter(&adapter_name)?;
        debugger::check_adapter(&config.adapter)?;
        if user_provided_debug_adapter_path.is_some() {
            return Err("Kedi uses the selected Python, not a custom DAP binary. Set lsp.kedi-lsp.settings.python_path instead.".into());
        }
        if config.tcp_connection.is_some() {
            return Err("Kedi supports local stdio debugging only, not TCP or attach.".into());
        }
        let root = worktree.root_path();
        let value = zed::serde_json::from_str(&config.config)
            .map_err(|_| "Invalid Kedi debug configuration JSON.".to_string())?;
        let value = debugger::launch_configuration(value, &root)?;
        let python = Self::python_command(worktree, None)?;
        debugger::check_debugger(&python)?;
        Ok(debugger::binary(python, value, root))
    }

    fn dap_request_kind(
        &mut self,
        adapter_name: String,
        config: zed::serde_json::Value,
    ) -> Result<zed::StartDebuggingRequestArgumentsRequest> {
        debugger::check_adapter(&adapter_name)?;
        debugger::request_kind(&config)
    }

    fn dap_config_to_scenario(&mut self, config: zed::DebugConfig) -> Result<zed::DebugScenario> {
        debugger::scenario(config)
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Command> {
        match language_server_id.as_ref() {
            KEDI_LSP_ID => self.kedi_lsp_command(worktree, language_server_id),
            EMBEDDED_PYTHON_LSP_ID => self.embedded_python_command(language_server_id, worktree),
            KEDI_PYTHON_DOCSTRINGS_LSP_ID => self.kedi_lsp_command(worktree, language_server_id),
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

#[cfg(test)]
mod pyright_tests {
    use super::ensure_pyright_package;

    #[test]
    fn installed_backend_starts_without_registry_access_or_reinstallation() {
        for requested in [None, Some("1.2.3")] {
            ensure_pyright_package(
                requested,
                Some("1.2.3"),
                || panic!("cached startup must not query npm"),
                |_| panic!("cached startup must not install"),
            )
            .unwrap();
        }
    }

    #[test]
    fn explicit_version_change_installs_without_querying_latest() {
        let mut installed = None;
        ensure_pyright_package(
            Some("1.2.4"),
            Some("1.2.3"),
            || panic!("explicit version must not query latest"),
            |version| {
                installed = Some(version.to_string());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(installed.as_deref(), Some("1.2.4"));
    }

    #[test]
    fn missing_backend_is_installed_from_latest_or_explicit_version() {
        for requested in [None, Some("1.2.4")] {
            let mut queried = false;
            let mut installed = None;
            ensure_pyright_package(
                requested,
                None,
                || {
                    queried = true;
                    Ok("1.2.4".into())
                },
                |version| {
                    installed = Some(version.to_string());
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(queried, requested.is_none());
            assert_eq!(installed.as_deref(), Some("1.2.4"));
        }
    }

    #[test]
    fn fresh_install_certificate_errors_are_not_bypassed() {
        let error = ensure_pyright_package(
            None,
            None,
            || Err("EE certificate key too weak".into()),
            |_| panic!("failed lookup must not install"),
        )
        .unwrap_err();
        assert_eq!(error, "EE certificate key too weak");
    }

    #[test]
    fn failed_explicit_upgrade_does_not_silently_use_the_old_version() {
        let error = ensure_pyright_package(
            Some("1.2.4"),
            Some("1.2.3"),
            || panic!("explicit version must not query latest"),
            |_| Err("Certificate verification failed".into()),
        )
        .unwrap_err();
        assert_eq!(error, "Certificate verification failed");
    }
}
