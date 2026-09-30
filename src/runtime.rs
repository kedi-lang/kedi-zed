use zed_extension_api::{self as zed, process::Command, LanguageServerId, Result};

const BOOTSTRAP: &str = include_str!("../runtime/bootstrap.cjs");

pub fn managed_python(worktree: &zed::Worktree, id: Option<&LanguageServerId>) -> Result<String> {
    if let Some(id) = id {
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::Downloading,
        );
    }
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
    if let Some(id) = id {
        zed::set_language_server_installation_status(
            id,
            &match &result {
                Ok(_) => zed::LanguageServerInstallationStatus::None,
                Err(error) => zed::LanguageServerInstallationStatus::Failed(error.clone()),
            },
        );
    }
    result
}

pub fn configured_python(settings: Option<&zed::serde_json::Value>) -> Result<Option<String>> {
    let Some(value) = settings.and_then(|value| value.get("python_path")) else {
        return Ok(None);
    };
    let path = value
        .as_str()
        .filter(|path| !path.contains('\0'))
        .ok_or_else(|| "lsp.kedi-lsp.settings.python_path must be a string".to_string())?
        .trim();
    Ok((!path.is_empty()).then(|| path.to_string()))
}

pub fn looks_like_python(path: &str) -> bool {
    // WASI paths do not recognize Windows separators.
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let name = name.strip_suffix(".exe").unwrap_or(name);
    name.strip_prefix("python").is_some_and(|version| {
        version.is_empty()
            || (version.starts_with(|c: char| c.is_ascii_digit())
                && version.chars().all(|c| c.is_ascii_digit() || c == '.'))
    })
}

pub fn python_from_shebang(source: &str, which: impl Fn(&str) -> Option<String>) -> Option<String> {
    let mut parts = source
        .lines()
        .next()?
        .strip_prefix("#!")?
        .split_whitespace();
    let program = parts.next()?;
    if program.ends_with("/env") || program == "env" {
        // Only the unambiguous env forms identify an interpreter; wrappers and
        // env options that change PATH require an explicit python_path.
        let candidate = parts.next()?;
        let python = if matches!(candidate, "-S" | "--split-string") {
            parts.next()?
        } else {
            candidate
        };
        return looks_like_python(python)
            .then(|| which(python).unwrap_or_else(|| python.to_string()));
    }
    looks_like_python(program).then(|| program.to_string())
}

#[cfg(test)]
mod tests {
    use super::{configured_python, looks_like_python, python_from_shebang};
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
        assert!(configured_python(Some(&json!({"python_path": null}))).is_err());
        assert!(configured_python(Some(&json!({"python_path": "/bad\0python"}))).is_err());
        assert_eq!(
            configured_python(Some(&json!({"python_path": "  /host venv/bin/python  "}))).unwrap(),
            Some("/host venv/bin/python".to_string())
        );
    }

    #[test]
    fn python_names_include_windows_paths_but_not_other_python_tools() {
        for path in [
            "/venv/bin/python",
            "/venv/bin/python3.12",
            "C:\\venv\\Scripts\\python.exe",
        ] {
            assert!(looks_like_python(path), "{path}");
        }
        for path in [
            "/bin/sh",
            "python-lsp-server",
            "python_config",
            "/bin/node",
            "python/",
            "python...",
        ] {
            assert!(!looks_like_python(path), "{path}");
        }
    }

    #[test]
    fn shebang_inference_never_selects_a_shell_or_guesses_wrapper_environments() {
        for source in [
            "#!/bin/sh\nexec /venv/bin/python \"$@\"",
            "#!/usr/bin/env bash\n",
            "#!/usr/bin/env PATH=/other python3\n",
            "#!/usr/bin/env -u PYTHONPATH python3\n",
            "#!/usr/bin/python-lsp-server\n",
            "no shebang",
        ] {
            assert_eq!(
                python_from_shebang(source, |_| panic!("unexpected PATH lookup")),
                None
            );
        }
        assert_eq!(
            python_from_shebang("#!/venv/bin/python3 -I\n", |_| panic!(
                "unexpected PATH lookup"
            )),
            Some("/venv/bin/python3".into())
        );
        for source in ["#!/usr/bin/env python3\n", "#!/usr/bin/env -S python3 -I\n"] {
            assert_eq!(
                python_from_shebang(source, |name| {
                    assert_eq!(name, "python3");
                    Some("/host/bin/python3".into())
                }),
                Some("/host/bin/python3".into())
            );
        }
    }
}
