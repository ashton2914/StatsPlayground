use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct View {
    pub bounds: [f64; 4],
    pub width: usize,
    pub height: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Block {
    pub start: u64,
    pub len: u64,
    pub bounds: [f64; 4],
}

impl View {
    #[inline]
    pub fn pixel(&self, p: Point) -> Option<usize> {
        let [x0, x1, y0, y1] = self.bounds;
        let x = p.x as f64;
        let y = p.y as f64;
        if !x.is_finite() || !y.is_finite() || x < x0 || x > x1 || y < y0 || y > y1 {
            return None;
        }
        let u = (((x - x0) * (self.width as f64 / (x1 - x0))) as usize).min(self.width - 1);
        let v = (((y - y0) * (self.height as f64 / (y1 - y0))) as usize).min(self.height - 1);
        Some(v * self.width + u)
    }
}
pub fn accumulate(points: &[Point], v: View, mask: &mut [u8]) {
    for &p in points {
        if let Some(i) = v.pixel(p) {
            mask[i] = 1;
        }
    }
}
pub fn scan(points: &[Point], v: View) -> Vec<u8> {
    let mut m = vec![0; v.width * v.height];
    accumulate(points, v, &mut m);
    m
}
pub fn parallel(points: &[Point], v: View) -> Vec<u8> {
    use rayon::prelude::*;
    let chunk = points.len().div_ceil(rayon::current_num_threads()).max(1);
    points.par_chunks(chunk).map(|p| scan(p, v)).reduce(
        || vec![0; v.width * v.height],
        |mut a, b| {
            for (a, b) in a.iter_mut().zip(b) {
                *a |= b;
            }
            a
        },
    )
}
pub fn index(points: &[Point], block_size: usize) -> Vec<Block> {
    points
        .chunks(block_size)
        .enumerate()
        .map(|(i, p)| {
            let mut bounds = [
                f64::INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::NEG_INFINITY,
            ];
            for p in p {
                if p.x.is_finite() && p.y.is_finite() {
                    bounds[0] = bounds[0].min(p.x as f64);
                    bounds[1] = bounds[1].max(p.x as f64);
                    bounds[2] = bounds[2].min(p.y as f64);
                    bounds[3] = bounds[3].max(p.y as f64);
                }
            }
            Block {
                start: (i * block_size) as u64,
                len: p.len() as u64,
                bounds,
            }
        })
        .collect()
}
/// None = outside, Some(Some(pixel)) = exact collapse, Some(None) = inspect raw block.
pub fn classify(b: &Block, v: View) -> Option<Option<usize>> {
    let [a, bx, c, d] = b.bounds;
    let [x0, x1, y0, y1] = v.bounds;
    if a > bx || c > d || bx < x0 || a > x1 || d < y0 || c > y1 {
        return None;
    }
    if a >= x0 && bx <= x1 && c >= y0 && d <= y1 {
        let lo = v.pixel(Point {
            x: a as f32,
            y: c as f32,
        });
        let hi = v.pixel(Point {
            x: bx as f32,
            y: d as f32,
        });
        if lo == hi {
            return Some(lo);
        }
    }
    Some(None)
}
pub fn indexed(points: &[Point], blocks: &[Block], v: View) -> (Vec<u8>, u64, u64) {
    let mut m = vec![0; v.width * v.height];
    let mut read = 0;
    let mut collapsed = 0;
    for b in blocks {
        match classify(b, v) {
            None => {}
            Some(Some(i)) => {
                m[i] = 1;
                collapsed += b.len;
            }
            Some(None) => {
                let s = b.start as usize;
                accumulate(&points[s..s + b.len as usize], v, &mut m);
                read += b.len;
            }
        }
    }
    (m, read, collapsed)
}

// Squared Euclidean distance transform, Felzenszwalb-Huttenlocher lower envelope.
fn edt(f: &[f64], out: &mut [f64], sites: &mut [usize], cuts: &mut [f64]) {
    let mut k = 0;
    sites[0] = 0;
    cuts[0] = f64::NEG_INFINITY;
    cuts[1] = f64::INFINITY;
    for q in 1..f.len() {
        let mut s;
        loop {
            let p = sites[k];
            s = ((f[q] - f[p]) + (q * q) as f64 - (p * p) as f64) / (2. * (q - p) as f64);
            if s > cuts[k] || k == 0 {
                break;
            }
            k -= 1;
        }
        k += 1;
        sites[k] = q;
        cuts[k] = s;
        cuts[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, val) in out.iter_mut().enumerate() {
        while cuts[k + 1] < (q as f64) {
            k += 1;
        }
        let delta = q as f64 - sites[k] as f64;
        *val = delta * delta + f[sites[k]];
    }
}
pub fn dilate(mask: &[u8], v: View, radius: usize) -> Vec<u8> {
    let n = v.width.max(v.height);
    let mut f = vec![0.; n];
    let mut out = vec![0.; n];
    let mut sites = vec![0; n];
    let mut cuts = vec![0.; n + 1];
    let mut dist = vec![0.; mask.len()];
    // Finite sentinel avoids infinity minus infinity in empty rows.
    const FAR: f64 = 1e12;
    for y in 0..v.height {
        for x in 0..v.width {
            f[x] = if mask[y * v.width + x] != 0 { 0. } else { FAR };
        }
        edt(&f[..v.width], &mut out[..v.width], &mut sites, &mut cuts);
        dist[y * v.width..(y + 1) * v.width].copy_from_slice(&out[..v.width]);
    }
    let mut result = vec![0; mask.len()];
    let limit = (radius as f64).powi(2);
    for x in 0..v.width {
        for y in 0..v.height {
            f[y] = dist[y * v.width + x];
        }
        edt(&f[..v.height], &mut out[..v.height], &mut sites, &mut cuts);
        for y in 0..v.height {
            result[y * v.width + x] = u8::from(out[y] <= limit);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn view() -> View {
        View {
            bounds: [0., 1., 0., 1.],
            width: 10,
            height: 10,
        }
    }
    #[test]
    fn corners_duplicates_and_isolated_point_are_retained() {
        let p = [
            Point { x: 0., y: 0. },
            Point { x: 1., y: 1. },
            Point { x: 0., y: 0. },
            Point { x: 0.55, y: 0.25 },
        ];
        let m = scan(&p, view());
        assert_eq!(m.iter().filter(|&&x| x != 0).count(), 3);
        assert_eq!((m[0], m[99], m[25]), (1, 1, 1));
    }
    #[test]
    fn nonfinite_and_outside_coordinates_do_not_paint_edges() {
        let v = view();
        for p in [
            Point { x: -0.01, y: 0. },
            Point { x: 1.01, y: 1. },
            Point { x: f32::NAN, y: 0. },
            Point {
                x: 0.,
                y: f32::INFINITY,
            },
        ] {
            assert_eq!(v.pixel(p), None);
        }
        assert_eq!(v.pixel(Point { x: 0.5, y: 0.5 }), Some(55));
    }
    #[test]
    fn optimized_results_equal_reference_for_zoom_and_pan() {
        let points: Vec<_> = (0..10007)
            .map(|i| Point {
                x: ((i * 37) % 1009) as f32 / 1008.,
                y: ((i * 71) % 1013) as f32 / 1012.,
            })
            .collect();
        let blocks = index(&points, 97);
        assert_eq!(
            blocks.iter().map(|b| b.len).sum::<u64>(),
            points.len() as u64
        );
        for bounds in [
            [0., 1., 0., 1.],
            [0.22, 0.31, 0.4, 0.6],
            [0.24, 0.33, 0.4, 0.6],
            [-0.1, 0.1, 0.9, 1.1],
        ] {
            let v = View { bounds, ..view() };
            let reference = scan(&points, v);
            assert_eq!(parallel(&points, v), reference);
            assert_eq!(indexed(&points, &blocks, v).0, reference);
        }
    }
    #[test]
    fn index_collapses_whole_block_without_reading_points() {
        let p = vec![Point { x: 0.52, y: 0.52 }; 1000];
        let (m, read, collapsed) = indexed(&p, &index(&p, 1000), view());
        assert_eq!(m, scan(&p, view()));
        assert_eq!(read, 0);
        assert_eq!(collapsed, 1000);
    }
    #[test]
    fn index_preserves_holes_and_skips_invisible_blocks() {
        let p = [Point { x: 0.1, y: 0.1 }, Point { x: 0.9, y: 0.9 }];
        let v = View {
            bounds: [0., 0.2, 0., 0.2],
            ..view()
        };
        let (m, read, _) = indexed(&p, &index(&p, 1), v);
        assert_eq!(m, scan(&p, v));
        assert_eq!(read, 0);
        assert_eq!(scan(&p, view()).iter().filter(|&&x| x != 0).count(), 2);
    }
    #[test]
    fn radius_is_discrete_circle_and_clips_to_image() {
        let mut m = vec![0; 100];
        m[55] = 1;
        assert_eq!(dilate(&m, view(), 0), m);
        let d = dilate(&m, view(), 1);
        assert_eq!(d.iter().filter(|&&x| x != 0).count(), 5);
        assert_eq!(
            (d[44], d[45], d[54], d[55], d[56], d[65]),
            (0, 1, 1, 1, 1, 1)
        );
    }

    #[test]
    fn distance_transform_matches_independent_brute_force_circles() {
        for (width, height) in [(1, 1), (1, 13), (17, 1), (17, 13)] {
            let v = View {
                width,
                height,
                ..view()
            };
            for seed in 0..7 {
                let mask: Vec<_> = (0..width * height)
                    .map(|i| u8::from(seed != 0 && (i * 17 + seed) % 23 == 0))
                    .collect();
                for radius in [0, 1, 2, 5, 32] {
                    let expected: Vec<_> = (0..mask.len())
                        .map(|i| {
                            u8::from(mask.iter().enumerate().any(|(j, &on)| {
                                let dx = (i % width).abs_diff(j % width);
                                let dy = (i / width).abs_diff(j / width);
                                on != 0 && dx * dx + dy * dy <= radius * radius
                            }))
                        })
                        .collect();
                    assert_eq!(
                        dilate(&mask, v, radius),
                        expected,
                        "{width}x{height} seed={seed} radius={radius}"
                    );
                }
            }
        }
    }
}
