use std::{
    fs,
    io::{ErrorKind, Write},
    path::PathBuf,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::{error::AppError, models::mcp::McpSettings};

const SETTINGS_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
struct UserSettingsV1 {
    version: u32,
    mcp: McpSettings,
}

pub struct McpSettingsService {
    settings_directory: PathBuf,
    settings_path: PathBuf,
}

impl McpSettingsService {
    pub fn new(home_directory: PathBuf) -> Self {
        let settings_directory = home_directory.join(".statsplayground");
        let settings_path = settings_directory.join("settings.json");
        Self {
            settings_directory,
            settings_path,
        }
    }

    pub fn load(&self) -> Result<Option<McpSettings>, AppError> {
        let contents = match fs::read_to_string(&self.settings_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(AppError::FileIO(error.to_string())),
        };
        let envelope: UserSettingsV1 =
            serde_json::from_str(&contents).map_err(|error| AppError::FileIO(error.to_string()))?;
        if envelope.version != SETTINGS_VERSION {
            return Err(AppError::FileIO(format!(
                "unsupported settings version: {}",
                envelope.version
            )));
        }
        Self::validate(&envelope.mcp)?;
        Ok(Some(envelope.mcp))
    }

    pub fn save(&self, settings: &McpSettings) -> Result<(), AppError> {
        Self::validate(settings)?;
        fs::create_dir_all(&self.settings_directory)
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        #[cfg(unix)]
        fs::set_permissions(&self.settings_directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| AppError::FileIO(error.to_string()))?;

        let envelope = UserSettingsV1 {
            version: SETTINGS_VERSION,
            mcp: settings.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&envelope)
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        let mut temporary = NamedTempFile::new_in(&self.settings_directory)
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        #[cfg(unix)]
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        temporary
            .write_all(&bytes)
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        temporary
            .persist(&self.settings_path)
            .map_err(|error| AppError::FileIO(error.error.to_string()))?;
        Ok(())
    }

    pub fn validate(settings: &McpSettings) -> Result<(), AppError> {
        if settings.port == 0 {
            return Err(AppError::InvalidParam(
                "MCP port must be between 1 and 65535".to_string(),
            ));
        }
        let token = settings.token.as_bytes();
        if !(32..=256).contains(&token.len()) {
            return Err(AppError::InvalidParam(
                "MCP token must be between 32 and 256 bytes".to_string(),
            ));
        }
        if !token.iter().all(|byte| (b'!'..=b'~').contains(byte)) {
            return Err(AppError::InvalidParam(
                "MCP token must contain only visible ASCII characters".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use crate::{error::AppError, models::mcp::McpSettings};

    use super::McpSettingsService;

    fn service() -> (TempDir, McpSettingsService) {
        let home = TempDir::new().expect("temporary home");
        let service = McpSettingsService::new(home.path().to_path_buf());
        (home, service)
    }

    fn write_settings(home: &TempDir, contents: &str) {
        let directory = home.path().join(".statsplayground");
        fs::create_dir_all(&directory).expect("create settings directory");
        fs::write(directory.join("settings.json"), contents).expect("write settings");
    }

    #[test]
    fn missing_settings_load_as_none_and_saved_settings_round_trip() {
        let (_home, service) = service();

        assert_eq!(service.load().expect("missing settings"), None);

        service
            .save(&McpSettings {
                port: 48123,
                token: "a".repeat(32),
            })
            .expect("save");
        assert_eq!(
            service.load().expect("reload"),
            Some(McpSettings {
                port: 48123,
                token: "a".repeat(32)
            })
        );
    }

    #[test]
    fn malformed_json_is_a_file_io_error() {
        let (home, service) = service();
        write_settings(&home, "{not json");

        assert!(matches!(service.load(), Err(AppError::FileIO(_))));
    }

    #[test]
    fn unsupported_version_is_a_file_io_error() {
        let (home, service) = service();
        write_settings(
            &home,
            r#"{"version":2,"mcp":{"port":48123,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#,
        );

        assert!(matches!(service.load(), Err(AppError::FileIO(_))));
    }

    #[test]
    fn zero_port_is_rejected() {
        let (_home, service) = service();
        let settings = McpSettings {
            port: 0,
            token: "a".repeat(32),
        };

        assert!(matches!(
            McpSettingsService::validate(&settings),
            Err(AppError::InvalidParam(_))
        ));
        assert!(matches!(
            service.save(&settings),
            Err(AppError::InvalidParam(_))
        ));
    }

    #[test]
    fn token_shorter_than_32_bytes_is_rejected() {
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(31),
        };

        assert!(matches!(
            McpSettingsService::validate(&settings),
            Err(AppError::InvalidParam(_))
        ));
    }

    #[test]
    fn token_longer_than_256_bytes_is_rejected() {
        let settings = McpSettings {
            port: 48123,
            token: "a".repeat(257),
        };

        assert!(matches!(
            McpSettingsService::validate(&settings),
            Err(AppError::InvalidParam(_))
        ));
    }

    #[test]
    fn whitespace_token_is_rejected() {
        let settings = McpSettings {
            port: 48123,
            token: format!("{} ", "a".repeat(31)),
        };

        assert!(matches!(
            McpSettingsService::validate(&settings),
            Err(AppError::InvalidParam(_))
        ));
    }

    #[test]
    fn control_character_token_is_rejected() {
        let settings = McpSettings {
            port: 48123,
            token: format!("{}\u{7f}", "a".repeat(31)),
        };

        assert!(matches!(
            McpSettingsService::validate(&settings),
            Err(AppError::InvalidParam(_))
        ));
    }

    #[test]
    fn non_ascii_token_is_rejected() {
        let settings = McpSettings {
            port: 48123,
            token: format!("{}é", "a".repeat(31)),
        };

        assert!(matches!(
            McpSettingsService::validate(&settings),
            Err(AppError::InvalidParam(_))
        ));
    }

    #[test]
    fn loading_invalid_settings_is_an_explicit_error() {
        let (home, service) = service();
        write_settings(
            &home,
            r#"{"version":1,"mcp":{"port":0,"token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#,
        );

        assert!(matches!(service.load(), Err(AppError::InvalidParam(_))));
    }

    #[test]
    fn save_replaces_existing_valid_settings() {
        let (_home, service) = service();
        service
            .save(&McpSettings {
                port: 48123,
                token: "a".repeat(32),
            })
            .expect("initial save");

        let replacement = McpSettings {
            port: 49123,
            token: "b".repeat(32),
        };
        service.save(&replacement).expect("replace settings");

        assert_eq!(service.load().expect("load replacement"), Some(replacement));
    }

    #[cfg(unix)]
    #[test]
    fn saved_settings_have_private_unix_permissions() {
        let (home, service) = service();
        service
            .save(&McpSettings {
                port: 48123,
                token: "a".repeat(32),
            })
            .expect("save");

        let directory_mode = fs::metadata(home.path().join(".statsplayground"))
            .expect("directory metadata")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(home.path().join(".statsplayground/settings.json"))
            .expect("file metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
    }
}
