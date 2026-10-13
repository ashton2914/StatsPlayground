use crate::{error::AppError, models::mcp::McpSettings};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use jsonc_parser::{
    cst::{CstInputValue, CstObject, CstRootNode},
    ParseOptions,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
};

pub(crate) fn failure(message: &str) -> AppError {
    AppError::InvalidParam(message.to_owned())
}
fn io_error(_: std::io::Error) -> AppError {
    failure("Workspace file operation failed. Check folder permissions.")
}

pub struct ConfigEdit {
    pub bytes: String,
    pub action: &'static str,
    pub confirmation_required: bool,
    pub current_endpoint: Option<String>,
}

fn options() -> ParseOptions {
    ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    }
}
fn parse(source: &str) -> Result<CstRootNode, AppError> {
    CstRootNode::parse(source, &options())
        .map_err(|error| failure(&format!("Malformed MCP JSONC: {error}")))
}
fn unique_keys(object: &CstObject) -> Result<(), AppError> {
    let mut names = HashSet::new();
    for property in object.properties() {
        let name = property
            .decoded_name()
            .ok_or_else(|| failure("Invalid JSONC property"))?;
        if let Some(value) = property.value() {
            unique_nested_keys(&value)?;
        }
        if !names.insert(name) {
            return Err(failure(
                "Duplicate JSONC property; resolve ambiguity before launching.",
            ));
        }
    }
    Ok(())
}
fn unique_nested_keys(value: &jsonc_parser::cst::CstNode) -> Result<(), AppError> {
    if let Some(object) = value.as_object() {
        unique_keys(&object)?;
    }
    if let Some(array) = value.as_array() {
        for element in array.elements() {
            unique_nested_keys(&element)?;
        }
    }
    Ok(())
}
fn managed(settings: &McpSettings) -> Value {
    json!({"type":"http", "url":format!("http://127.0.0.1:{}/mcp", settings.port), "headers":{"Authorization":format!("Bearer {}",settings.token)}})
}
fn input(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(v) => CstInputValue::Bool(*v),
        Value::Number(v) => CstInputValue::Number(v.to_string()),
        Value::String(v) => CstInputValue::String(v.clone()),
        Value::Array(v) => CstInputValue::Array(v.iter().map(input).collect()),
        Value::Object(v) => {
            CstInputValue::Object(v.iter().map(|(k, v)| (k.clone(), input(v))).collect())
        }
    }
}
#[cfg(test)]
pub fn merge_config(source: Option<&str>, settings: &McpSettings) -> Result<ConfigEdit, AppError> {
    merge_for_format(source, settings, ConfigFormat::Legacy)
}
fn merge_for_format(
    source: Option<&str>,
    settings: &McpSettings,
    format: ConfigFormat,
) -> Result<ConfigEdit, AppError> {
    let cst = parse(source.unwrap_or("{}\n"))?;
    let object = cst
        .value()
        .and_then(|v| v.as_object())
        .ok_or_else(|| failure("MCP configuration must be an object."))?;
    unique_keys(&object)?;
    let servers = object
        .object_value_or_create(format.server_key())
        .ok_or_else(|| failure("MCP servers must be an object."))?;
    unique_keys(&servers)?;
    let current = servers.get("sp-mcp");
    let legacy = servers.get("StatsPlayground");
    if current.is_some() && legacy.is_some() {
        return Err(failure("Both sp-mcp and StatsPlayground entries exist; resolve the conflicting server aliases before launching."));
    }
    let property = current.or(legacy.clone());
    let old = property
        .clone()
        .and_then(|p| p.value())
        .and_then(|v| v.to_serde_value());
    let intended = managed(settings);
    if legacy.is_none() && old.as_ref() == Some(&intended) {
        return Ok(ConfigEdit {
            bytes: source.unwrap_or_default().to_owned(),
            action: "unchanged",
            confirmation_required: false,
            current_endpoint: Some(format!("http://127.0.0.1:{}/mcp", settings.port)),
        });
    }
    // Arbitrary URLs may contain passwords, query tokens or private file paths.
    let current_endpoint = old.as_ref().map(|_| "Different endpoint".to_owned());
    if let Some(property) = property {
        let name = property
            .name()
            .and_then(|name| name.as_string_lit())
            .ok_or_else(|| failure("Invalid managed server property name."))?;
        name.set_raw_value("\"sp-mcp\"".to_owned());
        property.set_value(input(&intended));
    } else {
        servers.append("sp-mcp", input(&intended));
    }
    let bytes = cst.to_string();
    let verified = parse(&bytes)?
        .value()
        .and_then(|v| v.to_serde_value())
        .ok_or_else(|| failure("Cannot verify MCP configuration."))?;
    if verified[format.server_key()]["sp-mcp"] != intended {
        return Err(failure("MCP configuration verification failed."));
    }
    Ok(ConfigEdit {
        bytes,
        action: if old.is_some() {
            "replaceManagedEntry"
        } else if source.is_some() {
            "merge"
        } else {
            "create"
        },
        confirmation_required: old.is_some(),
        current_endpoint,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConfigFormat {
    Portable,
    Legacy,
}
impl ConfigFormat {
    fn path(self) -> &'static str {
        match self {
            Self::Portable => ".mcp.json",
            Self::Legacy => ".vscode/mcp.json",
        }
    }
    fn filename(self) -> &'static str {
        match self {
            Self::Portable => ".mcp.json",
            Self::Legacy => "mcp.json",
        }
    }
    fn server_key(self) -> &'static str {
        match self {
            Self::Portable => "mcpServers",
            Self::Legacy => "servers",
        }
    }
}
fn has_managed_entry(source: &str, format: ConfigFormat) -> Result<bool, AppError> {
    let cst = parse(source)?;
    let object = cst
        .value()
        .and_then(|v| v.as_object())
        .ok_or_else(|| failure("MCP configuration must be an object."))?;
    unique_keys(&object)?;
    let value = cst
        .value()
        .and_then(|v| v.to_serde_value())
        .ok_or_else(|| failure("Cannot read MCP configuration."))?;
    if let Some(servers) = value.get(format.server_key()) {
        let servers = servers
            .as_object()
            .ok_or_else(|| failure("MCP servers must be an object."))?;
        if servers.contains_key("sp-mcp") && servers.contains_key("StatsPlayground") {
            return Err(failure("Both sp-mcp and StatsPlayground entries exist; resolve the conflicting server aliases before launching."));
        }
        Ok(servers.contains_key("sp-mcp") || servers.contains_key("StatsPlayground"))
    } else {
        Ok(false)
    }
}

