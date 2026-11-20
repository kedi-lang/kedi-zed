use std::{env, fs, path::PathBuf};

use zed_extension_api::{self as zed, process::Command, LanguageServerId, Result};

const BOOTSTRAP: &str = include_str!("../runtime/bootstrap.cjs");

/// Small driver that runs the bundled installer by path. It must stay far
/// below the Windows 32,767-character limit for a single environment value
/// or command-line argument: the installer itself is ~28 KB, so it is
/// written to disk next to this driver instead of being passed `--eval`.
const BOOTSTRAP_DRIVER: &str = "require(\"./bootstrap.cjs\").ensureRuntime().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });\n";

/// Writes the bundled installer and its driver into the extension
/// directory and returns the driver path.
pub fn write_bootstrap_files() -> Result<PathBuf> {
    let dir = env::current_dir()
        .map_err(|error| error.to_string())?
        .join("runtime");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    fs::write(dir.join("bootstrap.cjs"), BOOTSTRAP).map_err(|error| error.to_string())?;
    let driver = dir.join("bootstrap-run.cjs");
    fs::write(&driver, BOOTSTRAP_DRIVER).map_err(|error| error.to_string())?;
    Ok(driver)
}

pub fn managed_python(worktree: &zed::Worktree, id: Option<&LanguageServerId>) -> Result<String> {
    if let Some(id) = id {
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::Downloading,
        );
    }
    let result = (|| {
        let driver = write_bootstrap_files()?;
        let output = Command::new(zed::node_binary_path()?)
            .envs(worktree.shell_env())
            .args([driver.to_string_lossy().into_owned()])
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
    // WASI paths do not recognize Windows separators, and the name match
    // is case-insensitive, so `PYTHON.EXE` and `python.EXE` count too.
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    stem.strip_prefix("python").is_some_and(|version| {
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
    use super::{
        configured_python, looks_like_python, python_from_shebang, BOOTSTRAP, BOOTSTRAP_DRIVER,
    };
    use zed_extension_api::serde_json::json;

    #[test]
    fn bootstrap_driver_stays_far_below_the_windows_limit() {
        // The installer itself is ~28 KB, so it is written to disk and run
        // by path; only this small driver is passed on the command line.
        assert!(BOOTSTRAP.len() > 20_000);
        assert!(BOOTSTRAP_DRIVER.len() < 1_000);
        assert!(BOOTSTRAP_DRIVER.contains("require(\"./bootstrap.cjs\")"));
        assert!(BOOTSTRAP_DRIVER.contains("ensureRuntime()"));
    }

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
            "C:\\venv\\Scripts\\python.EXE",
            "PYTHON.EXE",
            "Python3.12",
        ] {
            assert!(looks_like_python(path), "{path}");
        }
        for path in [
            "/bin/sh",
            "python-lsp-server",
            "Python-lsp-server",
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
