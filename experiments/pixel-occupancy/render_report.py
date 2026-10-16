#!/usr/bin/env python3
"""Render actual Rust PPM output as PNG; summarize raw measurements without extrapolation."""
import json
import statistics
import struct
import sys
import zlib
from pathlib import Path


def png(source):
    magic, size, depth, pixels = source.read_bytes().split(b"\n", 3)
    width, height = map(int, size.split())
    if magic != b"P6" or depth != b"255" or len(pixels) != width*height*3:
        raise ValueError("invalid PPM")

    def chunk(name, payload):
        return struct.pack(">I", len(payload))+name+payload+struct.pack(">I", zlib.crc32(name+payload) & 0xffffffff)

    raw = b"".join(b"\0"+pixels[y*width*3:(y+1)*width*3] for y in range(height))
    image = b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))+chunk(b"IDAT", zlib.compress(raw))+chunk(b"IEND", b"")
    source.with_suffix(".png").write_bytes(image)


def main():
    root = Path(sys.argv[1]).resolve()
    lines = ["# Pixel occupancy experiment — measured results", "",
             "CPU kernel measurements only. OS cache is uncontrolled; sequential reference runs precede indexed queries. "
             "Logical bytes describe requested coordinates, not physical disk traffic. Spatially tiled and shuffled data are separate controls. "
             "Single samples are not percentiles. Radius images use quantized centers. No native UI/GPU frame-rate claim.", "",
             "| Points | Profile/layout | Storage | Stage/view | Samples | Median ms | Min ms | Max ms |", "|---:|---|---|---|---:|---:|---:|---:|"]
    images = []
    for path in sorted(root.glob("*/report.json")):
        report = json.loads(path.read_text())
        groups = {}
        for row in report["rows"]:
            if row["stage"] == "indexed" and (row["missing_pixels"] or row["extra_pixels"]):
                raise ValueError(f"pixel mismatch: {path}")
            groups.setdefault((row["stage"], row.get("view", "all")), []).append(row["ms"])
        for (stage, view), values in groups.items():
            lines.append(f'| {report["points"]:,} | {report["profile"]}/{report["layout"]} | {report["storage"]} | {stage}/{view} | {len(values)} | {statistics.median(values):.3f} | {min(values):.3f} | {max(values):.3f} |')
        images += ["", f'## {path.parent.name}', "", f'[Raw report]({path.parent.name}/report.json)', "",
                   f'Generation: {report["generation_ms"]:.2f} ms; index build: {report["index_build_ms"]:.2f} ms; load/map: {report["load_or_map_ms"]:.2f} ms.', ""]
        for image in sorted(path.parent.glob("*.ppm")):
            png(image)
            images += [f'![{image.stem}]({path.parent.name}/{image.stem}.png)', ""]
        images += ["| View | Points read | Points collapsed | Missing pixels | Extra pixels |", "|---|---:|---:|---:|---:|"]
        for row in report["rows"]:
            if row["stage"] == "indexed" and row["repeat"] == 0:
                images.append(f'| {row["view"]} | {row["points_read"]:,} | {row["points_collapsed"]:,} | {row["missing_pixels"]} | {row["extra_pixels"]} |')
    (root / "report.md").write_text("\n".join(lines+images)+"\n")


if __name__ == "__main__":
    main()