#[derive(Clone, PartialEq, Eq)]
struct GitState {
    root: PathBuf,
    relative: String,
    exclude: PathBuf,
}

pub struct Workspace {
    pub canonical: PathBuf,
    selected: PathBuf,
    directory: Dir,
    identity: same_file::Handle,
    vscode_identity: Option<same_file::Handle>,
    pub source: Option<String>,
    alternate_source: Option<String>,
    format: ConfigFormat,
    git: Option<GitState>,
}
fn git(path: &Path, args: &[&str]) -> Result<Output, AppError> {
    Command::new("git")
        .arg("--no-pager")
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .map_err(|_| {
            failure("Cannot inspect Git protection. Install Git or select a non-Git folder.")
        })
}
fn git_text(path: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = git(path, args)?;
    if !output.status.success() {
        return Err(failure("Git protection inspection failed."));
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim_end_matches(['\r', '\n']).to_owned())
        .map_err(|_| failure("Git path is not valid UTF-8."))
}
fn classify_git(path: &Path, configuration_path: &str) -> Result<Option<GitState>, AppError> {
    // Outside Git, no Git process is needed. A .git entry also covers linked worktrees.
    if !path.ancestors().any(|p| p.join(".git").exists()) {
        return Ok(None);
    }
    let root = PathBuf::from(git_text(path, &["rev-parse", "--show-toplevel"])?);
    let relative = path
        .strip_prefix(&root)
        .map_err(|_| failure("Git workspace path mismatch."))?
        .join(configuration_path);
    let relative = relative
        .to_str()
        .ok_or_else(|| failure("Git path is not valid UTF-8."))?
        .replace('\\', "/");
    if !git(&root, &["ls-files", "-z", "--", &relative])?
        .stdout
        .is_empty()
    {
        return Err(failure("The workspace MCP configuration is Git-tracked. Remove it from tracking before storing a local credential."));
    }
    let exclude = PathBuf::from(git_text(
        &root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    )?);
    Ok(Some(GitState {
        root,
        relative,
        exclude,
    }))
}
fn reject_link(directory: &Dir, name: &str) -> Result<(), AppError> {
    match directory.symlink_metadata(name) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(failure("Symlink workspace configuration is unsafe."));
            }
            #[cfg(windows)]
            {
                use cap_std::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(failure("Reparse-point workspace configuration is unsafe."));
                }
            }
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error(error)),
    }
}
fn read_file(directory: &Dir, name: &str) -> Result<Option<String>, AppError> {
    reject_link(directory, name)?;
    match directory.read_to_string(name) {
        Ok(s) if s.len() <= 1024 * 1024 => Ok(Some(s)),
        Ok(_) => Err(failure("MCP configuration exceeds the 1 MiB limit.")),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error(e)),
    }
}
fn read_legacy(directory: &Dir) -> Result<Option<String>, AppError> {
    reject_link(directory, ".vscode")?;
    let vscode = match directory.open_dir(".vscode") {
        Ok(d) => d,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_error(e)),
    };
    read_file(&vscode, "mcp.json")
}
impl Workspace {
    pub fn inspect(path: &Path) -> Result<Self, AppError> {
        if !path.is_absolute() {
            return Err(failure("Select an existing absolute directory."));
        }
        let canonical = fs::canonicalize(path)
            .map_err(|_| failure("The selected folder is missing or inaccessible."))?;
        let directory = Dir::open_ambient_dir(&canonical, ambient_authority()).map_err(io_error)?;
        let identity =
            same_file::Handle::from_file(directory.try_clone().map_err(io_error)?.into_std_file())
                .map_err(io_error)?;
        let portable = read_file(&directory, ".mcp.json")?;
        let legacy = read_legacy(&directory)?;
        if let (Some(root), Some(old)) = (&portable, &legacy) {
            has_managed_entry(root, ConfigFormat::Portable)?;
            if has_managed_entry(old, ConfigFormat::Legacy)? {
                return Err(failure("A legacy sp-mcp or StatsPlayground entry remains alongside .mcp.json. Complete its migration or resolve the duplicate configuration before launching."));
            }
        }
        let (format, source, alternate_source) = if portable.is_some() || legacy.is_none() {
            (ConfigFormat::Portable, portable, legacy)
        } else {
            (ConfigFormat::Legacy, legacy, portable)
        };
        let vscode_identity = match directory.open_dir(".vscode") {
            Ok(vscode) => {
                Some(same_file::Handle::from_file(vscode.into_std_file()).map_err(io_error)?)
            }
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            Err(e) => return Err(io_error(e)),
        };
        let git = classify_git(&canonical, format.path())?;
        Ok(Self {
            canonical,
            selected: path.to_owned(),
            directory,
            identity,
            vscode_identity,
            source,
            alternate_source,
            format,
            git,
        })
    }
    pub fn configuration_path(&self) -> &'static str {
        self.format.path()
    }
    pub fn merge_config(&self, settings: &McpSettings) -> Result<ConfigEdit, AppError> {
        merge_for_format(self.source.as_deref(), settings, self.format)
    }
    pub fn git_status(&self) -> &'static str {
        if self.git.is_some() {
            "localExclude"
        } else {
            "nonGit"
        }
    }
    pub fn validate(&self) -> Result<(), AppError> {
        self.validate_directory(self.vscode_identity.as_ref())
    }
    fn validate_directory(&self, expected: Option<&same_file::Handle>) -> Result<(), AppError> {
        let current = Self::inspect(&self.selected)?;
        if current.canonical != self.canonical
            || current.identity != self.identity
            || current.source != self.source
            || current.alternate_source != self.alternate_source
            || current.format != self.format
            || current.git != self.git
            || current.vscode_identity.as_ref() != expected
        {
            return Err(failure("Launch plan is stale. Select the folder again."));
        }
        Ok(())
    }
    pub fn protect_git(&self) -> Result<(), AppError> {
        self.validate()?;
        let Some(state) = &self.git else {
            return Ok(());
        };
        if git(&state.root, &["check-ignore", "-q", "--", &state.relative])?
            .status
            .success()
        {
            return Ok(());
        }
        let original = match fs::read_to_string(&state.exclude) {
            Ok(v) => v,
            Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
            Err(e) => return Err(io_error(e)),
        };
        let newline = if original.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        };
        // Git ignore patterns need escaping for literal file names.
        let escaped: String = state
            .relative
            .chars()
            .flat_map(|c| {
                if "\\*?[] #!".contains(c) {
                    vec!['\\', c]
                } else {
                    vec![c]
                }
            })
            .collect();
        let mut updated = original.clone();
        if !updated.is_empty() && !updated.ends_with('\n') {
            updated.push_str(newline);
        }
        updated.push_str(&format!("/{escaped}{newline}"));
        let parent = state
            .exclude
            .parent()
            .ok_or_else(|| failure("Git exclude path is invalid."))?;
        fs::create_dir_all(parent).map_err(io_error)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
        temp.write_all(updated.as_bytes()).map_err(io_error)?;
        temp.as_file().sync_all().map_err(io_error)?;
        temp.persist(&state.exclude)
            .map_err(|e| io_error(e.error))?;
        if !git(&state.root, &["check-ignore", "-q", "--", &state.relative])?
            .status
            .success()
        {
            return Err(failure(
                "Git did not ignore the credential file. No token was written.",
            ));
        }
        Ok(())
    }
    pub fn write(&self, bytes: &[u8]) -> Result<(), AppError> {
        self.write_verified(bytes, |directory| {
            if directory.read(self.format.filename()).map_err(io_error)? != bytes {
                return Err(failure("Configuration read-back failed."));
            }
            Ok(())
        })
    }
    fn write_verified(
        &self,
        bytes: &[u8],
        verify: impl FnOnce(&Dir) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.validate()?;
        if let Some(state) = &self.git {
            if !git(&state.root, &["check-ignore", "-q", "--", &state.relative])?
                .status
                .success()
            {
                return Err(failure("Credential file is not ignored by Git."));
            }
        }
        let filename = self.format.filename();
        let directory = match self.format {
            ConfigFormat::Portable => self.directory.try_clone().map_err(io_error)?,
            ConfigFormat::Legacy => {
                reject_link(&self.directory, ".vscode")?;
                self.directory.open_dir(".vscode").map_err(io_error)?
            }
        };
        reject_link(&directory, filename)?;
        let directory_identity =
            same_file::Handle::from_file(directory.try_clone().map_err(io_error)?.into_std_file())
                .map_err(io_error)?;
        self.validate()?;
        if self.format == ConfigFormat::Legacy
            && self.vscode_identity.as_ref() != Some(&directory_identity)
        {
            return Err(failure("Launch plan is stale. Select the folder again."));
        }
        let original_permissions = directory.metadata(filename).ok().map(|m| m.permissions());
        let temp = format!(".mcp-{}.tmp", uuid::Uuid::new_v4());
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = directory.open_with(&temp, &options).map_err(io_error)?;
            let identity =
                same_file::Handle::from_file(file.try_clone().map_err(io_error)?.into_std())
                    .map_err(io_error)?;
            file.write_all(bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            self.validate()?;
            directory
                .rename(&temp, &directory, filename)
                .map_err(io_error)?;
            let verification = verify(&directory).and_then(|()| {
                let current = Self::inspect(&self.selected)?;
                if current.canonical != self.canonical
                    || current.identity != self.identity
                    || current.vscode_identity != self.vscode_identity
                    || current.format != self.format
                    || current.alternate_source != self.alternate_source
                    || current.source.as_deref().map(str::as_bytes) != Some(bytes)
                    || current.git != self.git
                {
                    return Err(failure(
                        "Workspace changed during configuration replacement.",
                    ));
                }
                Ok(())
            });
            if verification.is_err() {
                reject_link(&directory, filename)?;
                let current = same_file::Handle::from_file(
                    directory.open(filename).map_err(io_error)?.into_std(),
                )
                .map_err(io_error)?;
                if current != identity {
                    return Err(failure("Configuration verification failed and target changed; rollback could not safely proceed."));
                }
                if let Some(original) = &self.source {
                    let mut restore = directory
                        .open_with(&temp, &options)
                        .map_err(|_| failure("Configuration rollback failed."))?;
                    restore
                        .write_all(original.as_bytes())
                        .map_err(|_| failure("Configuration rollback failed."))?;
                    if let Some(permissions) = original_permissions {
                        restore
                            .set_permissions(permissions)
                            .map_err(|_| failure("Configuration rollback failed."))?;
                    }
                    restore
                        .sync_all()
                        .map_err(|_| failure("Configuration rollback failed."))?;
                    directory
                        .rename(&temp, &directory, filename)
                        .map_err(|_| failure("Configuration rollback failed."))?;
                    if directory.read(filename).map_err(io_error)? != original.as_bytes() {
                        return Err(failure("Configuration rollback verification failed."));
                    }
                } else {
                    directory
                        .remove_file(filename)
                        .map_err(|_| failure("Configuration rollback failed."))?;
                }
                return Err(failure(
                    "Configuration verification failed. The configuration transaction was rolled back.",
                ));
            }
            Ok(())
        })();
        let _ = directory.remove_file(&temp);
        result
    }
}
#[cfg(test)]
mod portable_tests {
    use super::*;

