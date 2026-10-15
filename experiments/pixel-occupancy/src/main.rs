use pixel_occupancy_lab::{
    accumulate, classify, dilate, index, indexed, parallel, scan, Block, Point, View,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeMap,
    error::Error,
    fs::{self, File, OpenOptions},
    hint::black_box,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Instant, UNIX_EPOCH},
};

type AppError = Box<dyn Error + Send + Sync>;
type Result<T> = std::result::Result<T, AppError>;
const CHUNK: usize = 65536;
const SIDE: u64 = 64;

#[derive(Serialize, Deserialize)]
struct Dataset {
    version: u32,
    count: u64,
    bytes: u64,
    modified_ns: u128,
    seed: u64,
    profile: String,
    layout: String,
    generation_ms: f64,
    index_build_ms: f64,
    blocks: Vec<Block>,
}
fn millis(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.
}
fn modified(file: &File) -> Result<u128> {
    Ok(file
        .metadata()?
        .modified()?
        .duration_since(UNIX_EPOCH)?
        .as_nanos())
}
fn metadata_path(p: &Path) -> PathBuf {
    p.with_extension("json")
}
fn exclusive(p: &Path) -> Result<File> {
    Ok(OpenOptions::new().write(true).create_new(true).open(p)?)
}
fn arg<'a>(a: &'a BTreeMap<String, String>, k: &str, default: &'a str) -> &'a str {
    a.get(k).map(String::as_str).unwrap_or(default)
}
fn number<T: std::str::FromStr>(a: &BTreeMap<String, String>, k: &str, default: &str) -> Result<T> {
    arg(a, k, default)
        .parse()
        .map_err(|_| format!("invalid --{k}").into())
}
fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e3779b97f4a7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
    z ^ (z >> 31)
}
fn unit(z: u64) -> f32 {
    ((z >> 40) as f32 + 0.5) / 16777216.
}
fn tiles(profile: &str) -> Result<Vec<(u64, u64)>> {
    if !["uniform", "clusters", "filament"].contains(&profile) {
        return Err("profile must be uniform, clusters or filament".into());
    }
    let mut t = vec![];
    for y in 0..SIDE {
        for x in 0..SIDE {
            if profile == "uniform"
                || (profile == "clusters"
                    && ((8..16).contains(&x) && (8..16).contains(&y)
                        || (28..36).contains(&x) && (28..36).contains(&y)))
                || (profile == "filament" && x == y)
            {
                t.push((x, y));
            }
        }
    }
    Ok(t)
}
fn generated(id: u64, tile: (u64, u64), seed: u64, profile: &str) -> Point {
    let x = (tile.0 as f32 + unit(mix(id ^ seed))) / SIDE as f32;
    let y = if profile == "filament" {
        x
    } else {
        (tile.1 as f32 + unit(mix(id ^ seed ^ 0x123456789abcdef0))) / SIDE as f32
    };
    Point { x, y }
}
fn mapped(file: &File) -> Result<memmap2::Mmap> {
    // The lab creates immutable datasets, validates length/mtime, and never writes
    // a mapped file. The caller must prevent external modification for its lifetime.
    Ok(unsafe { memmap2::MmapOptions::new().map(file)? })
}
fn points(bytes: &[u8]) -> Result<&[Point]> {
    bytemuck::try_cast_slice(bytes).map_err(|e| e.to_string().into())
}

