pub(crate) const ATLAS_WIDTH: u32 = 56;
pub(crate) const ATLAS_HEIGHT: u32 = 5;
const GLYPHS: &str = "-+.0123456789e";
const ROWS: [[u8; 5]; 14] = [
    [0, 0, 7, 0, 0],
    [0, 2, 7, 2, 0],
    [0, 0, 0, 0, 2],
    [7, 5, 5, 5, 7],
    [2, 6, 2, 2, 7],
    [7, 1, 7, 4, 7],
    [7, 1, 7, 1, 7],
    [5, 5, 7, 1, 1],
    [7, 4, 7, 1, 7],
    [7, 4, 7, 5, 7],
    [7, 1, 2, 2, 2],
    [7, 5, 7, 5, 7],
    [7, 5, 7, 1, 7],
    [0, 7, 7, 4, 7],
];

pub(crate) fn glyph_index(glyph: char) -> Option<u32> {
    GLYPHS
        .chars()
        .position(|candidate| candidate == glyph)
        .map(|index| index as u32)
}

pub(crate) fn numeric_atlas() -> [u8; (ATLAS_WIDTH * ATLAS_HEIGHT) as usize] {
    let mut pixels = [0; (ATLAS_WIDTH * ATLAS_HEIGHT) as usize];
    for (glyph, rows) in ROWS.iter().enumerate() {
        for (vertical, bits) in rows.iter().enumerate() {
            for horizontal in 0..3 {
                if bits & (1 << (2 - horizontal)) != 0 {
                    pixels[vertical * ATLAS_WIDTH as usize + glyph * 4 + horizontal] = 255;
                }
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_atlas_is_fixed_and_rejects_unsupported_text() {
        let atlas = numeric_atlas();
        assert_eq!(atlas.len(), ATLAS_WIDTH as usize * ATLAS_HEIGHT as usize);
        assert!(atlas.iter().any(|value| *value == 255));
        assert!(glyph_index('A').is_none());
        for glyph in "-+.0123456789e".chars() {
            assert!(glyph_index(glyph).is_some());
        }
    }
}
