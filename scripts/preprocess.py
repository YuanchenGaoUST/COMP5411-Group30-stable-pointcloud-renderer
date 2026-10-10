#!/usr/bin/env python3
"""Prepare ASCII point clouds for the point-level-of-detail browser viewer.

Coordinates are centered on the bounding box and divided by its longest extent.
Radii are therefore in the same normalized units as positions. Source IDs belong
to input vertices, not positions, and survive noise injection and recomputation.
RGB is saved as sRGB, but all appearance calculations use linear RGB.

SciPy's cKDTree is used when installed. The NumPy fallback computes exact nearest
neighbors in bounded-memory batches; it is O(N^2), so its default limit is 16,000
vertices. Install SciPy to process larger files. No binary PLY is accepted.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

import numpy as np


SCHEMA_VERSION = 1
NUMPY_POINT_LIMIT = 16_000
DEFAULT_COLOR = (0.70, 0.78, 0.87)
EPSILON = 1e-12
PLY_TYPES = {
    "char", "uchar", "short", "ushort", "int", "uint", "float", "double",
    "int8", "uint8", "int16", "uint16", "int32", "uint32", "float32", "float64",
}


@dataclass(frozen=True)
class PointCloud:
    positions: np.ndarray
    colors: np.ndarray | None = None
    normals: np.ndarray | None = None
    ids: np.ndarray | None = None
    name: str = "point-cloud"


def _validate_cloud(cloud: PointCloud) -> PointCloud:
    positions = np.asarray(cloud.positions, dtype=np.float64)
    if positions.ndim != 2 or positions.shape[1] != 3 or len(positions) == 0:
        raise ValueError("positions must be a nonempty N by 3 array")
    if not np.isfinite(positions).all():
        raise ValueError("positions contain non-finite values (NaN or infinity)")
    colors = None
    if cloud.colors is not None:
        colors = np.asarray(cloud.colors, dtype=np.float64)
        if colors.shape != positions.shape or not np.isfinite(colors).all():
            raise ValueError("colors must be a finite N by 3 array")
        if (colors < 0).any() or (colors > 1).any():
            raise ValueError("colors must be sRGB values in the range 0 to 1")
    normals = None
    if cloud.normals is not None:
        normals = np.asarray(cloud.normals, dtype=np.float64)
        if normals.shape != positions.shape or not np.isfinite(normals).all():
            raise ValueError("normals must be a finite N by 3 array")
    if cloud.ids is None:
        ids = np.arange(len(positions), dtype=np.int64)
    else:
        source_ids = np.asarray(cloud.ids)
        if source_ids.shape != (len(positions),):
            raise ValueError("source IDs must have one entry per input vertex")
        if not np.isfinite(source_ids).all() or not np.equal(source_ids, np.floor(source_ids)).all():
            raise ValueError("source IDs must be finite integers")
        if (source_ids < 0).any() or (source_ids > np.iinfo(np.uint32).max).any():
            raise ValueError("source IDs must fit in an unsigned 32-bit integer")
        ids = source_ids.astype(np.int64)
    if len(np.unique(ids)) != len(ids):
        raise ValueError("source IDs must be unique")
    return PointCloud(positions, colors, normals, ids, cloud.name)


def _decode_colors(values: np.ndarray, byte_colors: bool = False) -> np.ndarray:
    values = np.asarray(values, dtype=np.float64)
    if not np.isfinite(values).all() or (values < 0).any():
        raise ValueError("RGB values must be finite and nonnegative")
    if byte_colors or (values > 1).any():
        if (values > 255).any():
            raise ValueError("RGB values must use either 0 to 1 or 0 to 255")
        values = values / 255.0
    if (values > 1).any():
        raise ValueError("RGB values are outside the supported range")
    return values


def read_xyz(path: str | Path) -> PointCloud:
    """Read 3-column XYZ or 6-column XYZ RGB; comments and blank lines are allowed."""
    path = Path(path)
    rows: list[list[float]] = []
    width: int | None = None
    with path.open("r", encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, 1):
            line = line.split("#", 1)[0].strip()
            if not line or line.startswith("//"):
                continue
            tokens = line.split()
            if len(tokens) not in (3, 6):
                raise ValueError(f"{path.name}:{line_number}: XYZ requires 3 or 6 columns")
            if width is not None and len(tokens) != width:
                raise ValueError(f"{path.name}:{line_number}: inconsistent XYZ column count")
            width = len(tokens)
            try:
                rows.append([float(token) for token in tokens])
            except ValueError as error:
                raise ValueError(f"{path.name}:{line_number}: invalid numeric XYZ value") from error
    if not rows:
        raise ValueError(f"{path.name}: no XYZ points found")
    data = np.asarray(rows, dtype=np.float64)
    colors = _decode_colors(data[:, 3:6]) if width == 6 else None
    return _validate_cloud(PointCloud(data[:, :3], colors, name=path.stem))


def read_ply(path: str | Path) -> PointCloud:
    """Read ASCII PLY scalar vertex properties in any order; ignore other elements."""
    path = Path(path)
    # A binary stream lets us identify binary formats before decoding their body.
    with path.open("rb") as source:
        if source.readline().strip() != b"ply":
            raise ValueError(f"{path.name}: missing PLY signature")
        elements: list[dict[str, Any]] = []
        current: dict[str, Any] | None = None
        format_seen = False
        for _ in range(10_000):
            raw = source.readline()
            if not raw:
                raise ValueError(f"{path.name}: incomplete PLY header")
            try:
                tokens = raw.decode("ascii").strip().split()
            except UnicodeDecodeError as error:
                raise ValueError(f"{path.name}: invalid PLY header") from error
            if not tokens or tokens[0] in ("comment", "obj_info"):
                continue
            if tokens[0] == "format":
                if len(tokens) != 3:
                    raise ValueError(f"{path.name}: invalid PLY format declaration")
                if tokens[1] != "ascii":
                    raise ValueError(f"{path.name}: binary PLY is unsupported; export ASCII PLY first")
                if tokens[2] != "1.0":
                    raise ValueError(f"{path.name}: only ASCII PLY version 1.0 is supported")
                format_seen = True
            elif tokens[0] == "element":
                if len(tokens) != 3:
                    raise ValueError(f"{path.name}: invalid PLY element")
                try:
                    count = int(tokens[2])
                except ValueError as error:
                    raise ValueError(f"{path.name}: invalid PLY element count") from error
                if count < 0:
                    raise ValueError(f"{path.name}: PLY element count must be nonnegative")
                current = {"name": tokens[1], "count": count, "properties": []}
                elements.append(current)
            elif tokens[0] == "property":
                if current is None:
                    raise ValueError(f"{path.name}: PLY property without an element")
                if len(tokens) == 3 and tokens[1] in PLY_TYPES:
                    current["properties"].append((tokens[2], tokens[1]))
                elif len(tokens) == 5 and tokens[1] == "list" and tokens[2] in PLY_TYPES and tokens[3] in PLY_TYPES:
                    current["properties"].append((tokens[4], "list"))
                else:
                    raise ValueError(f"{path.name}: unsupported PLY property declaration")
            elif tokens[0] == "end_header":
                break
            else:
                raise ValueError(f"{path.name}: unsupported PLY header entry {tokens[0]!r}")
        else:
            raise ValueError(f"{path.name}: PLY header is too long")
        if not format_seen:
            raise ValueError(f"{path.name}: missing PLY format declaration")
        vertices = [element for element in elements if element["name"] == "vertex"]
        if len(vertices) != 1 or vertices[0]["count"] == 0:
            raise ValueError(f"{path.name}: expected one nonempty PLY vertex element")
        vertex = vertices[0]
        properties = vertex["properties"]
        if any(kind == "list" for _, kind in properties):
            raise ValueError(f"{path.name}: list-valued vertex properties are unsupported")
        names = [name for name, _ in properties]
        if len(set(names)) != len(names):
            raise ValueError(f"{path.name}: duplicate PLY vertex property")
        if not all(axis in names for axis in ("x", "y", "z")):
            raise ValueError(f"{path.name}: PLY vertices require x, y and z")
        rows: list[list[float]] = []
        for element in elements:
            for row_number in range(element["count"]):
                raw = source.readline()
                if not raw:
                    raise ValueError(f"{path.name}: missing data for PLY element {element['name']}")
                if element is not vertex:
                    continue
                try:
                    tokens = raw.decode("ascii").split()
                    if len(tokens) != len(properties):
                        raise ValueError("wrong number of properties")
                    rows.append([float(token) for token in tokens])
                except (UnicodeDecodeError, ValueError) as error:
                    raise ValueError(f"{path.name}: invalid ASCII PLY vertex {row_number}") from error
    data = np.asarray(rows, dtype=np.float64)
    positions = data[:, [names.index(axis) for axis in ("x", "y", "z")]]
    colors = None
    rgb_names = ("red", "green", "blue") if any(channel in names for channel in ("red", "green", "blue")) else ("r", "g", "b")
    if any(channel in names for channel in rgb_names):
        if not all(channel in names for channel in rgb_names):
            raise ValueError(f"{path.name}: RGB vertex properties must include all three channels")
        rgb_indices = [names.index(channel) for channel in rgb_names]
        rgb_types = [properties[index][1] for index in rgb_indices]
        colors = _decode_colors(data[:, rgb_indices], all(kind in ("uchar", "uint8") for kind in rgb_types))
    normals = None
    if any(axis in names for axis in ("nx", "ny", "nz")):
        if not all(axis in names for axis in ("nx", "ny", "nz")):
            raise ValueError(f"{path.name}: normal properties must include nx, ny and nz")
        normals = data[:, [names.index(axis) for axis in ("nx", "ny", "nz")]]
    ids = None
    for id_name in ("source_id", "vertex_id", "id"):
        if id_name in names:
            ids = data[:, names.index(id_name)]
            break
    return _validate_cloud(PointCloud(positions, colors, normals, ids, path.stem))


def read_point_cloud(path: str | Path) -> PointCloud:
    path = Path(path)
    if path.suffix.lower() == ".ply":
        return read_ply(path)
    if path.suffix.lower() in (".xyz", ".txt"):
        return read_xyz(path)
    raise ValueError("supported input formats are ASCII .ply, .xyz and .txt")


def srgb_to_linear(colors: np.ndarray) -> np.ndarray:
    return np.where(colors <= 0.04045, colors / 12.92, ((colors + 0.055) / 1.055) ** 2.4)


def normalize_positions(positions: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    minimum = positions.min(axis=0)
    maximum = positions.max(axis=0)
    center = minimum + (maximum - minimum) / 2.0
    extent = float(np.max(maximum - minimum))
    # A coincident cloud is still valid; finite defaults handle its neighborhoods.
    scale = extent if extent > EPSILON else 1.0
    normalized = (positions - center) / scale
    return normalized, {
        "sourceBounds": [minimum.tolist(), maximum.tolist()],
        "sourceCenter": center.tolist(),
        "sourceExtent": extent,
        "normalizationScale": scale,
        "normalization": "bounding-box center; longest extent equals one",
    }


def _id_noise(ids: np.ndarray, seed: int) -> np.ndarray:
    """Deterministic Gaussian noise keyed to source ID, stable after reordering."""
    def uniforms(stream: int) -> np.ndarray:
        with np.errstate(over="ignore"):
            value = ids.astype(np.uint64) + np.uint64(seed & ((1 << 64) - 1))
            value = value + np.uint64((stream * 0x9E3779B97F4A7C15) & ((1 << 64) - 1))
            value = (value ^ (value >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
            value = (value ^ (value >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
            value = value ^ (value >> np.uint64(31))
        return ((value >> np.uint64(11)).astype(np.float64) + 0.5) / float(1 << 53)
    first, second, third, fourth = (uniforms(index) for index in range(1, 5))
    radial = np.sqrt(-2.0 * np.log(first))
    angle = 2.0 * np.pi * second
    return np.column_stack((radial * np.cos(angle), radial * np.sin(angle), np.sqrt(-2.0 * np.log(third)) * np.cos(2.0 * np.pi * fourth)))


def nearest_neighbors(positions: np.ndarray, count: int, numpy_max_points: int = NUMPY_POINT_LIMIT, backend: str = "auto") -> tuple[np.ndarray, np.ndarray, str]:
    """Return exact distances/indices, excluding the query point itself."""
    n = len(positions)
    count = min(max(0, count), n - 1)
    if count == 0:
        return np.empty((n, 0)), np.empty((n, 0), dtype=np.int64), "none"
    if backend not in ("auto", "numpy", "scipy"):
        raise ValueError("neighbor backend must be auto, numpy or scipy")
    if backend != "numpy":
        try:
            from scipy.spatial import cKDTree
        except ImportError:
            if backend == "scipy":
                raise ValueError("SciPy backend requested but SciPy is not installed") from None
        else:
            distances, indices = cKDTree(positions).query(positions, k=count + 1, workers=1)
            output_indices = np.empty((n, count), dtype=np.int64)
            output_distances = np.empty((n, count), dtype=np.float64)
            for row in range(n):
                valid = indices[row] != row
                row_indices = indices[row][valid][:count]
                row_distances = distances[row][valid][:count]
                order = np.lexsort((row_indices, row_distances))
                output_indices[row] = row_indices[order]
                output_distances[row] = row_distances[order]
            return output_distances, output_indices, "scipy.cKDTree"
    if n > numpy_max_points:
        raise ValueError(f"NumPy nearest-neighbor fallback is O(N^2) and limited to {numpy_max_points:,} points; install SciPy for this {n:,}-point cloud")
    distances = np.empty((n, count), dtype=np.float64)
    indices = np.empty((n, count), dtype=np.int64)
    # Squared-distance batches avoid an N by N allocation. At the default limit,
    # a 64-row batch plus its temporary arrays requires tens, not thousands, of MB.
    batch_size = 64
    for start in range(0, n, batch_size):
        stop = min(start + batch_size, n)
        differences = positions[start:stop, None, :] - positions[None, :, :]
        squared = np.einsum("ijk,ijk->ij", differences, differences)
        squared[np.arange(stop - start), np.arange(start, stop)] = np.inf
        selected = np.argpartition(squared, count - 1, axis=1)[:, :count]
        selected_squared = np.take_along_axis(squared, selected, axis=1)
        order = np.lexsort((selected, selected_squared), axis=1)
        indices[start:stop] = np.take_along_axis(selected, order, axis=1)
        distances[start:stop] = np.sqrt(np.take_along_axis(selected_squared, order, axis=1))
    return distances, indices, "numpy-exact-batched"


def _unit_feature(values: np.ndarray) -> tuple[np.ndarray, float]:
    scale = float(np.quantile(values, 0.95))
    if scale <= 1e-8:
        # Rare isolated features should not disappear when 95% of a cloud is flat.
        scale = float(np.max(values))
    if scale <= 1e-8:
        return np.zeros_like(values), 0.0
    return np.clip(values / scale, 0.0, 1.0), scale


def preprocess_cloud(cloud: PointCloud, *, neighbors: int = 24, outer_neighbors: int | None = None, noise_std: float = 0.0, seed: int = 7, numpy_max_points: int = NUMPY_POINT_LIMIT, backend: str = "auto", use_input_normals: bool = False, extra_metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compute PCA and two-scale appearance features without changing source IDs.

    noise_std is a fraction of the original bounding-box longest extent. Noise
    is added before normalization and before *all* feature recomputation. The
    usual output normals are PCA estimates; use_input_normals optionally retains
    valid supplied normals only when noise_std is zero.
    """
    cloud = _validate_cloud(cloud)
    if neighbors < 3:
        raise ValueError("neighbors must be at least 3")
    if not np.isfinite(noise_std) or noise_std < 0:
        raise ValueError("noise_std must be finite and nonnegative")
    outer_neighbors = neighbors * 3 if outer_neighbors is None else outer_neighbors
    if outer_neighbors <= neighbors:
        raise ValueError("outer_neighbors must be greater than neighbors")
    original_positions, metadata = normalize_positions(cloud.positions)
    positions = original_positions.copy()
    if noise_std:
        positions, noise_normalization = normalize_positions(original_positions + _id_noise(cloud.ids, seed) * noise_std)
        metadata["noiseNormalization"] = noise_normalization
    n = len(positions)
    distances, indices, neighbor_backend = nearest_neighbors(positions, outer_neighbors, numpy_max_points, backend)
    inner_count = min(neighbors, max(0, n - 1))
    normals = np.tile(np.array([0.0, 0.0, 1.0]), (n, 1))
    curvature = np.zeros(n)
    confidence = np.zeros(n)
    radii = np.full(n, 0.005)
    if inner_count:
        local = np.concatenate((positions[:, None, :], positions[indices[:, :inner_count]]), axis=1)
        centered = local - local.mean(axis=1, keepdims=True)
        covariance = np.einsum("nki,nkj->nij", centered, centered) / local.shape[1]
        eigenvalues, eigenvectors = np.linalg.eigh(covariance)
        eigenvalues = np.maximum(eigenvalues, 0.0)
        normals = eigenvectors[:, :, 0]
        dominant = np.argmax(np.abs(normals), axis=1)
        signs = np.where(normals[np.arange(n), dominant] < 0, -1.0, 1.0)
        normals *= signs[:, None]
        curvature = eigenvalues[:, 0] / np.maximum(eigenvalues.sum(axis=1), EPSILON)
        confidence = np.clip((eigenvalues[:, 1] - eigenvalues[:, 0]) / np.maximum(eigenvalues[:, 1], EPSILON), 0.0, 1.0)
        confidence *= min(1.0, inner_count / neighbors)
        radii = np.maximum(np.median(distances[:, :min(6, inner_count)], axis=1) * 0.5, 1e-5)
    normal_source = "local PCA"
    if use_input_normals and cloud.normals is not None and noise_std == 0:
        lengths = np.linalg.norm(cloud.normals, axis=1)
        valid = lengths > EPSILON
        normals[valid] = cloud.normals[valid] / lengths[valid, None]
        normal_source = "supplied normals; local PCA for zero-length entries"
    colors = cloud.colors if cloud.colors is not None else np.tile(DEFAULT_COLOR, (n, 1))
    contrast = np.zeros(n)
    if cloud.colors is not None and inner_count and indices.shape[1] > inner_count:
        linear_colors = srgb_to_linear(colors)
        center = (linear_colors + linear_colors[indices[:, :inner_count]].sum(axis=1)) / (inner_count + 1)
        surround = linear_colors[indices[:, inner_count:]].mean(axis=1)
        contrast = np.linalg.norm(center - surround, axis=1) / np.sqrt(3.0)
    geometry, geometry_scale = _unit_feature(curvature)
    saliency, appearance_scale = _unit_feature(contrast)
    metadata.update({
        "hasColors": cloud.colors is not None,
        "hasInputNormals": cloud.normals is not None,
        "normalSource": normal_source,
        "normalOrientation": "PCA normal's largest-magnitude component is positive",
        "sourceIdPolicy": "PLY source_id/vertex_id/id when supplied; otherwise original vertex index",
        "neighborBackend": neighbor_backend,
        "innerNeighbors": inner_count,
        "outerNeighbors": indices.shape[1],
        "curvatureDefinition": "smallest local PCA eigenvalue / sum of eigenvalues",
        "geometryScale": geometry_scale,
        "appearanceDefinition": "linear-RGB inner-neighborhood mean versus outer-ring mean; Euclidean difference / sqrt(3)",
        "appearanceScale": appearance_scale,
        "featureScaling": "divide by 95th percentile and clamp; maximum fallback for sparse features",
        "confidenceDefinition": "(middle - smallest PCA eigenvalue) / middle; small-neighborhood coverage factor",
        "radiusDefinition": "half the median distance to up to six nearest neighbors; minimum 0.00001",
        "noiseStd": float(noise_std),
        "noiseSeed": int(seed),
        "noiseDefinition": "Gaussian displacement as a fraction of original longest extent; keyed to persistent source ID",
    })
    if extra_metadata:
        metadata["dataset"] = extra_metadata
    result = {
        "version": SCHEMA_VERSION,
        "name": cloud.name,
        "count": n,
        "positions": np.round(positions, 6).ravel().tolist(),
        "normals": np.round(normals, 6).ravel().tolist(),
        "colors": np.round(colors, 6).ravel().tolist(),
        "radii": np.round(radii, 6).tolist(),
        "geometry": np.round(geometry, 6).tolist(),
        "saliency": np.round(saliency, 6).tolist(),
        "confidence": np.round(confidence, 6).tolist(),
        "ids": cloud.ids.tolist(),
        "metadata": metadata,
    }
    # Avoid silently saving NaN/Infinity even if a future feature is added.
    json.dumps(result, allow_nan=False)
    return result