fn generate(a: &BTreeMap<String, String>) -> Result<()> {
    if cfg!(target_endian = "big") {
        return Err("this experiment requires little endian".into());
    }
    let count: u64 = number(a, "points", "100000000")?;
    if !(4..=5_000_000_000).contains(&count) {
        return Err("points must be 4..=5000000000".into());
    }
    let path = Path::new(arg(a, "data", "artifacts/points.bin"));
    if metadata_path(path).exists() {
        return Err("dataset metadata already exists; choose a new data path".into());
    }
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let seed = number(a, "seed", "281")?;
    let profile = arg(a, "profile", "uniform");
    let layout = arg(a, "layout", "tiled");
    if !["tiled", "shuffled"].contains(&layout) {
        return Err("layout must be tiled or shuffled".into());
    }
    let tiles = tiles(profile)?;
    let n = count - 4;
    let start = Instant::now();
    let mut w = BufWriter::with_capacity(8 * CHUNK, exclusive(path)?);
    let mut buf = Vec::with_capacity(CHUNK);
    let mut total = 0u64;
    // Spatial ordering is constructed explicitly. Shuffled layout is the control
    // for the same distribution, without spatial locality (not a timed sort).
    for (tile_id, &tile) in tiles.iter().enumerate() {
        let len = n / tiles.len() as u64 + u64::from((tile_id as u64) < n % tiles.len() as u64);
        for _ in 0..len {
            let t = if layout == "tiled" {
                tile
            } else {
                tiles[(mix(total ^ seed) % tiles.len() as u64) as usize]
            };
            buf.push(generated(total, t, seed, profile));
            total += 1;
            if buf.len() == CHUNK {
                w.write_all(bytemuck::cast_slice(&buf))?;
                buf.clear();
            }
        }
        if tile_id % 512 == 0 {
            eprintln!("generated {total}/{count}");
        }
    }
    buf.extend([
        Point { x: 0., y: 0. },
        Point { x: 1., y: 1. },
        Point { x: 0.95, y: 0.05 },
        Point { x: 0.05, y: 0.95 },
    ]);
    w.write_all(bytemuck::cast_slice(&buf))?;
    w.flush()?;
    w.get_ref().sync_all()?;
    let generation_ms = millis(start);
    drop(w);
    let f = File::open(path)?;
    let map = mapped(&f)?;
    let p = points(&map)?;
    let start = Instant::now();
    let blocks = index(p, CHUNK);
    let index_build_ms = millis(start);
    let d = Dataset {
        version: 1,
        count,
        bytes: count * 8,
        modified_ns: modified(&f)?,
        seed,
        profile: profile.into(),
        layout: layout.into(),
        generation_ms,
        index_build_ms,
        blocks,
    };
    serde_json::to_writer_pretty(exclusive(&metadata_path(path))?, &d)?;
    println!(
        "{}",
        json!({"points":count,"bytes":count*8,"generation_ms":generation_ms,"index_build_ms":index_build_ms,"blocks":d.blocks.len()})
    );
    Ok(())
}