    #[test]
    fn portable_schema_preserves_unrelated_content_and_is_idempotent() {
        let root = tempfile::TempDir::new().unwrap();
        let source = "{\n // keep portable\n \"unknown\":  42,\n \"mcpServers\": {\"Other\": {\"type\":\"http\",\"url\":\"https://example.com\"},},\n}\n";
        fs::write(root.path().join(".mcp.json"), source).unwrap();
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(32),
        };
        let workspace = Workspace::inspect(root.path()).unwrap();
        let edit = workspace.merge_config(&settings).unwrap();
        assert!(edit.bytes.contains("// keep portable"));
        assert!(edit.bytes.contains("\"unknown\":  42"));
        assert!(edit
            .bytes
            .contains("\"Other\": {\"type\":\"http\",\"url\":\"https://example.com\"}"));
        let value = parse(&edit.bytes)
            .unwrap()
            .value()
            .unwrap()
            .to_serde_value()
            .unwrap();
        assert_eq!(value["mcpServers"]["sp-mcp"], managed(&settings));
        assert!(value.get("servers").is_none());
        workspace.write(edit.bytes.as_bytes()).unwrap();
        let again = Workspace::inspect(root.path())
            .unwrap()
            .merge_config(&settings)
            .unwrap();
        assert_eq!(again.action, "unchanged");
        assert_eq!(again.bytes, edit.bytes);
        for source in [
            r#"{"mcpServers":[]}"#,
            r#"{"mcpServers":{},"mcpServers":{}}"#,
            r#"{"mcpServers":{"StatsPlayground":{},"StatsPlayground":{}}}"#,
        ] {
            assert!(merge_for_format(Some(source), &settings, ConfigFormat::Portable).is_err());
        }
    }

    #[test]
    fn portable_root_detached_after_replace_rolls_back() {
        for existing in [false, true] {
            let temporary = tempfile::TempDir::new().unwrap();
            let root = temporary.path().join("workspace");
            let moved = temporary.path().join("moved");
            fs::create_dir(&root).unwrap();
            if existing {
                fs::write(root.join(".mcp.json"), "{}").unwrap();
            }
            let workspace = Workspace::inspect(&root).unwrap();
            assert!(workspace
                .write_verified(b"credential", |_| {
                    fs::rename(&root, &moved).unwrap();
                    fs::create_dir(&root).unwrap();
                    Ok(())
                })
                .is_err());
            if existing {
                assert_eq!(fs::read_to_string(moved.join(".mcp.json")).unwrap(), "{}");
            } else {
                assert!(!moved.join(".mcp.json").exists());
            }
            assert!(!root.join(".mcp.json").exists());
        }
    }

    #[test]
    fn new_workspace_writes_portable_file_without_creating_legacy_directory() {
        let root = tempfile::TempDir::new().unwrap();
        let workspace = Workspace::inspect(root.path()).unwrap();
        workspace.write(br#"{"mcpServers":{}}"#).unwrap();
        assert_eq!(
            fs::read(root.path().join(".mcp.json")).unwrap(),
            br#"{"mcpServers":{}}"#
        );
        assert!(!root.path().join(".vscode").exists());
    }

    #[test]
    fn migrated_root_configuration_takes_priority_without_touching_legacy() {
        let root = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(
            root.path().join(".vscode/mcp.json"),
            r#"{"servers":{"Other":{}}}"#,
        )
        .unwrap();
        let source = r#"{"mcpServers":{"StatsPlayground":{"type":"http"}}}"#;
        fs::write(root.path().join(".mcp.json"), source).unwrap();
        let workspace = Workspace::inspect(root.path()).unwrap();
        assert_eq!(workspace.source.as_deref(), Some(source));
        workspace.write(br#"{"mcpServers":{}}"#).unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join(".vscode/mcp.json")).unwrap(),
            r#"{"servers":{"Other":{}}}"#
        );
    }

    #[test]
    fn duplicate_managed_servers_across_formats_are_refused() {
        let root = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(
            root.path().join(".vscode/mcp.json"),
            r#"{"servers":{"StatsPlayground":{}}}"#,
        )
        .unwrap();
        fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"StatsPlayground":{}}}"#,
        )
        .unwrap();
        assert!(Workspace::inspect(root.path()).is_err());
    }

    #[test]
    fn portable_file_with_only_other_servers_does_not_duplicate_legacy_managed_entry() {
        let root = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(
            root.path().join(".vscode/mcp.json"),
            r#"{"servers":{"StatsPlayground":{}}}"#,
        )
        .unwrap();
        fs::write(
            root.path().join(".mcp.json"),
            r#"{"mcpServers":{"Other":{}}}"#,
        )
        .unwrap();
        assert!(
            Workspace::inspect(root.path()).is_err(),
            "must refuse before starting a server or preparing a second managed entry"
        );
    }

    #[test]
    fn migration_after_preview_invalidates_legacy_plan() {
        let root = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(root.path().join(".vscode/mcp.json"), "{}").unwrap();
        let workspace = Workspace::inspect(root.path()).unwrap();
        fs::write(root.path().join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        assert!(workspace.write(b"credential").is_err());
        assert_eq!(
            fs::read_to_string(root.path().join(".vscode/mcp.json")).unwrap(),
            "{}"
        );
    }

    #[test]
    fn portable_git_exclusion_is_verified_and_tracked_file_refused() {
        let root = tempfile::TempDir::new().unwrap();
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.path())
            .status()
            .unwrap()
            .success());
        let workspace = Workspace::inspect(root.path()).unwrap();
        workspace.protect_git().unwrap();
        assert!(git(root.path(), &["check-ignore", "-q", "--", ".mcp.json"])
            .unwrap()
            .status
            .success());
        workspace.write(b"{}").unwrap();
        assert!(Command::new("git")
            .args(["add", "-f", ".mcp.json"])
            .current_dir(root.path())
            .status()
            .unwrap()
            .success());
        assert!(Workspace::inspect(root.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn portable_symlink_is_refused_without_touching_target() {
        let root = tempfile::TempDir::new().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".mcp.json")).unwrap();
        assert!(Workspace::inspect(root.path()).is_err());
        assert_eq!(fs::read(outside.path()).unwrap(), b"");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn settings() -> crate::models::mcp::McpSettings {
        crate::models::mcp::McpSettings {
            port: 48123,
            token: "a".repeat(32),
        }
    }

    #[test]
    fn source_aware_merge_preserves_unrelated_text_and_is_idempotent() {
        let source = "{\n // keep\n \"inputs\": [],\n \"unknown\":  42,\n \"servers\": { \"Other\": {\"command\":\"x\"}, },\n}\n";
        let merged = merge_config(Some(source), &settings()).unwrap();
        assert_eq!(merged.action, "merge");
        assert!(!merged.confirmation_required);
        for fragment in [
            "// keep",
            "\"inputs\": []",
            "\"unknown\":  42",
            "\"Other\": {\"command\":\"x\"}",
        ] {
            assert!(merged.bytes.contains(fragment), "{fragment}");
        }
        let again = merge_config(Some(&merged.bytes), &settings()).unwrap();
        assert_eq!(again.action, "unchanged");
        assert_eq!(again.bytes, merged.bytes);
    }

    #[test]
    fn conflict_requires_approval_and_endpoint_summary_redacts_arbitrary_urls() {
        let source = r#"{"servers":{"StatsPlayground":{"url":"https://secret@example.com/private?token=secret"}}}"#;
        let merged = merge_config(Some(source), &settings()).unwrap();
        assert!(merged.confirmation_required);
        assert_eq!(
            merged.current_endpoint.as_deref(),
            Some("Different endpoint")
        );
        assert_eq!(merged.action, "replaceManagedEntry");
    }

    #[test]
    fn malformed_or_ambiguous_config_is_rejected() {
        for source in [
            "{broken",
            "[]",
            "",
            r#"{"servers":[]}"#,
            r#"{"servers":{},"servers":{}}"#,
            r#"{"servers":{"StatsPlayground":{},"StatsPlayground":{}}}"#,
        ] {
            assert!(merge_config(Some(source), &settings()).is_err(), "{source}");
        }
    }

    #[test]
    fn atomic_creation_and_private_permissions() {
        let directory = TempDir::new().unwrap();
        let workspace = Workspace::inspect(directory.path()).unwrap();
        let merged = merge_config(None, &settings()).unwrap();
        workspace.write(merged.bytes.as_bytes()).unwrap();
        assert_eq!(
            std::fs::read(directory.path().join(".mcp.json")).unwrap(),
            merged.bytes.as_bytes()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.path().join(".mcp.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(workspace.write(b"{}").is_err()); // source changed since inspection
    }

    fn git(path: &std::path::Path, args: &[&str]) {
        assert!(std::process::Command::new("git")
            .arg("--no-pager")
            .args(["-c", "core.fsmonitor=false"])
            .args(args)
            .current_dir(path)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn nested_git_workspace_is_excluded_and_tracked_config_refused() {
        let directory = TempDir::new().unwrap();
        git(directory.path(), &["init", "--quiet"]);
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let workspace = Workspace::inspect(&nested).unwrap();
        workspace.protect_git().unwrap();
        workspace.protect_git().unwrap();
        let exclude = std::fs::read_to_string(directory.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches("/nested/.mcp.json").count(), 1);
        workspace
            .write(merge_config(None, &settings()).unwrap().bytes.as_bytes())
            .unwrap();
        git(directory.path(), &["add", "-f", "nested/.mcp.json"]);
        assert!(Workspace::inspect(&nested).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let directory = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join(".vscode")).unwrap();
        assert!(Workspace::inspect(directory.path()).is_err());
        assert!(!outside.path().join("mcp.json").exists());
    }
}

#[cfg(test)]
mod rollback_tests {
    use super::*;
    #[test]
    fn failed_readback_restores_existing_bytes_and_removes_new_file() {
        for existing in [false, true] {
            let root = tempfile::TempDir::new().unwrap();
            fs::create_dir(root.path().join(".vscode")).unwrap();
            let path = root.path().join(".mcp.json");
            if existing {
                fs::write(&path, "{\"inputs\":[]}").unwrap();
            }
            let workspace = Workspace::inspect(root.path()).unwrap();
            assert!(workspace
                .write_verified(b"{}", |_| Err(failure("Injected readback failure")))
                .is_err());
            if existing {
                assert_eq!(fs::read_to_string(&path).unwrap(), "{\"inputs\":[]}");
            } else {
                assert!(!path.exists());
            }
        }
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[test]
    fn replaced_configuration_directory_invalidates_plan_even_with_same_bytes() {
        let root = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(root.path().join(".vscode/mcp.json"), "{}").unwrap();
        let workspace = Workspace::inspect(root.path()).unwrap();
        fs::rename(root.path().join(".vscode"), outside.path().join("moved")).unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(root.path().join(".vscode/mcp.json"), "{}").unwrap();
        assert!(workspace.write(b"credential").is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("moved/mcp.json")).unwrap(),
            "{}"
        );
    }
}

#[cfg(test)]
mod post_replace_tests {
    use super::*;
    #[test]
    fn directory_detached_after_replace_rolls_back_credential() {
        let root = tempfile::TempDir::new().unwrap();
        let outside = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(root.path().join(".vscode/mcp.json"), "{}").unwrap();
        let workspace = Workspace::inspect(root.path()).unwrap();
        let result = workspace.write_verified(b"credential", |_| {
            fs::rename(root.path().join(".vscode"), outside.path().join("moved")).unwrap();
            fs::create_dir(root.path().join(".vscode")).unwrap();
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("moved/mcp.json")).unwrap(),
            "{}"
        );
        assert!(!root.path().join(".vscode/mcp.json").exists());
    }
}

#[cfg(test)]
mod linked_git_tests {
    use super::*;
    fn command(directory: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("--no-pager")
            .args(args)
            .current_dir(directory)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(output.status.success(), "Git fixture failed");
    }
    #[test]
    fn linked_worktree_resolves_git_metadata_and_preserves_exclude_crlf() {
        let temporary = tempfile::TempDir::new().unwrap();
        let repo = temporary.path().join("repo");
        let linked = temporary.path().join("linked");
        fs::create_dir(&repo).unwrap();
        command(&repo, &["init", "--quiet"]);
        command(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        command(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                linked.to_str().unwrap(),
            ],
        );
        fs::write(
            repo.join(".git/info/exclude"),
            "# local rules\r\n/cache\r\n",
        )
        .unwrap();
        let workspace = Workspace::inspect(&linked).unwrap();
        workspace.protect_git().unwrap();
        workspace.protect_git().unwrap();
        assert_eq!(
            fs::read_to_string(repo.join(".git/info/exclude")).unwrap(),
            "# local rules\r\n/cache\r\n/.mcp.json\r\n"
        );
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(32),
        };
        workspace
            .write(merge_config(None, &settings).unwrap().bytes.as_bytes())
            .unwrap();
        assert!(git(&linked, &["check-ignore", "-q", "--", ".mcp.json"])
            .unwrap()
            .status
            .success());
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    #[test]
    fn old_server_alias_migrates_with_confirmation_and_preserves_jsonc() {
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(32),
        };
        for format in [ConfigFormat::Portable, ConfigFormat::Legacy] {
            let source = format!("{{\n // keep comment\n \"{}\": {{\n // managed alias\n \"StatsPlayground\": {{}}, \"Other\": {{\"command\":\"keep\"}},}},\n \"inputs\": [],\n}}", format.server_key());
            let edit = merge_for_format(Some(&source), &settings, format).unwrap();
            assert!(edit.confirmation_required);
            assert_eq!(edit.action, "replaceManagedEntry");
            assert!(edit.bytes.contains("// keep comment"));
            assert!(edit.bytes.contains("// managed alias"));
            assert!(edit.bytes.contains("\"Other\": {\"command\":\"keep\"}"));
            let value = parse(&edit.bytes)
                .unwrap()
                .value()
                .unwrap()
                .to_serde_value()
                .unwrap();
            assert!(value[format.server_key()].get("StatsPlayground").is_none());
            assert_eq!(value[format.server_key()]["sp-mcp"], managed(&settings));
            assert_eq!(value["inputs"], json!([]));
        }
    }

    #[test]
    fn both_server_aliases_are_rejected_even_when_values_match() {
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(32),
        };
        for format in [ConfigFormat::Portable, ConfigFormat::Legacy] {
            let source = json!({format.server_key(): {"StatsPlayground": managed(&settings), "sp-mcp": managed(&settings)}}).to_string();
            assert!(merge_for_format(Some(&source), &settings, format).is_err());
        }
    }

    #[test]
    fn new_alias_in_legacy_file_blocks_duplicate_root_configuration() {
        let root = tempfile::TempDir::new().unwrap();
        fs::create_dir(root.path().join(".vscode")).unwrap();
        fs::write(
            root.path().join(".vscode/mcp.json"),
            r#"{"servers":{"sp-mcp":{}}}"#,
        )
        .unwrap();
        fs::write(root.path().join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        assert!(Workspace::inspect(root.path()).is_err());
    }

    #[test]
    fn new_config_matches_vscode_http_contract() {
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(32),
        };
        let value: Value =
            serde_json::from_str(&merge_config(None, &settings).unwrap().bytes).unwrap();
        assert_eq!(value["servers"]["sp-mcp"]["type"], "http");
        assert_eq!(
            value["servers"]["sp-mcp"]["url"],
            "http://127.0.0.1:48123/mcp"
        );
        assert_eq!(
            value["servers"]["sp-mcp"]["headers"]["Authorization"],
            "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }
    #[test]
    fn duplicate_authentication_headers_cannot_be_treated_as_identical() {
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(32),
        };
        let source = r#"{"servers":{"StatsPlayground":{"type":"http","url":"http://127.0.0.1:48123/mcp","headers":{"Authorization":"other","Authorization":"Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}"#;
        assert!(merge_config(Some(source), &settings).is_err());
    }
}
