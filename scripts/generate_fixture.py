#!/usr/bin/env python3
"""Generate deterministic exact surfaces, thin features and color patches.

The default fixture has 8,192 points. Each output is below 2 MB. The scene has
overlapping rear/front planes, a sphere, a thin sloping ribbon and a slender
cylinder. Geometry has no random jitter; noise can be added by preprocess.py.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

try:
    from .preprocess import PointCloud, preprocess_cloud, write_processed
except ImportError:
    from preprocess import PointCloud, preprocess_cloud, write_processed


def _grid(count: int, bounds: tuple[float, float, float, float]) -> np.ndarray:
    xmin, xmax, ymin, ymax = bounds
    width = max(2, int(np.ceil(np.sqrt(count * (xmax - xmin) / (ymax - ymin)))))
    height = max(2, int(np.ceil(count / width)))
    x, y = np.meshgrid(np.linspace(xmin, xmax, width), np.linspace(ymin, ymax, height))
    return np.column_stack((x.ravel(), y.ravel()))[:count]


def make_fixture(count: int = 8192) -> tuple[PointCloud, dict]:
    if count < 256:
        raise ValueError("the fixture needs at least 256 points to retain all features")
    allocations = [int(count * fraction) for fraction in (0.40, 0.28, 0.20, 0.08)]
    allocations.append(count - sum(allocations))
    positions: list[np.ndarray] = []
    colors: list[np.ndarray] = []
    normals: list[np.ndarray] = []
    groups: list[dict] = []

    def add(name: str, xyz: np.ndarray, rgb: np.ndarray, normal: np.ndarray, definition: str) -> None:
        offset = sum(len(points) for points in positions)
        positions.append(xyz)
        colors.append(rgb)
        normals.append(normal)
        groups.append({"name": name, "firstId": offset, "count": len(xyz), "surface": definition})

    rear_xy = _grid(allocations[0], (-1.0, 1.0, -0.68, 0.68))
    rear = np.column_stack((rear_xy, np.full(len(rear_xy), -0.42)))
    rear_colors = np.tile((0.26, 0.46, 0.68), (len(rear), 1))
    patch = (rear[:, 0] > -0.85) & (rear[:, 0] < -0.48) & (rear[:, 1] > -0.48) & (rear[:, 1] < -0.12)
    rear_colors[patch] = (0.99, 0.78, 0.12)
    add("rear plane + yellow patch", rear, rear_colors, np.tile((0.0, 0.0, 1.0), (len(rear), 1)), "z=-0.42; x in [-1,1]; y in [-0.68,0.68]")

    front_xy = _grid(allocations[1], (-0.22, 0.95, -0.55, 0.48))
    front = np.column_stack((front_xy, np.full(len(front_xy), 0.06)))
    front_colors = np.tile((0.22, 0.70, 0.58), (len(front), 1))
    patch = (front[:, 0] > 0.26) & (front[:, 0] < 0.56) & (front[:, 1] > -0.22) & (front[:, 1] < 0.10)
    front_colors[patch] = (0.88, 0.20, 0.61)
    add("front plane + magenta patch", front, front_colors, np.tile((0.0, 0.0, 1.0), (len(front), 1)), "z=0.06; x in [-0.22,0.95]; y in [-0.55,0.48]")

    sample = np.arange(allocations[2], dtype=np.float64)
    z = 1.0 - 2.0 * (sample + 0.5) / allocations[2]
    longitude = sample * (np.pi * (3.0 - np.sqrt(5.0)))
    circle = np.sqrt(1.0 - z * z)
    sphere_normals = np.column_stack((circle * np.cos(longitude), circle * np.sin(longitude), z))
    sphere = sphere_normals * 0.24 + np.array((-0.52, 0.04, 0.13))
    sphere_colors = np.tile((0.88, 0.45, 0.20), (len(sphere), 1))
    add("sphere", sphere, sphere_colors, sphere_normals, "radius=0.24; center=(-0.52,0.04,0.13); Fibonacci surface samples")

    ribbon_xy = _grid(allocations[3], (-0.90, 0.75, -0.01, 0.01))
    ribbon = np.column_stack((ribbon_xy[:, 0], 0.40 + 0.14 * ribbon_xy[:, 0] + ribbon_xy[:, 1], np.full(len(ribbon_xy), 0.42)))
    add("thin sloping ribbon", ribbon, np.tile((0.95, 0.87, 0.72), (len(ribbon), 1)), np.tile((0.0, 0.0, 1.0), (len(ribbon), 1)), "z=0.42; y=0.40+0.14*x +/-0.01; x in [-0.90,0.75]")

    cylinder_count = allocations[4]
    ring_count = 12
    row_count = int(np.ceil(cylinder_count / ring_count))
    angle, height = np.meshgrid(np.linspace(0.0, 2.0 * np.pi, ring_count, endpoint=False), np.linspace(-0.56, 0.50, row_count))
    angle, height = angle.ravel()[:cylinder_count], height.ravel()[:cylinder_count]
    cylinder = np.column_stack((0.70 + 0.012 * np.cos(angle), height, 0.28 + 0.012 * np.sin(angle)))
    cylinder_normals = np.column_stack((np.cos(angle), np.zeros(cylinder_count), np.sin(angle)))
    add("slender cylinder", cylinder, np.tile((0.43, 0.65, 0.95), (len(cylinder), 1)), cylinder_normals, "y axis; radius=0.012; axis at x=0.70,z=0.28; y in [-0.56,0.50]")

    cloud = PointCloud(np.concatenate(positions), np.concatenate(colors), np.concatenate(normals), np.arange(count, dtype=np.int64), "synthetic-depth-thin-color")
    return cloud, {"kind": "deterministic synthetic exact geometry", "groups": groups, "randomJitter": False}


def write_ascii_ply(path: Path, cloud: PointCloud) -> None:
    byte_colors = np.rint(cloud.colors * 255.0).astype(np.uint8)
    header = ["ply", "format ascii 1.0", "comment Deterministic COMP5411 point cloud fixture", f"element vertex {len(cloud.positions)}", "property float x", "property float y", "property float z", "property float nx", "property float ny", "property float nz", "property uchar red", "property uchar green", "property uchar blue", "property uint source_id", "end_header"]
    with path.open("w", encoding="ascii") as output:
        output.write("\n".join(header) + "\n")
        for position, normal, rgb, source_id in zip(cloud.positions, cloud.normals, byte_colors, cloud.ids):
            values = [*(f"{value:.7f}" for value in position), *(f"{value:.7f}" for value in normal), *(str(int(value)) for value in rgb), str(int(source_id))]
            output.write(" ".join(values) + "\n")


def write_ascii_xyz(path: Path, cloud: PointCloud) -> None:
    byte_colors = np.rint(cloud.colors * 255.0).astype(np.uint8)
    with path.open("w", encoding="ascii") as output:
        output.write("# XYZ RGB; persistent source IDs are the zero-based vertex rows\n")
        for position, rgb in zip(cloud.positions, byte_colors):
            output.write(" ".join([*(f"{value:.7f}" for value in position), *(str(int(value)) for value in rgb)]) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, default=8192)
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    parser.add_argument("--backend", choices=("auto", "numpy", "scipy"), default="auto")
    parser.add_argument("--neighbors", type=int, default=24)
    options = parser.parse_args()
    try:
        cloud, metadata = make_fixture(options.count)
        # Quantize the in-memory colors to match both exported source formats.
        cloud = PointCloud(cloud.positions, np.rint(cloud.colors * 255.0) / 255.0, cloud.normals, cloud.ids, cloud.name)
        result = preprocess_cloud(cloud, neighbors=options.neighbors, backend=options.backend, extra_metadata=metadata)
        options.output_dir.mkdir(parents=True, exist_ok=True)
        write_ascii_ply(options.output_dir / "fixture.ply", cloud)
        write_ascii_xyz(options.output_dir / "fixture.xyz", cloud)
        size = write_processed(options.output_dir / "fixture.json", result)
    except (OSError, ValueError) as error:
        parser.exit(2, f"generate_fixture: {error}\n")
    print(f"Generated {options.count:,} points in {options.output_dir}; JSON {size:,} bytes; {result['metadata']['neighborBackend']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
