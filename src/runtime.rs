use zed_extension_api::{self as zed, process::Command, LanguageServerId, Result};

const BOOTSTRAP: &str = include_str!("../runtime/bootstrap.cjs");

pub fn managed_python(worktree: &zed::Worktree, id: &LanguageServerId) -> Result<String> {
    zed::set_language_server_installation_status(
        id,
        &zed::LanguageServerInstallationStatus::Downloading,
    );
    let result = (|| {
        let loader = format!(
            "{BOOTSTRAP}\nmodule.exports.ensureRuntime().then(value => process.stdout.write(JSON.stringify(value))).catch(error => {{ console.error(error.message); process.exitCode = 1; }});"
        );
        let output = Command::new(zed::node_binary_path()?)
            .envs(worktree.shell_env())
            .args(["--eval", &loader])
            .output()?;
        if output.status != Some(0) {
            return Err(format!(
                "Kedi Python setup failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let value: zed::serde_json::Value =
            zed::serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
        value
            .get("python")
            .and_then(|python| python.as_str())
            .filter(|python| !python.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "Kedi setup returned no Python executable".to_string())
    })();
    zed::set_language_server_installation_status(
        id,
        &match &result {
            Ok(_) => zed::LanguageServerInstallationStatus::None,
            Err(error) => zed::LanguageServerInstallationStatus::Failed(error.clone()),
        },
    );
    result
}

pub fn configured_python(settings: Option<&zed::serde_json::Value>) -> Result<Option<String>> {
    let Some(value) = settings.and_then(|value| value.get("python_path")) else {
        return Ok(None);
    };
    let path = value
        .as_str()
        .ok_or_else(|| "lsp.kedi-lsp.settings.python_path must be a string".to_string())?
        .trim();
    Ok((!path.is_empty()).then(|| path.to_string()))
}

#[cfg(test)]
mod tests {
    use super::configured_python;
    use zed_extension_api::serde_json::json;

    #[test]
    fn managed_is_default_and_explicit_host_is_preserved() {
        assert_eq!(configured_python(None).unwrap(), None);
        assert_eq!(
            configured_python(Some(&json!({"python_path": ""}))).unwrap(),
            None
        );
        assert_eq!(
            configured_python(Some(&json!({"python_path": "/host venv/bin/python"}))).unwrap(),
            Some("/host venv/bin/python".to_string())
        );
        assert!(configured_python(Some(&json!({"python_path": false}))).is_err());
    }
}
