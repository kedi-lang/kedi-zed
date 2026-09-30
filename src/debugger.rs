use zed_extension_api::{
    self as zed,
    process::Command,
    serde_json::{json, Value},
    DebugAdapterBinary, DebugConfig, DebugRequest, DebugScenario, Result,
    StartDebuggingRequestArguments, StartDebuggingRequestArgumentsRequest,
};

pub const NAME: &str = "kedi";
const MODULE_PROBE: &str =
    "import kedi_debugger; from kedi.debugging import DebugEvent, observe_execution";

pub fn check_adapter(name: &str) -> Result<()> {
    if name != NAME {
        return Err(format!("Unsupported Kedi debug adapter: {name}"));
    }
    Ok(())
}

pub fn request_kind(config: &Value) -> Result<StartDebuggingRequestArgumentsRequest> {
    match config.get("request").and_then(Value::as_str) {
        Some("launch") => Ok(StartDebuggingRequestArgumentsRequest::Launch),
        _ => Err("Kedi requires request: launch; attach is not supported.".into()),
    }
}

fn absolute_host_path(path: &str) -> bool {
    // The WASI extension's Path parser does not recognize Windows drive roots.
    let bytes = path.as_bytes();
    std::path::Path::new(path).is_absolute()
        || path.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

pub fn launch_configuration(mut config: Value, root: &str) -> Result<Value> {
    request_kind(&config)?;
    let object = config
        .as_object_mut()
        .ok_or("Kedi debug configuration must be an object.")?;
    for key in ["python", "pythonPath", "interpreter", "pythonExecutable"] {
        if object.contains_key(key) {
            return Err(
                "Select the Python interpreter in the editor, not launch arguments.".into(),
            );
        }
    }
    let program = object
        .get("program")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && !s.contains('\0'))
        .ok_or("Kedi program must be an absolute path to a saved .kedi file.")?;
    // Zed substitutes task variables after get_dap_binary. The backend validates
    // the resulting absolute path and saved source, including $ZED_FILE.
    if !program.contains('$') && (!absolute_host_path(program) || !program.ends_with(".kedi")) {
        return Err("Kedi program must be an absolute path to a saved .kedi file.".into());
    }
    object.entry("cwd").or_insert_with(|| json!(root));
    if object["cwd"]
        .as_str()
        .is_none_or(|s| s.is_empty() || s.contains('\0'))
    {
        return Err("Kedi cwd must be a nonempty directory path.".into());
    }
    object.entry("args").or_insert_with(|| json!([]));
    if !object["args"].as_array().is_some_and(|args| {
        args.iter()
            .all(|arg| arg.as_str().is_some_and(|s| !s.contains('\0')))
    }) {
        return Err("Kedi args must be an array of strings without NUL characters.".into());
    }
    object.entry("env").or_insert_with(|| json!({}));
    if !object["env"].as_object().is_some_and(|env| {
        env.iter().all(|(name, value)| {
            !name.is_empty()
                && !name.contains(['=', '\0'])
                && (value.is_null() || value.as_str().is_some_and(|s| !s.contains('\0')))
        })
    }) {
        return Err(
            "Kedi env must map valid environment names to strings without NUL characters or null."
                .into(),
        );
    }
    object.entry("stopOnEntry").or_insert(Value::Bool(true));
    if !object["stopOnEntry"].is_boolean() {
        return Err("Kedi stopOnEntry must be a boolean.".into());
    }
    // Zed owns the top-level `adapter` field in debug.json.
    if let Some(adapter) = object.remove("kediAdapter") {
        object.insert("adapter".into(), adapter);
    }
    for key in ["adapter", "model"] {
        if let Some(value) = object.get(key) {
            if value.as_str().is_none_or(|s| s.trim().is_empty()) {
                return Err(format!("Kedi {key} must be a nonempty string."));
            }
        }
    }
    Ok(config)
}

pub fn scenario(config: DebugConfig) -> Result<DebugScenario> {
    check_adapter(&config.adapter)?;
    let DebugRequest::Launch(launch) = config.request else {
        return Err("Kedi supports launch debugging only; attach is not supported.".into());
    };
    let mut value = json!({
        "request": "launch",
        "program": launch.program,
        "args": launch.args,
        "env": launch.envs.into_iter().map(|(key, value)| (key, Value::String(value))).collect::<zed::serde_json::Map<String, Value>>(),
        "stopOnEntry": config.stop_on_entry.unwrap_or(true),
    });
    if let Some(cwd) = launch.cwd {
        value["cwd"] = json!(cwd);
    }
    Ok(DebugScenario {
        adapter: NAME.into(),
        label: config.label,
        build: None,
        config: value.to_string(),
        tcp_connection: None,
    })
}

