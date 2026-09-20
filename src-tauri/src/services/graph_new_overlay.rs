use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::models::graph_new::GraphNewOverlayGroup;

pub const MAX_OVERLAY_GROUPS: usize = 64;
pub const MAX_OVERLAY_LABEL_BYTES: usize = 512;
pub const ALL_ROWS_GROUP_CODE: u16 = 0;
const MISSING_LABEL: &str = "(Missing)";
const MISSING_COLOR: [u8; 4] = [107, 114, 128, 255];

fn missing_identity() -> String {
    hashed_identity("missing")
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayCatalog {
    pub active: bool,
    pub groups: Vec<GraphNewOverlayGroup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupedLineSegment {
    pub indices: [u32; 2],
    pub group_code: u16,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GroupedMeanPoint {
    pub group_code: u16,
    pub x: f64,
    pub y: f64,
}

impl OverlayCatalog {
    pub fn group(&self, code: u16) -> Option<&GraphNewOverlayGroup> {
        self.groups.iter().find(|group| group.code == code)
    }

    pub fn contains_code(&self, code: u16) -> bool {
        if self.active {
            self.group(code).is_some()
        } else {
            code == ALL_ROWS_GROUP_CODE
        }
    }

    pub(crate) fn resident_bytes(&self) -> u64 {
        self.groups.capacity() as u64 * std::mem::size_of::<GraphNewOverlayGroup>() as u64
            + self
                .groups
                .iter()
                .map(|group| group.id.capacity() as u64 + group.label.capacity() as u64)
                .sum::<u64>()
    }

    pub fn rgba_bytes(&self, code: u16) -> Option<[u8; 4]> {
        if self.active {
            self.group(code).map(|group| group.color)
        } else if code == ALL_ROWS_GROUP_CODE {
            None
        } else {
            None
        }
    }

    pub(crate) fn validate_for_restore(&self, total_finite_rows: u64) -> Result<(), AppError> {
        if !self.active {
            return if self.groups.is_empty() {
                Ok(())
            } else {
                Err(AppError::Stats("graph_new_invalid_cache".into()))
            };
        }

        if self.groups.is_empty() || self.groups.len() > MAX_OVERLAY_GROUPS {
            return Err(AppError::Stats("graph_new_invalid_cache".into()));
        }

        let mut ids = std::collections::BTreeSet::new();
        let mut codes = std::collections::BTreeSet::new();
        let mut missing_groups = 0usize;
        let mut total_rows = 0u64;
        let mut sorted = self.groups.clone();
        sorted.sort_by(|left, right| {
            left.missing
                .cmp(&right.missing)
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.id.cmp(&right.id))
        });
        if sorted != self.groups {
            return Err(AppError::Stats("graph_new_invalid_cache".into()));
        }

        for group in &self.groups {
            if !valid_group_id(&group.id)
                || group.label.len() > MAX_OVERLAY_LABEL_BYTES
                || usize::from(group.code) >= MAX_OVERLAY_GROUPS
                || group.total_rows == 0
                || !ids.insert(group.id.clone())
                || !codes.insert(group.code)
            {
                return Err(AppError::Stats("graph_new_invalid_cache".into()));
            }
            if group.missing {
                missing_groups += 1;
                if missing_groups > 1
                    || group.id != missing_identity()
                    || group.label != MISSING_LABEL
                    || group.color != MISSING_COLOR
                {
                    return Err(AppError::Stats("graph_new_invalid_cache".into()));
                }
            }
            total_rows = total_rows
                .checked_add(group.total_rows)
                .ok_or_else(|| AppError::Stats("graph_new_invalid_cache".into()))?;
        }

        if total_rows != total_finite_rows {
            return Err(AppError::Stats("graph_new_invalid_cache".into()));
        }

        Ok(())
    }
}

pub struct OverlayDictionary {
    sql_type: String,
    groups_by_identity: BTreeMap<String, u16>,
    groups: Vec<GraphNewOverlayGroup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnabledOverlayMask(u64);

impl EnabledOverlayMask {
    pub fn from_hidden(catalog: &OverlayCatalog, hidden_ids: &[String]) -> Result<Self, AppError> {
        if !catalog.active {
            return if hidden_ids.is_empty() {
                Ok(Self(1u64 << ALL_ROWS_GROUP_CODE))
            } else {
                Err(AppError::InvalidParam(
                    "graph_new_overlay_group_missing".to_string(),
                ))
            };
        }

        let mut enabled = 0u64;
        for group in &catalog.groups {
            enabled |= bit_for(group.code)?;
        }
        for hidden_id in hidden_ids {
            let Some(group) = catalog.groups.iter().find(|group| group.id == *hidden_id) else {
                return Err(AppError::InvalidParam(
                    "graph_new_overlay_group_missing".to_string(),
                ));
            };
            enabled &= !bit_for(group.code)?;
        }
        Ok(Self(enabled))
    }

    pub fn is_enabled(self, code: u16) -> bool {
        bit_for(code)
            .map(|bit| self.0 & bit != 0)
            .unwrap_or(false)
    }

    pub fn bits(self) -> u64 {
        self.0
    }
}

impl OverlayDictionary {
    pub fn new(sql_type: &str) -> Self {
        Self {
            sql_type: sql_type.to_string(),
            groups_by_identity: BTreeMap::new(),
            groups: Vec::new(),
        }
    }

    pub fn observe(&mut self, value: Option<&str>) -> Result<u16, AppError> {
        let (digest_input, label, missing) = match value {
            Some(label) => {
                if label.len() > MAX_OVERLAY_LABEL_BYTES {
                    return Err(AppError::InvalidParam(
                        "graph_new_overlay_value_too_large".to_string(),
                    ));
                }
                (
                    format!("value:{}:{label}", self.sql_type),
                    label.to_string(),
                    false,
                )
            }
            None => ("missing".to_string(), MISSING_LABEL.to_string(), true),
        };

        let id = hashed_identity(&digest_input);
        if let Some(code) = self.groups_by_identity.get(&id).copied() {
            let index = usize::from(code);
            self.groups[index].total_rows = self.groups[index]
                .total_rows
                .checked_add(1)
                .ok_or_else(|| {
                    AppError::InvalidParam("graph-new overlay row count overflow".to_string())
                })?;
            return Ok(code);
        }

        if self.groups.len() >= MAX_OVERLAY_GROUPS {
            return Err(AppError::InvalidParam(
                "graph_new_overlay_too_many_groups".to_string(),
            ));
        }

        let code = u16::try_from(self.groups.len()).map_err(|_| {
            AppError::InvalidParam("graph-new overlay code overflow".to_string())
        })?;
        let group = GraphNewOverlayGroup {
            id: id.clone(),
            code,
            label,
            color: if missing {
                MISSING_COLOR
            } else {
                color_from_digest_input(&digest_input)
            },
            total_rows: 1,
            missing,
        };
        self.groups_by_identity.insert(id, code);
        self.groups.push(group);
        Ok(code)
    }

    pub fn finish(&self) -> OverlayCatalog {
        let mut groups = self.groups.clone();
        groups.sort_by(|left, right| {
            left.missing
                .cmp(&right.missing)
                .then_with(|| left.label.cmp(&right.label))
                .then_with(|| left.id.cmp(&right.id))
        });
        OverlayCatalog {
            active: !groups.is_empty(),
            groups,
        }
    }
}

fn bit_for(code: u16) -> Result<u64, AppError> {
    if usize::from(code) >= MAX_OVERLAY_GROUPS {
        return Err(AppError::InvalidParam(
            "graph-new overlay code is out of range".to_string(),
        ));
    }
    Ok(1u64 << u32::from(code))
}

fn valid_group_id(id: &str) -> bool {
    id.len() == 71
        && id.starts_with("sha256:")
        && id
            .as_bytes()
            .iter()
            .skip(7)
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn hashed_identity(input: &str) -> String {
    format!("sha256:{}", hex_digest(input.as_bytes()))
}

fn color_from_digest_input(input: &str) -> [u8; 4] {
    let digest = Sha256::digest(input.as_bytes());
    let hue_seed = digest.iter().fold(0u64, |seed, byte| {
        seed.wrapping_mul(257).wrapping_add(u64::from(*byte))
    });
    hsl_to_rgba((hue_seed % 360) as f64, 0.62, 0.52)
}

fn hsl_to_rgba(hue: f64, saturation: f64, lightness: f64) -> [u8; 4] {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let hue_section = hue / 60.0;
    let x = chroma * (1.0 - (hue_section % 2.0 - 1.0).abs());
    let (r1, g1, b1) = if hue_section < 1.0 {
        (chroma, x, 0.0)
    } else if hue_section < 2.0 {
        (x, chroma, 0.0)
    } else if hue_section < 3.0 {
        (0.0, chroma, x)
    } else if hue_section < 4.0 {
        (0.0, x, chroma)
    } else if hue_section < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let m = lightness - chroma / 2.0;
    [
        ((r1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        255,
    ]
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
    use crate::error::AppError;

    use super::OverlayDictionary;

    #[test]
    fn dictionary_distinguishes_missing_literal_and_stabilizes_color() {
        let mut dictionary = OverlayDictionary::new("VARCHAR");
        let missing = dictionary.observe(None).expect("missing");
        let literal = dictionary.observe(Some("(Missing)")).expect("literal");
        let a = dictionary.observe(Some("A")).expect("A");
        assert_ne!(missing, literal);
        let catalog = dictionary.finish();
        assert_eq!(catalog.groups.iter().map(|group| group.total_rows).sum::<u64>(), 3);
        let first = catalog.group(a).expect("A").color;

        let mut rebuilt = OverlayDictionary::new("VARCHAR");
        let rebuilt_a = rebuilt.observe(Some("A")).expect("A");
        assert_eq!(rebuilt.finish().group(rebuilt_a).expect("A").color, first);
    }

    #[test]
    fn dictionary_rejects_sixty_fifth_group_and_oversized_label() {
        let mut dictionary = OverlayDictionary::new("VARCHAR");
        for value in 0..64 {
            dictionary
                .observe(Some(&format!("group-{value}")))
                .expect("within cap");
        }
        assert!(matches!(
            dictionary.observe(Some("group-64")),
            Err(AppError::InvalidParam(message))
                if message == "graph_new_overlay_too_many_groups"
        ));
        assert!(matches!(
            dictionary.observe(Some(&"x".repeat(513))),
            Err(AppError::InvalidParam(message))
                if message == "graph_new_overlay_value_too_large"
        ));
    }
}
