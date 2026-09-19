use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::models::graph_new_data::{
    GRAPH_NEW_DEFAULT_DOMAIN_POLICY, GRAPH_NEW_MAX_LEVELS, GRAPH_NEW_MAX_TILE_POINTS,
};

pub const GRAPH_NEW_RENDERER_CONTRACT_VERSION: u16 = 2;
pub const GRAPH_NEW_TILE_FORMAT_VERSION: u16 = 2;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum RetentionPolicy {
    Bounded,
    Lossless,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphKeyParts {
    pub dataset_id: String,
    pub dataset_generation: u64,
    pub x_column_id: String,
    pub y_column_id: String,
    pub overlay_column_id: Option<String>,
    pub filter_identity: Option<String>,
    pub renderer_contract_version: u16,
    pub tile_format_version: u16,
    pub domain_policy: String,
    pub levels: u8,
    pub max_tile_points: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphKeyDiagnostics {
    pub dataset_id: String,
    pub dataset_generation: u64,
    pub x_column_id: String,
    pub y_column_id: String,
    pub overlay_state: String,
    pub overlay_hash_prefix: Option<String>,
    pub filter_state: String,
    pub filter_hash_prefix: Option<String>,
    pub renderer_contract_version: u16,
    pub tile_format_version: u16,
    pub domain_policy: String,
    pub levels: u8,
    pub max_tile_points: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalGraphKey<'a> {
    key_version: &'static str,
    dataset_id: &'a str,
    dataset_generation: u64,
    x_column_id: &'a str,
    y_column_id: &'a str,
    overlay_column_id: CanonicalOptionalIdentity<'a>,
    filter_identity: CanonicalFilterIdentity<'a>,
    renderer_contract_version: u16,
    tile_format_version: u16,
    domain_policy: &'a str,
    levels: u8,
    max_tile_points: u32,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CanonicalFilterIdentity<'a> {
    None,
    Hashed { sha256: &'a str },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CanonicalOptionalIdentity<'a> {
    None,
    Hashed { sha256: &'a str },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GraphKey {
    pub(crate) retention_policy: RetentionPolicy,
    pub canonical_id: String,
    pub hash_hex: String,
    pub storage_path_fragment: String,
    pub diagnostics: GraphKeyDiagnostics,
}

impl GraphKey {
    pub fn canonical(parts: &GraphKeyParts) -> Result<Self, AppError> {
        Self::with_policy(parts, RetentionPolicy::Bounded)
    }

    #[cfg(test)]
    pub(crate) fn lossless(parts: &GraphKeyParts) -> Result<Self, AppError> {
        Self::with_policy(parts, RetentionPolicy::Lossless)
    }

    fn with_policy(parts: &GraphKeyParts, retention_policy: RetentionPolicy) -> Result<Self, AppError> {
        let dataset_id = normalize_non_empty(&parts.dataset_id, "datasetId")?;
        let x_column_id = normalize_non_empty(&parts.x_column_id, "xColumnId")?;
        let y_column_id = normalize_non_empty(&parts.y_column_id, "yColumnId")?;
        let overlay_hash = match parts.overlay_column_id.as_deref() {
            None => None,
            Some(value) if value.trim().is_empty() => {
                return Err(AppError::InvalidParam(
                    "graph-new overlayColumnId must not be blank when provided".to_string(),
                ))
            }
            Some(value) => Some(hex_digest(value.as_bytes())),
        };
        if retention_policy == RetentionPolicy::Lossless && overlay_hash.is_some() {
            return Err(AppError::InvalidParam(
                "graph-new lossless cache does not support overlayColumnId".to_string(),
            ));
        }
        if parts.renderer_contract_version == 0 {
            return Err(AppError::InvalidParam(
                "graph-new renderer contract version must be positive".to_string(),
            ));
        }
        if parts.tile_format_version == 0 {
            return Err(AppError::InvalidParam(
                "graph-new tile format version must be positive".to_string(),
            ));
        }
        if parts.levels == 0 || parts.levels > GRAPH_NEW_MAX_LEVELS {
            return Err(AppError::InvalidParam(format!(
                "graph-new levels must be between 1 and {GRAPH_NEW_MAX_LEVELS}"
            )));
        }
        if parts.max_tile_points == 0 || parts.max_tile_points > GRAPH_NEW_MAX_TILE_POINTS {
            return Err(AppError::InvalidParam(format!(
                "graph-new maxTilePoints must be between 1 and {GRAPH_NEW_MAX_TILE_POINTS}"
            )));
        }
        let domain_policy = if parts.domain_policy.trim().is_empty() {
            GRAPH_NEW_DEFAULT_DOMAIN_POLICY.to_string()
        } else {
            parts.domain_policy.clone()
        };
        let filter_hash = match parts.filter_identity.as_deref() {
            None => None,
            Some(value) if value.trim().is_empty() => {
                return Err(AppError::InvalidParam(
                    "graph-new filterIdentity must not be blank when provided".to_string(),
                ))
            }
            Some(value) => Some(hex_digest(value.as_bytes())),
        };
        let canonical_id = serde_json::to_string(&CanonicalGraphKey {
            key_version: match retention_policy {
                RetentionPolicy::Bounded => "graph-new-v7-overlay-compact-exact-2100000",
                RetentionPolicy::Lossless => "graph-new-v4-lossless-research",
            },
            dataset_id: &dataset_id,
            dataset_generation: parts.dataset_generation,
            x_column_id: &x_column_id,
            y_column_id: &y_column_id,
            overlay_column_id: match overlay_hash.as_deref() {
                None => CanonicalOptionalIdentity::None,
                Some(hash) => CanonicalOptionalIdentity::Hashed { sha256: hash },
            },
            filter_identity: match filter_hash.as_deref() {
                None => CanonicalFilterIdentity::None,
                Some(hash) => CanonicalFilterIdentity::Hashed { sha256: hash },
            },
            renderer_contract_version: parts.renderer_contract_version,
            tile_format_version: parts.tile_format_version,
            domain_policy: &domain_policy,
            levels: parts.levels,
            max_tile_points: parts.max_tile_points,
        })
        .map_err(|error| {
            AppError::InvalidParam(format!(
                "graph-new canonical key serialization failed: {error}"
            ))
        })?;

        let hash_hex = hex_digest(canonical_id.as_bytes());
        let storage_path_fragment =
            format!("{}/{}/{}", &hash_hex[0..2], &hash_hex[2..4], &hash_hex[4..]);

        Ok(Self {
            retention_policy,
            canonical_id,
            hash_hex,
            storage_path_fragment,
            diagnostics: GraphKeyDiagnostics {
                dataset_id: format!("sha256:{}", hex_digest(dataset_id.as_bytes())),
                dataset_generation: parts.dataset_generation,
                x_column_id: format!("sha256:{}", hex_digest(x_column_id.as_bytes())),
                y_column_id: format!("sha256:{}", hex_digest(y_column_id.as_bytes())),
                overlay_state: if overlay_hash.is_some() {
                    "hashed".to_string()
                } else {
                    "none".to_string()
                },
                overlay_hash_prefix: overlay_hash
                    .as_ref()
                    .map(|hash| hash[..16].to_string()),
                filter_state: if filter_hash.is_some() {
                    "hashed".to_string()
                } else {
                    "none".to_string()
                },
                filter_hash_prefix: filter_hash.as_ref().map(|hash| hash[..16].to_string()),
                renderer_contract_version: parts.renderer_contract_version,
                tile_format_version: parts.tile_format_version,
                domain_policy: if domain_policy == GRAPH_NEW_DEFAULT_DOMAIN_POLICY {
                    domain_policy
                } else {
                    format!("sha256:{}", hex_digest(domain_policy.as_bytes()))
                },
                levels: parts.levels,
                max_tile_points: parts.max_tile_points,
            },
        })
    }
}

fn normalize_non_empty(value: &str, label: &str) -> Result<String, AppError> {
    if value.trim().is_empty() {
        return Err(AppError::InvalidParam(format!(
            "graph-new {label} must not be empty"
        )));
    }
    Ok(value.to_string())
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(test)]
mod tests {
    use serde_json::to_string;

    use super::{GraphKey, GraphKeyParts};

    fn sample_parts() -> GraphKeyParts {
        GraphKeyParts {
            dataset_id: "dataset-1".to_string(),
            dataset_generation: 7,
            x_column_id: "x-column".to_string(),
            y_column_id: "y-column".to_string(),
            overlay_column_id: None,
            filter_identity: Some("region=north".to_string()),
            renderer_contract_version: 2,
            tile_format_version: 2,
            domain_policy: "finite-domain-v1".to_string(),
            levels: 4,
            max_tile_points: 256,
        }
    }

    #[test]
    fn canonical_hash_is_display_name_independent_and_deterministic() {
        let key = GraphKey::canonical(&sample_parts()).expect("key");
        let same = GraphKey::canonical(&sample_parts()).expect("same key");

        assert_eq!(key.hash_hex, same.hash_hex);
        assert_eq!(key.canonical_id, same.canonical_id);
        assert!(key
            .storage_path_fragment
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '/'));
    }

    #[test]
    fn canonical_hash_changes_when_generation_or_versions_change() {
        let baseline = GraphKey::canonical(&sample_parts()).expect("baseline");

        let mut changed_generation = sample_parts();
        changed_generation.dataset_generation += 1;
        let generation_key = GraphKey::canonical(&changed_generation).expect("generation key");

        let mut changed_format = sample_parts();
        changed_format.tile_format_version += 1;
        let format_key = GraphKey::canonical(&changed_format).expect("format key");

        assert_ne!(baseline.hash_hex, generation_key.hash_hex);
        assert_ne!(baseline.hash_hex, format_key.hash_hex);
    }

    #[test]
    fn overlay_column_changes_key_but_visibility_does_not_enter_key() {
        let baseline = GraphKey::canonical(&sample_parts()).expect("baseline");
        let mut grouped = sample_parts();
        grouped.overlay_column_id = Some("lot-column".into());
        let grouped = GraphKey::canonical(&grouped).expect("grouped");
        assert_ne!(baseline.hash_hex, grouped.hash_hex);
        assert_eq!(grouped.diagnostics.overlay_state, "hashed");
    }

    #[test]
    fn canonical_key_preserves_stable_ids_and_distinguishes_missing_filter_identity() {
        let mut preserved = sample_parts();
        preserved.dataset_id = "  dataset-1  ".to_string();
        preserved.x_column_id = " x-column ".to_string();
        let preserved_key = GraphKey::canonical(&preserved).expect("preserved key");

        let mut none_filter = sample_parts();
        none_filter.filter_identity = None;
        let none_key = GraphKey::canonical(&none_filter).expect("none key");

        let mut literal_placeholder = sample_parts();
        literal_placeholder.filter_identity = Some("<none>".to_string());
        let literal_key = GraphKey::canonical(&literal_placeholder).expect("literal key");

        let canonical: serde_json::Value =
            serde_json::from_str(&preserved_key.canonical_id).expect("canonical json");
        assert_eq!(canonical["datasetId"], "  dataset-1  ");
        assert_eq!(canonical["xColumnId"], " x-column ");
        assert_ne!(none_key.hash_hex, literal_key.hash_hex);
    }

    #[test]
    fn graph_new_diagnostics_hide_all_unrestricted_strings_without_changing_identity() {
        for hostile in [
            "C:/private/data\\secret\n\r\t\0",
            "/Users/private/report.csv",
            "relative\\private/path",
            "\u{1b}[31msecret\u{7f}\u{85}\u{202e}",
        ] {
            let mut parts = sample_parts();
            parts.dataset_id = hostile.into();
            parts.x_column_id = hostile.into();
            parts.y_column_id = hostile.into();
            parts.overlay_column_id = Some(hostile.into());
            parts.domain_policy = hostile.into();
            parts.filter_identity = Some(hostile.into());
            let key = GraphKey::canonical(&parts).expect("hostile key");
            let quoted = serde_json::to_string(hostile).expect("quoted identity");
            let digest = super::hex_digest(hostile.as_bytes());
            let expected = format!(
                "{{\"keyVersion\":\"graph-new-v7-overlay-compact-exact-2100000\",\"datasetId\":{quoted},\"datasetGeneration\":7,\"xColumnId\":{quoted},\"yColumnId\":{quoted},\"overlayColumnId\":{{\"kind\":\"hashed\",\"sha256\":\"{digest}\"}},\"filterIdentity\":{{\"kind\":\"hashed\",\"sha256\":\"{digest}\"}},\"rendererContractVersion\":2,\"tileFormatVersion\":2,\"domainPolicy\":{quoted},\"levels\":4,\"maxTilePoints\":256}}"
            );
            assert_eq!(key.canonical_id, expected);
            assert_eq!(key.hash_hex, super::hex_digest(expected.as_bytes()));
            let diagnostics = &key.diagnostics;
            for opaque in [&diagnostics.dataset_id, &diagnostics.x_column_id, &diagnostics.y_column_id, &diagnostics.domain_policy] {
                assert_eq!(opaque, &format!("sha256:{digest}"));
            }
            let diagnostic_json = serde_json::to_value(diagnostics).expect("diagnostic json");
            for value in diagnostic_json
                .as_object()
                .expect("diagnostic object")
                .values()
            {
                if let Some(text) = value.as_str() {
                    assert!(text
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric()
                            || character == ':'
                            || character == '-'));
                    assert!(!text.contains("private"));
                    assert!(!text.contains("secret"));
                }
            }
            assert_eq!(diagnostics.filter_state, "hashed");
            assert_eq!(
                diagnostics.filter_hash_prefix.as_deref(),
                Some(&digest[..16])
            );
            assert_eq!(diagnostics.overlay_state, "hashed");
            assert_eq!(
                diagnostics.overlay_hash_prefix.as_deref(),
                Some(&digest[..16])
            );
        }

        let mut parts = sample_parts();
        parts.filter_identity = None;
        parts.overlay_column_id = None;
        parts.domain_policy = String::new();
        let key = GraphKey::canonical(&parts).expect("default policy");
        assert_eq!(
            key.diagnostics.domain_policy,
            crate::models::graph_new_data::GRAPH_NEW_DEFAULT_DOMAIN_POLICY
        );
        assert_eq!(key.diagnostics.filter_state, "none");
        assert_eq!(key.diagnostics.filter_hash_prefix, None);
        assert_eq!(key.diagnostics.overlay_state, "none");
        assert_eq!(key.diagnostics.overlay_hash_prefix, None);
        parts.domain_policy = "unknown-safe-policy".into();
        assert!(GraphKey::canonical(&parts)
            .expect("unknown policy")
            .diagnostics
            .domain_policy
            .starts_with("sha256:"));
    }

    #[test]
    fn canonical_key_changes_when_layout_changes_and_hides_hostile_filter_text() {
        let baseline = GraphKey::canonical(&sample_parts()).expect("baseline");

        let mut changed_levels = sample_parts();
        changed_levels.levels += 1;
        let levels_key = GraphKey::canonical(&changed_levels).expect("levels key");

        let mut changed_tile_points = sample_parts();
        changed_tile_points.max_tile_points *= 2;
        let tile_points_key = GraphKey::canonical(&changed_tile_points).expect("tile points key");

        let mut hostile_filter = sample_parts();
        hostile_filter.overlay_column_id = Some("C:/private/filters\\north\nteam=alpha".to_string());
        hostile_filter.filter_identity = Some("C:/private/filters\\north\nteam=alpha".to_string());
        let hostile_key = GraphKey::canonical(&hostile_filter).expect("hostile key");
        let diagnostics_json = to_string(&hostile_key.diagnostics).expect("diagnostics json");

        assert_ne!(baseline.hash_hex, levels_key.hash_hex);
        assert_ne!(baseline.hash_hex, tile_points_key.hash_hex);
        assert!(!diagnostics_json.contains("C:/private/filters"));
        assert!(!diagnostics_json.contains("team=alpha"));
        assert!(!hostile_key.canonical_id.contains("C:/private/filters"));
    }
}