enum Storage {
    Mapped(memmap2::Mmap),
    Resident(Vec<Point>),
    Stream(File),
}
impl Storage {
    fn slice(&self) -> Result<Option<&[Point]>> {
        match self {
            Self::Mapped(m) => Ok(Some(points(m)?)),
            Self::Resident(p) => Ok(Some(p)),
            Self::Stream(_) => Ok(None),
        }
    }
}
fn read_chunk(r: &mut impl Read, buf: &mut [Point]) -> Result<()> {
    r.read_exact(bytemuck::cast_slice_mut(buf))?;
    Ok(())
}
fn full(storage: &Storage, count: u64, v: View, threads: bool) -> Result<Vec<u8>> {
    if let Some(p) = storage.slice()? {
        return Ok(if threads { parallel(p, v) } else { scan(p, v) });
    }
    let Storage::Stream(f) = storage else {
        return Err("invalid storage".into());
    };
    if threads {
        return Err("parallel scan requires mmap or resident storage".into());
    }
    let mut file = f.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    let mut r = BufReader::new(file);
    let mut buf = vec![Point { x: 0., y: 0. }; CHUNK];
    let mut mask = vec![0; v.width * v.height];
    let mut left = count;
    while left > 0 {
        let n = left.min(CHUNK as u64) as usize;
        read_chunk(&mut r, &mut buf[..n])?;
        accumulate(&buf[..n], v, &mut mask);
        left -= n as u64;
    }
    Ok(mask)
}
fn query(storage: &Storage, blocks: &[Block], v: View) -> Result<(Vec<u8>, u64, u64)> {
    if let Some(p) = storage.slice()? {
        return Ok(indexed(p, blocks, v));
    }
    let Storage::Stream(f) = storage else {
        return Err("invalid storage".into());
    };
    let mut file = f.try_clone()?;
    let mut buf = vec![Point { x: 0., y: 0. }; CHUNK];
    let mut mask = vec![0; v.width * v.height];
    let mut read = 0;
    let mut collapsed = 0;
    for b in blocks {
        match classify(b, v) {
            None => {}
            Some(Some(i)) => {
                mask[i] = 1;
                collapsed += b.len;
            }
            Some(None) => {
                file.seek(SeekFrom::Start(b.start * 8))?;
                read_chunk(&mut file, &mut buf[..b.len as usize])?;
                accumulate(&buf[..b.len as usize], v, &mut mask);
                read += b.len;
            }
        }
    }
    Ok((mask, read, collapsed))
}
fn checksum(storage: &Storage, count: u64) -> Result<u64> {
    fn add(p: &[Point], mut sum: u64) -> u64 {
        for p in p {
            sum = sum
                .wrapping_add(p.x.to_bits() as u64)
                .wrapping_add(p.y.to_bits() as u64);
        }
        sum
    }
    if let Some(p) = storage.slice()? {
        return Ok(black_box(add(p, 0)));
    }
    let Storage::Stream(f) = storage else {
        return Err("invalid storage".into());
    };
    let mut file = f.try_clone()?;
    file.seek(SeekFrom::Start(0))?;
    let mut r = BufReader::new(file);
    let mut buf = vec![Point { x: 0., y: 0. }; CHUNK];
    let mut left = count;
    let mut sum = 0;
    while left > 0 {
        let n = left.min(CHUNK as u64) as usize;
        read_chunk(&mut r, &mut buf[..n])?;
        sum = add(&buf[..n], sum);
        left -= n as u64;
    }
    Ok(black_box(sum))
}
fn image(path: &Path, mask: &[u8], v: View) -> Result<()> {
    let mut w = BufWriter::new(exclusive(path)?);
    write!(w, "P6\n{} {}\n255\n", v.width, v.height)?;
    for y in (0..v.height).rev() {
        for x in 0..v.width {
            w.write_all(if mask[y * v.width + x] == 0 {
                &[248, 250, 252]
            } else {
                &[31, 111, 235]
            })?;
        }
    }
    w.flush()?;
    Ok(())
}
fn run(a: &BTreeMap<String, String>) -> Result<()> {
    if cfg!(target_pointer_width = "32") || cfg!(target_endian = "big") {
        return Err("64-bit little-endian host required".into());
    }
    let path = Path::new(arg(a, "data", "artifacts/points.bin"));
    let f = File::open(path)?;
    let d: Dataset = serde_json::from_reader(File::open(metadata_path(path))?)?;
    if d.version != 1
        || d.count < 4
        || d.count > 5_000_000_000
        || f.metadata()?.len() != d.count * 8
        || d.bytes != d.count * 8
        || modified(&f)? != d.modified_ns
    {
        return Err("dataset size/version/mtime does not match metadata".into());
    }
    let mut cursor = 0;
    for b in &d.blocks {
        if b.start != cursor
            || b.len == 0
            || b.len > CHUNK as u64
            || !b.bounds.iter().all(|n| n.is_finite())
            || b.bounds[0] > b.bounds[1]
            || b.bounds[2] > b.bounds[3]
        {
            return Err("invalid index block".into());
        }
        cursor = cursor.checked_add(b.len).ok_or("index overflow")?;
    }
    if cursor != d.count {
        return Err("index does not cover dataset".into());
    }
    let width: usize = number(a, "width", "720")?;
    let height: usize = number(a, "height", "720")?;
    let radius: usize = number(a, "radius", "3")?;
    let repeats: usize = number(a, "repeats", "3")?;
    let threads: usize = number(a, "threads", "4")?;
    if !(1..=4096).contains(&width)
        || !(1..=4096).contains(&height)
        || radius > 4096
        || !(1..=100).contains(&repeats)
        || !(1..=32).contains(&threads)
    {
        return Err(
            "dimensions 1..4096, radius 0..4096, repeats 1..100, threads 1..32 required".into(),
        );
    }
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()?;
    let kind = arg(a, "storage", "mmap");
    let t = Instant::now();
    let storage = match kind {
        "mmap" => Storage::Mapped(mapped(&f)?),
        "stream" => Storage::Stream(f.try_clone()?),
        "resident" => {
            let cap: u64 = number(a, "max-resident-gib", "8")?;
            if cap > 16 || d.bytes > cap * 1024 * 1024 * 1024 {
                return Err(
                    "resident dataset exceeds memory budget (maximum 16 GiB); use mmap/stream"
                        .into(),
                );
            }
            let mut p = vec![];
            p.try_reserve_exact(d.count as usize)?;
            p.resize(d.count as usize, Point { x: 0., y: 0. });
            let mut file = f.try_clone()?;
            read_chunk(&mut file, &mut p)?;
            Storage::Resident(p)
        }
        _ => return Err("storage must be mmap, resident or stream".into()),
    };
    let load_ms = millis(t);
    let out = Path::new(arg(a, "out", "artifacts/run"));
    fs::create_dir_all(out)?;
    let report_path = out.join("report.json");
    if report_path.exists() {
        return Err("report exists; choose a new --out directory".into());
    }
    let mut events = BufWriter::new(exclusive(&out.join("measurements.jsonl"))?);
    let mut persisted = 0;
    let mut rows = vec![];
    for repeat in 0..repeats {
        let t = Instant::now();
        let sum = checksum(&storage, d.count)?;
        let ms = millis(t);
        rows.push(json!({"repeat":repeat,"stage":"read_checksum","ms":ms,"logical_input_bytes":d.bytes,"checksum":sum}));
        eprintln!("{kind} repeat {repeat}: read/checksum {ms:.2} ms");
        let custom = arg(a, "view", "");
        let views: Vec<(&str, [f64; 4])> = if custom.is_empty() {
            vec![
                ("full", [0., 1., 0., 1.]),
                ("zoom", [0.125, 0.14, 0.125, 0.14]),
                ("pan", [0.13, 0.145, 0.125, 0.14]),
                ("overscan", [0.1175, 0.1475, 0.1175, 0.1475]),
            ]
        } else {
            let b: Vec<f64> = custom
                .split(',')
                .map(str::parse)
                .collect::<std::result::Result<_, _>>()?;
            if b.len() != 4 {
                return Err("view requires xmin,xmax,ymin,ymax".into());
            }
            vec![("custom", [b[0], b[1], b[2], b[3]])]
        };
        for (name, bounds) in views {
            if !bounds.iter().all(|x| x.is_finite())
                || bounds[0] >= bounds[1]
                || bounds[2] >= bounds[3]
            {
                return Err("invalid view".into());
            }
            let scale = if name == "overscan" { 2 } else { 1 };
            let v = View {
                bounds,
                width: width * scale,
                height: height * scale,
            };
            let t = Instant::now();
            let reference = full(&storage, d.count, v, false)?;
            let ms = millis(t);
            rows.push(json!({"repeat":repeat,"view":name,"stage":"sequential","ms":ms,"points_read":d.count,"logical_input_bytes":d.bytes}));
            if name == "full" && kind != "stream" {
                let t = Instant::now();
                let mask = pool.install(|| full(&storage, d.count, v, true))?;
                let ms = millis(t);
                if mask != reference {
                    return Err("parallel mask differs from full reference".into());
                }
                rows.push(json!({"repeat":repeat,"view":name,"stage":"parallel","ms":ms,"points_read":d.count,"logical_input_bytes":d.bytes}));
            }
            let t = Instant::now();
            let (mask, read, collapsed) = query(&storage, &d.blocks, v)?;
            let ms = millis(t);
            let missing = mask
                .iter()
                .zip(&reference)
                .filter(|(a, b)| **a == 0 && **b != 0)
                .count();
            let extra = mask
                .iter()
                .zip(&reference)
                .filter(|(a, b)| **a != 0 && **b == 0)
                .count();
            rows.push(json!({"repeat":repeat,"view":name,"stage":"indexed","ms":ms,"points_read":read,"logical_input_bytes":read*8,"points_collapsed":collapsed,"index_entries_inspected":d.blocks.len(),"missing_pixels":missing,"extra_pixels":extra,"occupied_pixels":mask.iter().filter(|&&x|x!=0).count(),"width":v.width,"height":v.height,"bounds":bounds}));
            if missing != 0 || extra != 0 {
                return Err("indexed mask differs from full reference".into());
            }
            let t = Instant::now();
            let expanded = dilate(&mask, v, radius);
            let radius_ms = millis(t);
            rows.push(json!({"repeat":repeat,"view":name,"stage":"radius_edt","ms":radius_ms,"radius":radius}));
            if repeat == 0 {
                let t = Instant::now();
                image(&out.join(format!("{name}.ppm")), &expanded, v)?;
                rows.push(
                    json!({"repeat":repeat,"view":name,"stage":"image_export","ms":millis(t)}),
                );
            }
            eprintln!("{kind} repeat {repeat} {name}: indexed {ms:.2} ms; {read} points read; missing={missing} extra={extra}");
            for row in &rows[persisted..] {
                serde_json::to_writer(&mut events, row)?;
                writeln!(events)?;
            }
            events.flush()?;
            persisted = rows.len();
        }
    }
    if modified(&f)? != d.modified_ns || f.metadata()?.len() != d.bytes {
        return Err("dataset changed during experiment".into());
    }
    let report = json!({"version":1,"points":d.count,"dataset_bytes":d.bytes,"profile":d.profile,"layout":d.layout,"seed":d.seed,
        "storage":kind,"load_or_map_ms":load_ms,"generation_ms":d.generation_ms,"index_build_ms":d.index_build_ms,
        "threads":threads,"repeats":repeats,"arch":std::env::consts::ARCH,"os":std::env::consts::OS,
        "cache_policy":"OS cache uncontrolled; read_checksum precedes scan; no cold-cache claim; resident means a heap copy, not pinned pages",
        "scope":"CPU kernels and image export; no GPU, IPC or native frame timing; index trusts immutable generated data and metadata",
        "rows":rows});
    serde_json::to_writer_pretty(exclusive(&report_path)?, &report)?;
    println!("{}", report_path.display());
    Ok(())
}
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_default();
    let mut a: BTreeMap<String, String> = BTreeMap::new();
    while let Some(k) = args.next() {
        let value = args.next().ok_or("every --option requires a value")?;
        if !k.starts_with("--") || a.insert(k[2..].into(), value).is_some() {
            return Err("invalid/duplicate option".into());
        }
    }
    let allowed = [
        "data",
        "points",
        "seed",
        "profile",
        "layout",
        "out",
        "storage",
        "width",
        "height",
        "radius",
        "repeats",
        "threads",
        "view",
        "max-resident-gib",
    ];
    if a.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("unknown option".into());
    }
    match command.as_str() {
        "generate" => generate(&a),
        "run" => run(&a),
        _ => {
            eprintln!("pixel-occupancy-lab generate --data FILE --points N --profile uniform|clusters|filament --layout tiled|shuffled\npixel-occupancy-lab run --data FILE --out DIR --storage mmap|resident|stream --threads 4 --repeats 3 --radius 3 [--view xmin,xmax,ymin,ymax]");
            Err("command must be generate or run".into())
        }
    }
}
