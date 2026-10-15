#!/usr/bin/env python3
"""Run the immutable release binary over a smoke or explicitly selected stress matrix."""
import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stress", action="store_true", help="Generate about 51.2 GB; includes five billion points")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    binary = ROOT / "target/release/pixel-occupancy-lab"
    if not binary.is_file():
        parser.error("build the release binary first")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    scale = 100_000_000 if args.stress else 100_007
    jobs = [(scale, "uniform", "tiled")]
    if args.stress:
        jobs += [(1_000_000_000, "uniform", "tiled"), (5_000_000_000, "uniform", "tiled")]
    jobs += [(scale, "clusters", "tiled"), (scale, "filament", "tiled"), (scale, "uniform", "shuffled")]
    required = sum(n * 8 for n, _, _ in jobs)
    if shutil.disk_usage(out).free < required + 20 * 1024**3:
        parser.error("insufficient disk space for datasets plus 20 GiB reserve")
    sources = [ROOT / "Cargo.toml", ROOT / "Cargo.lock", *sorted((ROOT / "src").glob("*.rs")),
               *sorted((ROOT / "tests").glob("*.rs")), ROOT / "render_report.py", Path(__file__).resolve()]
    manifest = {
        "stress": args.stress, "platform": platform.platform(), "machine": platform.machine(),
        "dataset_bytes_planned": required, "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "source_sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
        "cache_policy": "Uncontrolled OS cache, fixed ordering, no cold-cache or P95 claim",
        "runs": [],
    }
    manifest_path = out / "manifest.json"

    def invoke(command):
        start = time.monotonic()
        print("RUN", " ".join(map(str, command)), flush=True)
        with (out / "execution.log").open("ab") as log:
            result = subprocess.run(list(map(str, command)), cwd=ROOT, stdout=log, stderr=log)
        manifest["runs"].append({"command": list(map(str, command)), "wall_seconds": time.monotonic()-start, "exit_code": result.returncode})
        manifest_path.write_text(json.dumps(manifest, indent=2)+"\n")
        result.check_returncode()

    for count, profile, layout in jobs:
        stem = f"{count}-{profile}-{layout}"
        data = out / f"{stem}.bin"
        invoke([binary, "generate", "--data", data, "--points", count, "--profile", profile, "--layout", layout])
        modes = ["mmap"]
        if profile == "uniform" and layout == "tiled" and count <= 1_000_000_000:
            modes.append("resident")
            if count == scale:
                modes.append("stream")
        for mode in modes:
            repeats = 3 if count == scale else 1
            invoke([binary, "run", "--data", data, "--out", out / f"{stem}-{mode}", "--storage", mode,
                    "--threads", 4, "--repeats", repeats, "--radius", 3])
    invoke([shutil.which("python3") or "python3", ROOT / "render_report.py", out])
    print(out / "report.md", flush=True)


if __name__ == "__main__":
    main()
