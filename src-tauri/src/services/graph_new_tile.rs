use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::models::graph_new_data::{GRAPH_NEW_MAX_LEVELS, GRAPH_NEW_MAX_TILE_POINTS};
use crate::services::graph_new_key::GRAPH_NEW_TILE_FORMAT_VERSION;

const GRAPH_NEW_TILE_MAGIC: [u8; 4] = *b"GNTL";
const GRAPH_NEW_TILE_HEADER_BYTES: usize = 68;
const GRAPH_NEW_TILE_CHECKSUM_BYTES: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewTileHeader {
    pub magic: [u8; 4],
    pub format_version: u16,
    pub level: u16,
    pub tile_x: u32,
    pub tile_y: u32,
    pub point_count: u32,
    pub total_source_count: u64,
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
    pub payload_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphNewTile {
    pub header: GraphNewTileHeader,
    pub row_ids: Vec<i64>,
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub counts: Vec<u32>,
}

impl GraphNewTileHeader {
    #[cfg(test)]
    pub fn new_for_test(
        level: u16,
        tile_x: u32,
        tile_y: u32,
        point_count: u32,
        total_source_count: u64,
    ) -> Self {
        Self {
            magic: GRAPH_NEW_TILE_MAGIC,
            format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
            level,
            tile_x,
            tile_y,
            point_count,
            total_source_count,
            x_min: tile_x as f64,
            x_max: tile_x as f64 + 1.0,
            y_min: tile_y as f64,
            y_max: tile_y as f64 + 1.0,
            payload_bytes: 0,
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<GraphNewTile, AppError> {
        if bytes.len() < GRAPH_NEW_TILE_HEADER_BYTES + GRAPH_NEW_TILE_CHECKSUM_BYTES {
            return Err(AppError::InvalidParam(
                "graph-new tile buffer is too short".to_string(),
            ));
        }

        let mut offset = 0usize;
        let magic = read_array_4(bytes, &mut offset)?;
        if magic != GRAPH_NEW_TILE_MAGIC {
            return Err(AppError::InvalidParam(
                "graph-new tile magic mismatch".to_string(),
            ));
        }
        let format_version = read_u16(bytes, &mut offset)?;
        if format_version != GRAPH_NEW_TILE_FORMAT_VERSION {
            return Err(AppError::InvalidParam(
                "graph-new tile version mismatch".to_string(),
            ));
        }
        let level = read_u16(bytes, &mut offset)?;
        let tile_x = read_u32(bytes, &mut offset)?;
        let tile_y = read_u32(bytes, &mut offset)?;
        let point_count = read_u32(bytes, &mut offset)?;
        let total_source_count = read_u64(bytes, &mut offset)?;
        let x_min = read_f64(bytes, &mut offset)?;
        let x_max = read_f64(bytes, &mut offset)?;
        let y_min = read_f64(bytes, &mut offset)?;
        let y_max = read_f64(bytes, &mut offset)?;
        let payload_bytes = read_u64(bytes, &mut offset)?;

        validate_header_fields(level, tile_x, tile_y, point_count, total_source_count)?;
        validate_bounds(x_min, x_max, y_min, y_max)?;

        let expected_payload_bytes = payload_length(point_count as usize)?;
        if payload_bytes != expected_payload_bytes {
            return Err(AppError::InvalidParam(
                "graph-new tile payload length mismatch".to_string(),
            ));
        }
        let expected_total_len = GRAPH_NEW_TILE_HEADER_BYTES
            .checked_add(payload_bytes as usize)
            .and_then(|value| value.checked_add(GRAPH_NEW_TILE_CHECKSUM_BYTES))
            .ok_or_else(|| {
                AppError::InvalidParam("graph-new tile byte length overflow".to_string())
            })?;
        if bytes.len() != expected_total_len {
            return Err(AppError::InvalidParam(
                "graph-new tile byte length mismatch".to_string(),
            ));
        }

        let (prefix, checksum) = bytes.split_at(bytes.len() - GRAPH_NEW_TILE_CHECKSUM_BYTES);
        let expected = Sha256::digest(prefix);
        if expected.as_slice() != checksum {
            return Err(AppError::InvalidParam(
                "graph-new tile checksum mismatch".to_string(),
            ));
        }

        let row_ids = read_i64_vec(prefix, &mut offset, point_count as usize)?;
        let xs = read_f64_vec(prefix, &mut offset, point_count as usize)?;
        let ys = read_f64_vec(prefix, &mut offset, point_count as usize)?;
        let counts = read_u32_vec(prefix, &mut offset, point_count as usize)?;
        if offset != prefix.len() {
            return Err(AppError::InvalidParam(
                "graph-new tile trailing bytes mismatch".to_string(),
            ));
        }

        validate_payload(
            &row_ids,
            &xs,
            &ys,
            &counts,
            total_source_count,
            x_min,
            x_max,
            y_min,
            y_max,
        )?;

        Ok(GraphNewTile {
            header: GraphNewTileHeader {
                magic,
                format_version,
                level,
                tile_x,
                tile_y,
                point_count,
                total_source_count,
                x_min,
                x_max,
                y_min,
                y_max,
                payload_bytes,
            },
            row_ids,
            xs,
            ys,
            counts,
        })
    }
}

impl GraphNewTile {
    pub fn encode(&self) -> Result<Vec<u8>, AppError> {
        validate_bounds(
            self.header.x_min,
            self.header.x_max,
            self.header.y_min,
            self.header.y_max,
        )?;
        if self.header.magic != GRAPH_NEW_TILE_MAGIC {
            return Err(AppError::InvalidParam(
                "graph-new tile magic mismatch".to_string(),
            ));
        }
        if self.header.format_version != GRAPH_NEW_TILE_FORMAT_VERSION {
            return Err(AppError::InvalidParam(
                "graph-new tile version mismatch".to_string(),
            ));
        }
        let point_count = self.row_ids.len();
        let point_count_u32 = u32::try_from(point_count).map_err(|_| {
            AppError::InvalidParam("graph-new tile point count overflow".to_string())
        })?;
        validate_header_fields(
            self.header.level,
            self.header.tile_x,
            self.header.tile_y,
            point_count_u32,
            self.header.total_source_count,
        )?;
        if self.xs.len() != point_count || self.ys.len() != point_count || self.counts.len() != point_count {
            return Err(AppError::InvalidParam(
                "graph-new tile column lengths must match".to_string(),
            ));
        }
        if self.header.point_count != point_count_u32 {
            return Err(AppError::InvalidParam(
                "graph-new tile point count mismatch".to_string(),
            ));
        }
        validate_payload(
            &self.row_ids,
            &self.xs,
            &self.ys,
            &self.counts,
            self.header.total_source_count,
            self.header.x_min,
            self.header.x_max,
            self.header.y_min,
            self.header.y_max,
        )?;

        let payload_bytes = payload_length(point_count)?;
        if self.header.payload_bytes != 0 && self.header.payload_bytes != payload_bytes {
            return Err(AppError::InvalidParam(
                "graph-new tile payload byte count mismatch".to_string(),
            ));
        }

        let mut bytes = Vec::with_capacity(
            GRAPH_NEW_TILE_HEADER_BYTES + payload_bytes as usize + GRAPH_NEW_TILE_CHECKSUM_BYTES,
        );
        bytes.extend_from_slice(&GRAPH_NEW_TILE_MAGIC);
        push_u16(&mut bytes, GRAPH_NEW_TILE_FORMAT_VERSION);
        push_u16(&mut bytes, self.header.level);
        push_u32(&mut bytes, self.header.tile_x);
        push_u32(&mut bytes, self.header.tile_y);
        push_u32(&mut bytes, self.header.point_count);
        push_u64(&mut bytes, self.header.total_source_count);
        push_f64(&mut bytes, self.header.x_min);
        push_f64(&mut bytes, self.header.x_max);
        push_f64(&mut bytes, self.header.y_min);
        push_f64(&mut bytes, self.header.y_max);
        push_u64(&mut bytes, payload_bytes);
        for row_id in &self.row_ids {
            push_i64(&mut bytes, *row_id);
        }
        for value in &self.xs {
            push_f64(&mut bytes, *value);
        }
        for value in &self.ys {
            push_f64(&mut bytes, *value);
        }
        for value in &self.counts {
            push_u32(&mut bytes, *value);
        }
        let checksum = Sha256::digest(&bytes);
        bytes.extend_from_slice(checksum.as_slice());
        Ok(bytes)
    }
}

fn validate_bounds(x_min: f64, x_max: f64, y_min: f64, y_max: f64) -> Result<(), AppError> {
    if !x_min.is_finite() || !x_max.is_finite() || !y_min.is_finite() || !y_max.is_finite() {
        return Err(AppError::InvalidParam(
            "graph-new tile bounds must be finite".to_string(),
        ));
    }
    if x_min > x_max || y_min > y_max {
        return Err(AppError::InvalidParam(
            "graph-new tile bounds are inverted".to_string(),
        ));
    }
    Ok(())
}

fn validate_header_fields(
    level: u16,
    tile_x: u32,
    tile_y: u32,
    point_count: u32,
    total_source_count: u64,
) -> Result<(), AppError> {
    if point_count == 0 {
        return Err(AppError::InvalidParam(
            "graph-new tile must retain at least one point".to_string(),
        ));
    }
    if point_count > GRAPH_NEW_MAX_TILE_POINTS {
        return Err(AppError::InvalidParam(format!(
            "graph-new tile point count exceeds {GRAPH_NEW_MAX_TILE_POINTS}"
        )));
    }
    if total_source_count == 0 {
        return Err(AppError::InvalidParam(
            "graph-new tile source count must be positive".to_string(),
        ));
    }
    if level > u16::from(GRAPH_NEW_MAX_LEVELS) {
        return Err(AppError::InvalidParam(
            "graph-new tile level exceeds the supported maximum".to_string(),
        ));
    }
    let tiles_per_axis = 1u32
        .checked_shl(u32::from(level))
        .ok_or_else(|| AppError::InvalidParam("graph-new tile level overflow".to_string()))?;
    if tile_x >= tiles_per_axis || tile_y >= tiles_per_axis {
        return Err(AppError::InvalidParam(
            "graph-new tile address is outside the level domain".to_string(),
        ));
    }
    Ok(())
}

fn validate_payload(
    row_ids: &[i64],
    xs: &[f64],
    ys: &[f64],
    counts: &[u32],
    total_source_count: u64,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
) -> Result<(), AppError> {
    if row_ids.len() != xs.len() || xs.len() != ys.len() || ys.len() != counts.len() {
        return Err(AppError::InvalidParam(
            "graph-new tile column lengths must match".to_string(),
        ));
    }
    let mut count_sum = 0u64;
    for index in 0..row_ids.len() {
        if row_ids[index] <= 0 {
            return Err(AppError::InvalidParam(
                "graph-new tile row IDs must be positive".to_string(),
            ));
        }
        if !xs[index].is_finite() || !ys[index].is_finite() {
            return Err(AppError::InvalidParam(
                "graph-new tile coordinates must be finite".to_string(),
            ));
        }
        if xs[index] < x_min || xs[index] > x_max || ys[index] < y_min || ys[index] > y_max {
            return Err(AppError::InvalidParam(
                "graph-new tile coordinates must stay within header bounds".to_string(),
            ));
        }
        if counts[index] == 0 {
            return Err(AppError::InvalidParam(
                "graph-new tile counts must be positive".to_string(),
            ));
        }
        count_sum = count_sum
            .checked_add(u64::from(counts[index]))
            .ok_or_else(|| AppError::InvalidParam("graph-new tile count overflow".to_string()))?;
    }
    if count_sum != total_source_count {
        return Err(AppError::InvalidParam(
            "graph-new tile source count mismatch".to_string(),
        ));
    }
    Ok(())
}

fn payload_length(point_count: usize) -> Result<u64, AppError> {
    let point_count = u64::try_from(point_count)
        .map_err(|_| AppError::InvalidParam("graph-new tile point count overflow".to_string()))?;
    point_count
        .checked_mul(28)
        .ok_or_else(|| AppError::InvalidParam("graph-new tile payload overflow".to_string()))
}

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_i64(bytes: &mut Vec<u8>, value: i64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn push_f64(bytes: &mut Vec<u8>, value: f64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn read_exact<'a>(bytes: &'a [u8], offset: &mut usize, len: usize) -> Result<&'a [u8], AppError> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| AppError::InvalidParam("graph-new tile offset overflow".to_string()))?;
    if end > bytes.len() {
        return Err(AppError::InvalidParam(
            "graph-new tile buffer ended unexpectedly".to_string(),
        ));
    }
    let slice = &bytes[*offset..end];
    *offset = end;
    Ok(slice)
}

fn read_array_4(bytes: &[u8], offset: &mut usize) -> Result<[u8; 4], AppError> {
    let slice = read_exact(bytes, offset, 4)?;
    Ok([slice[0], slice[1], slice[2], slice[3]])
}

fn read_u16(bytes: &[u8], offset: &mut usize) -> Result<u16, AppError> {
    let slice = read_exact(bytes, offset, 2)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32, AppError> {
    let slice = read_exact(bytes, offset, 4)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_u64(bytes: &[u8], offset: &mut usize) -> Result<u64, AppError> {
    let slice = read_exact(bytes, offset, 8)?;
    Ok(u64::from_le_bytes([
        slice[0],
        slice[1],
        slice[2],
        slice[3],
        slice[4],
        slice[5],
        slice[6],
        slice[7],
    ]))
}

fn read_i64(bytes: &[u8], offset: &mut usize) -> Result<i64, AppError> {
    let slice = read_exact(bytes, offset, 8)?;
    Ok(i64::from_le_bytes([
        slice[0],
        slice[1],
        slice[2],
        slice[3],
        slice[4],
        slice[5],
        slice[6],
        slice[7],
    ]))
}

fn read_f64(bytes: &[u8], offset: &mut usize) -> Result<f64, AppError> {
    let slice = read_exact(bytes, offset, 8)?;
    Ok(f64::from_le_bytes([
        slice[0],
        slice[1],
        slice[2],
        slice[3],
        slice[4],
        slice[5],
        slice[6],
        slice[7],
    ]))
}

fn read_i64_vec(bytes: &[u8], offset: &mut usize, count: usize) -> Result<Vec<i64>, AppError> {
    (0..count).map(|_| read_i64(bytes, offset)).collect()
}

fn read_f64_vec(bytes: &[u8], offset: &mut usize, count: usize) -> Result<Vec<f64>, AppError> {
    (0..count).map(|_| read_f64(bytes, offset)).collect()
}

fn read_u32_vec(bytes: &[u8], offset: &mut usize, count: usize) -> Result<Vec<u32>, AppError> {
    (0..count).map(|_| read_u32(bytes, offset)).collect()
}

#[cfg(test)]
mod tests {
    use super::{
        push_f64, push_i64, push_u16, push_u32, push_u64, GraphNewTile, GraphNewTileHeader,
        GRAPH_NEW_TILE_CHECKSUM_BYTES, GRAPH_NEW_TILE_MAGIC,
    };
    use crate::models::graph_new_data::GRAPH_NEW_MAX_LEVELS;
    use crate::services::graph_new_key::GRAPH_NEW_TILE_FORMAT_VERSION;
    use sha2::{Digest, Sha256};

    fn sample_tile() -> GraphNewTile {
        GraphNewTile {
            header: GraphNewTileHeader {
                magic: GRAPH_NEW_TILE_MAGIC,
                format_version: GRAPH_NEW_TILE_FORMAT_VERSION,
                level: 2,
                tile_x: 3,
                tile_y: 1,
                point_count: 2,
                total_source_count: 12,
                x_min: 1.0,
                x_max: 3.0,
                y_min: 3.5,
                y_max: 4.75,
                payload_bytes: 0,
            },
            row_ids: vec![11, 12],
            xs: vec![1.25, 2.5],
            ys: vec![3.75, 4.5],
            counts: vec![5, 7],
        }
    }

    fn encode_raw_tile(
        level: u16,
        tile_x: u32,
        tile_y: u32,
        total_source_count: u64,
        x_min: f64,
        x_max: f64,
        y_min: f64,
        y_max: f64,
        row_ids: &[i64],
        xs: &[f64],
        ys: &[f64],
        counts: &[u32],
    ) -> Vec<u8> {
        let point_count = u32::try_from(row_ids.len()).expect("point count");
        let payload_bytes = (row_ids.len() * 28) as u64;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&GRAPH_NEW_TILE_MAGIC);
        push_u16(&mut bytes, GRAPH_NEW_TILE_FORMAT_VERSION);
        push_u16(&mut bytes, level);
        push_u32(&mut bytes, tile_x);
        push_u32(&mut bytes, tile_y);
        push_u32(&mut bytes, point_count);
        push_u64(&mut bytes, total_source_count);
        push_f64(&mut bytes, x_min);
        push_f64(&mut bytes, x_max);
        push_f64(&mut bytes, y_min);
        push_f64(&mut bytes, y_max);
        push_u64(&mut bytes, payload_bytes);
        for row_id in row_ids {
            push_i64(&mut bytes, *row_id);
        }
        for value in xs {
            push_f64(&mut bytes, *value);
        }
        for value in ys {
            push_f64(&mut bytes, *value);
        }
        for value in counts {
            push_u32(&mut bytes, *value);
        }
        let checksum = Sha256::digest(&bytes);
        bytes.extend_from_slice(checksum.as_slice());
        bytes
    }

    fn overwrite_with_checksum(
        mut bytes: Vec<u8>,
        update: impl FnOnce(&mut Vec<u8>),
    ) -> Vec<u8> {
        let payload_end = bytes.len() - GRAPH_NEW_TILE_CHECKSUM_BYTES;
        bytes.truncate(payload_end);
        update(&mut bytes);
        let checksum = Sha256::digest(&bytes);
        bytes.extend_from_slice(checksum.as_slice());
        bytes
    }

    #[test]
    fn tile_round_trip_is_little_endian_and_checksum_guarded() {
        let encoded = sample_tile().encode().expect("encode tile");
        let decoded = GraphNewTileHeader::decode(&encoded).expect("decode tile");

        assert_eq!(decoded.header.point_count, 2);
        assert_eq!(decoded.row_ids, vec![11, 12]);
        assert_eq!(decoded.counts, vec![5, 7]);
    }

    #[test]
    fn tile_decode_rejects_bad_magic_version_length_and_checksum() {
        let encoded = sample_tile().encode().expect("encode tile");

        let bad_magic = overwrite_with_checksum(encoded.clone(), |bytes| {
            bytes[0] = b'X';
        });
        assert!(GraphNewTileHeader::decode(&bad_magic).is_err());

        let bad_version = overwrite_with_checksum(encoded.clone(), |bytes| {
            bytes[4] = 9;
        });
        assert!(GraphNewTileHeader::decode(&bad_version).is_err());

        let truncated = encoded[..encoded.len() - 1].to_vec();
        assert!(GraphNewTileHeader::decode(&truncated).is_err());

        let mut bad_checksum = encoded;
        let last = bad_checksum.len() - 1;
        bad_checksum[last] ^= 0x5a;
        assert!(GraphNewTileHeader::decode(&bad_checksum).is_err());
    }

    #[test]
    fn tile_decode_rejects_zero_points_invalid_levels_and_points_outside_header_bounds() {
        let zero_points = encode_raw_tile(2, 0, 0, 0, 0.0, 1.0, 0.0, 1.0, &[], &[], &[], &[]);
        let zero_error = GraphNewTileHeader::decode(&zero_points).expect_err("zero point tile must fail");
        assert!(zero_error.to_string().contains("at least one point"));

        let invalid_level = encode_raw_tile(
            u16::from(GRAPH_NEW_MAX_LEVELS) + 1,
            0,
            0,
            1,
            0.0,
            1.0,
            0.0,
            1.0,
            &[7],
            &[0.25],
            &[0.75],
            &[1],
        );
        let invalid_level_error =
            GraphNewTileHeader::decode(&invalid_level).expect_err("invalid level must fail");
        assert!(invalid_level_error.to_string().contains("level"));

        let outside_bounds = encode_raw_tile(
            2,
            0,
            0,
            1,
            0.0,
            1.0,
            0.0,
            1.0,
            &[7],
            &[1.5],
            &[0.75],
            &[1],
        );
        let bounds_error = GraphNewTileHeader::decode(&outside_bounds)
            .expect_err("out of bounds payload must fail");
        assert!(bounds_error.to_string().contains("bounds"));
    }
}