pub fn missing_package(python: &str) -> String {
    let quoted = if cfg!(target_os = "windows") || python.contains('\\') {
        json!(python).to_string()
    } else {
        format!("'{}'", python.replace('\'', "'\\''"))
    };
    format!(
        "Cannot import kedi_debugger and required kedi.debugging hooks with selected Python {python}. \
         The debugger requires a compatible local Kedi with debugger hooks, not an older 0.4 release. \
         Verify that interpreter, then install both local packages explicitly: \
         uv pip install --python {quoted} -e /path/to/kedi -e /path/to/kedi/debugger. \
         No packages were installed by the debugger. Set lsp.kedi-lsp.settings.python_path to change Python."
    )
}

pub fn check_debugger(python: &Command) -> Result<()> {
    let output = Command::new(python.command.clone())
        .envs(python.env.clone())
        .args(["-c", MODULE_PROBE])
        .output()
        .map_err(|_| missing_package(&python.command))?;
    if output.status != Some(0) {
        // Interpreter startup output may contain secrets; never include it in errors.
        return Err(missing_package(&python.command));
    }
    Ok(())
}

pub fn binary(python: Command, config: Value, root: String) -> DebugAdapterBinary {
    DebugAdapterBinary {
        command: Some(python.command),
        arguments: vec!["-m".into(), "kedi_debugger".into(), "--stdio".into()],
        envs: python.env,
        cwd: Some(root),
        connection: None,
        request_args: StartDebuggingRequestArguments {
            configuration: config.to_string(),
            request: StartDebuggingRequestArgumentsRequest::Launch,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_defaults_and_zed_task_variables() {
        let config = launch_configuration(
            json!({"request": "launch", "program": "$ZED_FILE"}),
            "/work tree",
        )
        .unwrap();
        assert_eq!(config["program"], "$ZED_FILE");
        assert_eq!(config["cwd"], "/work tree");
        assert_eq!(config["args"], json!([]));
        assert_eq!(config["env"], json!({}));
        assert_eq!(config["stopOnEntry"], true);
        for program in [
            "C:\\work tree\\main.kedi",
            "C:/work/main.kedi",
            "\\\\host\\share\\main.kedi",
            "/work/main.kedi",
        ] {
            assert!(
                launch_configuration(json!({"request": "launch", "program": program}), "/tmp")
                    .is_ok()
            );
        }
    }

    #[test]
    fn launch_options_are_preserved_and_model_adapter_is_translated() {
        let config = launch_configuration(
            json!({"request": "launch", "program": "/work tree/main.kedi", "cwd": "/work tree",
                "args": ["--name", "two words"], "env": {"APP_MODE": "test"},
                "stopOnEntry": false, "kediAdapter": "pydantic", "model": "test-model"}),
            "/other",
        )
        .unwrap();
        assert_eq!(config["cwd"], "/work tree");
        assert_eq!(config["args"], json!(["--name", "two words"]));
        assert_eq!(config["env"], json!({"APP_MODE": "test"}));
        assert_eq!(config["stopOnEntry"], false);
        assert_eq!(config["adapter"], "pydantic");
        assert_eq!(config["model"], "test-model");
        assert!(config.get("kediAdapter").is_none());
    }

    #[test]
    fn invalid_launch_values_and_attach_are_rejected() {
        for (key, value) in [
            ("request", json!("attach")),
            ("program", json!("/tmp/main.py")),
            ("program", json!("main.kedi")),
            ("program", json!(null)),
            ("program", json!("/tmp/bad\0.kedi")),
            ("cwd", json!(false)),
            ("cwd", json!("/tmp/bad\0directory")),
            ("args", json!("--name Ada")),
            ("args", json!([1])),
            ("args", json!(["bad\0arg"])),
            ("env", json!([])),
            ("env", json!(null)),
            ("env", json!({"MODE": 1})),
            ("env", json!({"MODE": false})),
            ("env", json!({"MODE": {}})),
            ("env", json!({"": "value"})),
            ("env", json!({"A=B": "value"})),
            ("env", json!({"A\0B": null})),
            ("env", json!({"MODE": "bad\0value"})),
            ("python", json!("/other/python")),
            ("pythonPath", json!(null)),
            ("interpreter", json!("/other/python")),
            ("pythonExecutable", json!("/other/python")),
            ("stopOnEntry", json!("true")),
            ("kediAdapter", json!(true)),
            ("model", json!("")),
        ] {
            let mut config = json!({"request": "launch", "program": "/tmp/main.kedi"});
            config[key] = value;
            assert!(launch_configuration(config, "/tmp").is_err(), "{key}");
        }
        assert!(request_kind(&json!({})).is_err());
        assert!(launch_configuration(json!([]), "/tmp").is_err());
        assert!(check_adapter("debugpy").is_err());
    }

    #[test]
    fn new_process_modal_produces_a_launch_scenario() {
        let config = DebugConfig {
            label: "Kedi file".into(),
            adapter: NAME.into(),
            stop_on_entry: None,
            request: DebugRequest::Launch(zed::LaunchRequest {
                program: "/tmp/main.kedi".into(),
                cwd: None,
                args: vec!["two words".into()],
                envs: vec![("APP_MODE".into(), "test".into())],
            }),
        };
        let result = scenario(config).unwrap();
        let value: Value = zed::serde_json::from_str(&result.config).unwrap();
        assert_eq!(value["request"], "launch");
        assert_eq!(value["stopOnEntry"], true);
        assert_eq!(value["env"], json!({"APP_MODE": "test"}));
        assert!(value.get("cwd").is_none());
        assert!(result.tcp_connection.is_none());
        assert!(result.build.is_none());
    }

    #[test]
    fn stdio_uses_selected_python_and_keeps_debuggee_env_in_launch() {
        for python_path in ["/shared/editor-venv/bin/python", "/host venv/bin/python"] {
            let config = launch_configuration(
                json!({"request": "launch", "program": "/tmp/main.kedi", "env": {"APP_MODE": "test", "EMPTY": "", "REMOVE_ME": null}}),
                "/tmp",
            ).unwrap();
            assert_eq!(
                config["env"],
                json!({"APP_MODE": "test", "EMPTY": "", "REMOVE_ME": null})
            );
            let result = binary(
                Command::new(python_path).env("SHELL_ENV", "kept"),
                config.clone(),
                "/tmp".into(),
            );
            assert_eq!(result.command.as_deref(), Some(python_path));
            assert_eq!(result.arguments, ["-m", "kedi_debugger", "--stdio"]);
            assert_eq!(result.envs, vec![("SHELL_ENV".into(), "kept".into())]);
            assert_eq!(
                zed::serde_json::from_str::<Value>(&result.request_args.configuration).unwrap(),
                config
            );
            assert!(result.connection.is_none());
        }
    }

    #[test]
    fn missing_package_has_a_local_install_hint_for_the_exact_interpreter() {
        let error = missing_package("/host venv/bin/python");
        assert!(error.contains(
            "--python '/host venv/bin/python' -e /path/to/kedi -e /path/to/kedi/debugger"
        ));
        assert!(error.contains("kedi.debugging"));
        assert!(error.contains("No packages were installed"));
        assert!(!error.contains("pip install kedi-debugger"));
    }

    #[test]
    fn preflight_checks_the_runtime_hooks_used_by_the_worker() {
        assert_eq!(
            MODULE_PROBE,
            "import kedi_debugger; from kedi.debugging import DebugEvent, observe_execution"
        );
    }

    #[test]
    fn manifest_schema_exposes_only_the_launch_contract() {
        let schema: Value =
            zed::serde_json::from_str(include_str!("../debug_adapter_schemas/kedi.json")).unwrap();
        assert_eq!(schema["required"], json!(["request", "program"]));
        assert_eq!(schema["properties"]["request"]["enum"], json!(["launch"]));
        assert_eq!(schema["properties"]["stopOnEntry"]["default"], true);
        assert_eq!(
            schema["properties"]["env"]["additionalProperties"]["type"],
            json!(["string", "null"])
        );
        assert!(schema["properties"].get("kediAdapter").is_some());
        assert!(schema["properties"].get("python").is_none());
        assert_eq!(
            schema["not"]["anyOf"],
            json!([
                {"required": ["python"]}, {"required": ["pythonPath"]},
                {"required": ["interpreter"]}, {"required": ["pythonExecutable"]}
            ])
        );
        assert_eq!(
            schema["properties"]["env"]["propertyNames"]["pattern"],
            r"^[^=\u0000]+$"
        );
        for value in [
            &schema["properties"]["program"],
            &schema["properties"]["cwd"],
            &schema["properties"]["args"]["items"],
            &schema["properties"]["env"]["additionalProperties"],
        ] {
            assert_eq!(value["pattern"], r"^[^\u0000]*$");
        }
        assert!(include_str!("../extension.toml").contains("[debug_adapters.kedi]"));
    }

    #[test]
    fn extension_api_methods_are_registered_and_reject_attach() {
        use zed::Extension;
        let mut extension = crate::KediExtension::new();
        assert!(matches!(
            extension
                .dap_request_kind(NAME.into(), json!({"request": "launch"}))
                .unwrap(),
            StartDebuggingRequestArgumentsRequest::Launch,
        ));
        assert!(extension
            .dap_request_kind(NAME.into(), json!({"request": "attach"}))
            .is_err());
        assert!(extension
            .dap_config_to_scenario(DebugConfig {
                label: "Attach".into(),
                adapter: NAME.into(),
                stop_on_entry: None,
                request: DebugRequest::Attach(zed::AttachRequest {
                    process_id: Some(1)
                }),
            })
            .is_err());
    }
}