def write_processed(path: str | Path, result: dict[str, Any]) -> int:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n"
    path.write_text(encoded, encoding="utf-8")
    return len(encoded.encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path, help="ASCII PLY or XYZ input")
    parser.add_argument("output", type=Path, help="processed JSON output")
    parser.add_argument("--neighbors", type=int, default=24, help="local PCA / center neighborhood (default: 24)")
    parser.add_argument("--outer-neighbors", type=int, help="appearance outer neighborhood (default: 3 times neighbors)")
    parser.add_argument("--noise", type=float, default=0.0, help="Gaussian standard deviation relative to original extent")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--backend", choices=("auto", "numpy", "scipy"), default="auto")
    parser.add_argument("--numpy-max-points", type=int, default=NUMPY_POINT_LIMIT)
    parser.add_argument("--use-input-normals", action="store_true", help="retain supplied normals when no noise is added")
    options = parser.parse_args()
    try:
        cloud = read_point_cloud(options.input)
        result = preprocess_cloud(cloud, neighbors=options.neighbors, outer_neighbors=options.outer_neighbors, noise_std=options.noise, seed=options.seed, backend=options.backend, numpy_max_points=options.numpy_max_points, use_input_normals=options.use_input_normals)
        size = write_processed(options.output, result)
    except (OSError, ValueError) as error:
        parser.exit(2, f"preprocess: {error}\n")
    print(f"Processed {result['count']:,} points -> {options.output} ({size:,} bytes; {result['metadata']['neighborBackend']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
