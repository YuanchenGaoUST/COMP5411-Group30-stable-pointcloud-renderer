#!/usr/bin/env python3
"""Sample OBJ or ASCII/binary PLY triangle surfaces for the point-cloud viewer.

Sampling is uniform in triangle area, with deterministic barycentric points and
persistent zero-based sample IDs. Vertex RGB and normals are interpolated when
present. OBJ material textures are not evaluated. Uncolored sources receive a
uniform pearl-white display color and zero appearance saliency.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
from typing import BinaryIO

import numpy as np

try:
    from .preprocess import PointCloud, _decode_colors, preprocess_cloud, write_processed
except ImportError:
    from preprocess import PointCloud, _decode_colors, preprocess_cloud, write_processed


Mesh = tuple[np.ndarray, np.ndarray, np.ndarray | None, np.ndarray | None]
DEFAULT_COUNT = 12_000
DEFAULT_SEED = 20_261_010
PEARL_WHITE = (0.92, 0.91, 0.88)
MAX_ELEMENT_ROWS = 10_000_000
MAX_LIST_ITEMS = 1_000_000
MAX_TRIANGLES = 10_000_000
MAX_LINE_BYTES = 16 * 1024 * 1024
_PLY_TYPES = {
    "char": "b", "int8": "b", "uchar": "B", "uint8": "B",
    "short": "h", "int16": "h", "ushort": "H", "uint16": "H",
    "int": "i", "int32": "i", "uint": "I", "uint32": "I",
    "float": "f", "float32": "f", "double": "d", "float64": "d",
}
_INTEGER_TYPES = {name for name, kind in _PLY_TYPES.items() if kind not in "fd"}


def _validate_mesh(mesh: Mesh) -> Mesh:
    vertices, faces, colors, normals = mesh
    vertices = np.asarray(vertices, dtype=np.float64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or len(vertices) == 0:
        raise ValueError("mesh vertices must be a nonempty N by 3 array")
    if not np.isfinite(vertices).all():
        raise ValueError("mesh vertices contain non-finite values (NaN or infinity)")
    faces = np.asarray(faces)
    if faces.ndim != 2 or faces.shape[1] != 3 or len(faces) == 0:
        raise ValueError("mesh must contain triangular faces")
    if not np.issubdtype(faces.dtype, np.integer):
        raise ValueError("mesh face indices must be integers")
    if (faces < 0).any() or (faces >= len(vertices)).any():
        raise ValueError("mesh face index is outside the vertex array")
    for label, values in (("colors", colors), ("normals", normals)):
        if values is not None:
            values = np.asarray(values, dtype=np.float64)
            if values.shape != vertices.shape or not np.isfinite(values).all():
                raise ValueError(f"mesh {label} must be a finite N by 3 array")
            if label == "colors":
                if (values < 0).any() or (values > 1).any():
                    raise ValueError("mesh colors must be sRGB values in the range 0 to 1")
                colors = values
            else:
                normals = values
    return vertices, faces.astype(np.int64, copy=False), colors, normals


def _triangulate(polygon: list[int], triangles: list[list[int]]) -> None:
    if len(polygon) < 3:
        raise ValueError("mesh faces need at least three vertices")
    if len(triangles) + len(polygon) - 2 > MAX_TRIANGLES:
        raise ValueError("mesh contains too many triangulated faces")
    triangles.extend([polygon[0], polygon[index], polygon[index + 1]] for index in range(1, len(polygon) - 1))


def _obj_index(token: str, count: int) -> int:
    try:
        index = int(token)
    except ValueError as error:
        raise ValueError(f"invalid OBJ index {token!r}") from error
    resolved = index - 1 if index > 0 else count + index
    if index == 0 or resolved < 0 or resolved >= count:
        raise ValueError(f"OBJ index {index} is outside its {count}-entry array")
    return resolved


def _read_obj(path: Path) -> Mesh:
    vertices: list[list[float]] = []
    colors: list[list[float] | None] = []
    source_normals: list[list[float]] = []
    texture_count = 0
    polygons: list[list[tuple[int, int | None]]] = []
    with path.open("r", encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, 1):
            tokens = line.split("#", 1)[0].split()
            if not tokens:
                continue
            try:
                kind, values = tokens[0], tokens[1:]
                if kind == "v":
                    if len(values) not in (3, 4, 6, 7):
                        raise ValueError("OBJ vertex requires XYZ, XYZ W, or XYZ RGB [A]")
                    row = [float(value) for value in values]
                    if not np.isfinite(row).all():
                        raise ValueError("OBJ vertex contains non-finite values")
                    xyz = row[:3]
                    if len(row) == 4:
                        if row[3] == 0:
                            raise ValueError("OBJ homogeneous vertex weight cannot be zero")
                        xyz = [value / row[3] for value in xyz]
                    vertices.append(xyz)
                    colors.append(row[3:6] if len(row) >= 6 else None)
                elif kind == "vn":
                    if len(values) != 3:
                        raise ValueError("OBJ normal requires three components")
                    row = [float(value) for value in values]
                    if not np.isfinite(row).all():
                        raise ValueError("OBJ normal contains non-finite values")
                    source_normals.append(row)
                elif kind == "vt":
                    if not 1 <= len(values) <= 3 or not np.isfinite([float(value) for value in values]).all():
                        raise ValueError("invalid OBJ texture coordinates")
                    texture_count += 1
                elif kind == "f":
                    if len(values) > MAX_LIST_ITEMS:
                        raise ValueError("OBJ face has too many vertices")
                    corners = []
                    for value in values:
                        parts = value.split("/")
                        if not 1 <= len(parts) <= 3 or not parts[0]:
                            raise ValueError("invalid OBJ face token")
                        vertex_index = _obj_index(parts[0], len(vertices))
                        if len(parts) >= 2 and parts[1]:
                            _obj_index(parts[1], texture_count)
                        if len(parts) == 2 and not parts[1]:
                            raise ValueError("invalid OBJ texture index")
                        normal_index = _obj_index(parts[2], len(source_normals)) if len(parts) == 3 and parts[2] else None
                        if len(parts) == 3 and normal_index is None:
                            raise ValueError("invalid OBJ normal index")
                        corners.append((vertex_index, normal_index))
                    if len(corners) < 3:
                        raise ValueError("OBJ face requires at least three vertices")
                    polygons.append(corners)
                # Groups, material declarations and smoothing flags do not affect
                # geometry. Texture material colors are deliberately not invented.
            except (ValueError, OverflowError) as error:
                raise ValueError(f"{path.name}:{line_number}: {error}") from error
    has_colors = any(color is not None for color in colors)
    if has_colors and not all(color is not None for color in colors):
        raise ValueError(f"{path.name}: RGB must be supplied for every OBJ vertex")
    has_normals = any(normal is not None for polygon in polygons for _, normal in polygon)
    # OBJ normals belong to face corners. Split vertices at normal seams so the
    # returned vertex/face arrays retain those supplied normals exactly.
    output_vertices = list(vertices)
    output_colors = list(colors)
    output_normals = [[0.0, 0.0, 0.0] for _ in vertices]
    corner_map: dict[tuple[int, int | None], int] = {}
    assigned: set[int] = set()
    triangles: list[list[int]] = []
    for polygon in polygons:
        indices = []
        for vertex_index, normal_index in polygon:
            key = (vertex_index, normal_index)
            if key not in corner_map:
                if vertex_index not in assigned:
                    index = vertex_index
                    assigned.add(vertex_index)
                else:
                    index = len(output_vertices)
                    output_vertices.append(vertices[vertex_index])
                    output_colors.append(colors[vertex_index])
                    output_normals.append([0.0, 0.0, 0.0])
                corner_map[key] = index
                if normal_index is not None:
                    output_normals[index] = source_normals[normal_index]
            indices.append(corner_map[key])
        _triangulate(indices, triangles)
    rgb = _decode_colors(np.asarray(output_colors, dtype=np.float64)) if has_colors else None
    normals = np.asarray(output_normals, dtype=np.float64) if has_normals else None
    return _validate_mesh((np.asarray(output_vertices), np.asarray(triangles), rgb, normals))


def _read_exact(source: BinaryIO, count: int) -> bytes:
    data = source.read(count)
    if len(data) != count:
        raise ValueError("truncated binary PLY body")
    return data


def _ascii_scalar(token: str, kind: str) -> int | float:
    value = int(token) if kind in _INTEGER_TYPES else float(token)
    if kind in _INTEGER_TYPES:
        code = _PLY_TYPES[kind]
        bits = struct.calcsize(code) * 8
        low, high = (0, 2 ** bits - 1) if code.isupper() else (-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
        if not low <= value <= high:
            raise ValueError("ASCII PLY integer outside its declared type")
    elif not np.isfinite(value):
        raise ValueError("PLY contains non-finite values")
    return value


def _read_ply(path: Path) -> Mesh:
    file_size = path.stat().st_size
    with path.open("rb") as source:
        if source.readline(128).strip() != b"ply":
            raise ValueError(f"{path.name}: missing PLY signature")
        elements: list[dict] = []
        current = None
        file_format = None
        for _ in range(10_000):
            raw = source.readline(65_537)
            if not raw or len(raw) > 65_536:
                raise ValueError("incomplete or oversized PLY header")
            try:
                tokens = raw.decode("ascii").split()
            except UnicodeDecodeError as error:
                raise ValueError("invalid PLY header encoding") from error
            if not tokens or tokens[0] in ("comment", "obj_info"):
                continue
            if tokens[0] == "format":
                if len(tokens) != 3 or tokens[2] != "1.0" or file_format is not None:
                    raise ValueError("invalid PLY format declaration")
                file_format = tokens[1]
                if file_format not in ("ascii", "binary_little_endian", "binary_big_endian"):
                    raise ValueError("unsupported PLY format")
            elif tokens[0] == "element":
                if len(tokens) != 3:
                    raise ValueError("invalid PLY element declaration")
                count = int(tokens[2])
                if not 0 <= count <= MAX_ELEMENT_ROWS:
                    raise ValueError("PLY element count is negative or exceeds the safe limit")
                current = {"name": tokens[1], "count": count, "properties": []}
                elements.append(current)
            elif tokens[0] == "property":
                if current is None:
                    raise ValueError("PLY property without an element")
                if len(tokens) == 3 and tokens[1] in _PLY_TYPES:
                    prop = (tokens[2], tokens[1], None)
                elif len(tokens) == 5 and tokens[1] == "list" and tokens[2] in _INTEGER_TYPES and tokens[3] in _PLY_TYPES:
                    prop = (tokens[4], tokens[3], tokens[2])
                else:
                    raise ValueError("invalid PLY property declaration")
                if len(current["properties"]) >= 256 or any(other[0] == prop[0] for other in current["properties"]):
                    raise ValueError("duplicate or excessive PLY properties")
                current["properties"].append(prop)
            elif tokens[0] == "end_header" and len(tokens) == 1:
                break
            else:
                raise ValueError("unsupported PLY header entry")
        else:
            raise ValueError("PLY header is too long")
        if file_format is None:
            raise ValueError("missing PLY format declaration")
        vertex_elements = [element for element in elements if element["name"] == "vertex"]
        face_elements = [element for element in elements if element["name"] == "face"]
        if len(vertex_elements) != 1 or vertex_elements[0]["count"] == 0 or len(face_elements) != 1:
            raise ValueError("PLY mesh requires one nonempty vertex element and one face element")
        vertex = vertex_elements[0]
        properties = vertex["properties"]
        names = [prop[0] for prop in properties]
        if any(prop[2] is not None for prop in properties):
            raise ValueError("list-valued PLY vertex properties are unsupported")
        if not all(axis in names for axis in ("x", "y", "z")):
            raise ValueError("PLY vertices require x, y and z")
        face = face_elements[0]
        index_properties = [prop for prop in face["properties"] if prop[0] in ("vertex_indices", "vertex_index")]
        if len(index_properties) != 1 or index_properties[0][2] is None or index_properties[0][1] not in _INTEGER_TYPES:
            raise ValueError("PLY faces require a list of integer vertex_indices")
        index_name = index_properties[0][0]
        minimum_bytes = 0
        for element in elements:
            if element["count"] and not element["properties"]:
                raise ValueError("nonempty PLY element has no properties")
            row_minimum = len(element["properties"]) if file_format == "ascii" else sum(struct.calcsize(_PLY_TYPES[prop[2] or prop[1]]) for prop in element["properties"])
            minimum_bytes += element["count"] * row_minimum
        if minimum_bytes > file_size - source.tell():
            raise ValueError("PLY element counts exceed the available body data")
        endian = "<" if file_format == "binary_little_endian" else ">"
        rows = []
        triangles: list[list[int]] = []
        for element in elements:
            for row_number in range(element["count"]):
                captured = {}
                if file_format == "ascii":
                    raw = source.readline(MAX_LINE_BYTES + 1)
                    if not raw or len(raw) > MAX_LINE_BYTES:
                        raise ValueError("missing or oversized ASCII PLY row")
                    try:
                        tokens = raw.decode("ascii").split()
                        cursor = 0
                        for name, kind, count_kind in element["properties"]:
                            if count_kind is None:
                                captured[name] = _ascii_scalar(tokens[cursor], kind)
                                cursor += 1
                            else:
                                count = _ascii_scalar(tokens[cursor], count_kind)
                                cursor += 1
                                if not 0 <= count <= MAX_LIST_ITEMS:
                                    raise ValueError("PLY list count is negative or exceeds the safe limit")
                                if count > len(tokens) - cursor:
                                    raise ValueError("truncated ASCII PLY list")
                                values = [_ascii_scalar(token, kind) for token in tokens[cursor:cursor + count]]
                                if element is face and name == index_name:
                                    captured[name] = values
                                cursor += count
                        if cursor != len(tokens):
                            raise ValueError("wrong number of ASCII PLY properties")
                    except (IndexError, UnicodeDecodeError, ValueError) as error:
                        raise ValueError(f"{path.name}: invalid ASCII PLY {element['name']} row {row_number}: {error}") from error
                else:
                    for name, kind, count_kind in element["properties"]:
                        scalar = struct.Struct(endian + _PLY_TYPES[count_kind or kind])
                        value = scalar.unpack(_read_exact(source, scalar.size))[0]
                        if count_kind is None:
                            captured[name] = value
                        else:
                            if not 0 <= value <= MAX_LIST_ITEMS:
                                raise ValueError("PLY list count is negative or exceeds the safe limit")
                            byte_count = value * struct.calcsize(_PLY_TYPES[kind])
                            if byte_count > file_size - source.tell():
                                raise ValueError("truncated binary PLY list")
                            if element is face and name == index_name:
                                data = _read_exact(source, byte_count)
                                captured[name] = list(struct.unpack(endian + str(value) + _PLY_TYPES[kind], data))
                            else:
                                source.seek(byte_count, 1)
                if element is vertex:
                    rows.append([captured[name] for name in names])
                elif element is face:
                    polygon = captured[index_name]
                    if any(index < 0 or index >= vertex["count"] for index in polygon):
                        raise ValueError("PLY face index is outside the vertex array")
                    _triangulate(polygon, triangles)
    data = np.asarray(rows, dtype=np.float64)
    positions = data[:, [names.index(axis) for axis in ("x", "y", "z")]]
    colors = None
    rgb_names = ("red", "green", "blue") if any(name in names for name in ("red", "green", "blue")) else ("r", "g", "b")
    if any(name in names for name in rgb_names):
        if not all(name in names for name in rgb_names):
            raise ValueError("PLY RGB properties must include all three channels")
        indices = [names.index(name) for name in rgb_names]
        colors = _decode_colors(data[:, indices], all(properties[index][1] in ("uchar", "uint8") for index in indices))
    normals = None
    if any(axis in names for axis in ("nx", "ny", "nz")):
        if not all(axis in names for axis in ("nx", "ny", "nz")):
            raise ValueError("PLY normals require nx, ny and nz")
        normals = data[:, [names.index(axis) for axis in ("nx", "ny", "nz")]]
    return _validate_mesh((positions, np.asarray(triangles), colors, normals))


def load_mesh(path: Path) -> Mesh:
    """Read OBJ or PLY and fan-triangulate polygons, preserving vertex attributes."""
    path = Path(path)
    if path.suffix.lower() == ".obj":
        return _read_obj(path)
    if path.suffix.lower() == ".ply":
        return _read_ply(path)
    raise ValueError("supported mesh formats are .obj and .ply")


def _triangle_geometry(mesh: Mesh) -> tuple[np.ndarray, np.ndarray]:
    vertices, faces, _, _ = mesh
    with np.errstate(over="ignore", invalid="ignore"):
        cross = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]], vertices[faces[:, 2]] - vertices[faces[:, 0]])
        # hypot avoids squaring finite large or tiny coordinates unnecessarily.
        doubled_area = np.hypot(np.hypot(cross[:, 0], cross[:, 1]), cross[:, 2])
    if not np.isfinite(doubled_area).all():
        raise ValueError("mesh triangle areas are non-finite; rescale the input coordinates")
    return doubled_area * 0.5, cross


def sample_mesh(mesh: Mesh, count: int = DEFAULT_COUNT, seed: int = DEFAULT_SEED) -> PointCloud:
    """Return deterministic samples uniformly distributed on actual mesh faces."""
    if isinstance(count, bool) or not isinstance(count, (int, np.integer)) or not 1 <= count <= np.iinfo(np.uint32).max:
        raise ValueError("sample count must be a positive integer fitting a 32-bit source ID")
    mesh = _validate_mesh(mesh)
    vertices, faces, colors, normals = mesh
    areas, cross = _triangle_geometry(mesh)
    valid = np.flatnonzero(areas > 0)
    if len(valid) == 0:
        raise ValueError("mesh has no nondegenerate triangle surface to sample")
    # Scaling preserves relative area while preventing total-area overflow.
    weights = areas[valid] / areas[valid].max()
    rng = np.random.default_rng(seed)
    selected = rng.choice(valid, size=count, p=weights / weights.sum())
    root = np.sqrt(rng.random(count))
    second = rng.random(count)
    barycentric = np.column_stack((1.0 - root, root * (1.0 - second), root * second))
    corners = faces[selected]
    positions = np.einsum("ni,nij->nj", barycentric, vertices[corners])
    # Floating-point summation can put an interpolated white vertex 1 ulp above
    # one, even though the exact convex combination remains in the RGB cube.
    sampled_colors = None if colors is None else np.clip(np.einsum("ni,nij->nj", barycentric, colors[corners]), 0.0, 1.0)
    sampled_normals = None
    if normals is not None:
        sampled_normals = np.einsum("ni,nij->nj", barycentric, normals[corners])
        scales = np.max(np.abs(sampled_normals), axis=1)
        valid_normals = scales > 0
        sampled_normals[valid_normals] /= scales[valid_normals, None]
        lengths = np.linalg.norm(sampled_normals[valid_normals], axis=1)
        sampled_normals[valid_normals] /= lengths[:, None]
        sampled_normals[~valid_normals] = cross[selected[~valid_normals]] / (2.0 * areas[selected[~valid_normals], None])
    return PointCloud(positions, sampled_colors, sampled_normals, np.arange(count, dtype=np.int64))


def _orient_cloud(cloud: PointCloud, up_axis: str) -> PointCloud:
    if up_axis == "y":
        return cloud
    # A proper rotation about X: (x,y,z) -> (x,z,-y), so Z-up becomes Y-up.
    positions = cloud.positions[:, [0, 2, 1]].copy()
    positions[:, 2] *= -1
    normals = None if cloud.normals is None else cloud.normals[:, [0, 2, 1]].copy()
    if normals is not None:
        normals[:, 2] *= -1
    return PointCloud(positions, cloud.colors, normals, cloud.ids, cloud.name)


def write_point_ply(path: Path, result: dict) -> None:
    """Export processed points as ASCII PLY, with no face/mesh elements."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    header = ["ply", "format ascii 1.0", "comment Area-weighted mesh surface samples; normalized processed coordinates", f"element vertex {result['count']}"]
    for name in ("x", "y", "z", "nx", "ny", "nz"):
        header.append(f"property float {name}")
    header.extend(f"property uchar {name}" for name in ("red", "green", "blue"))
    header.extend(("property uint source_id", "end_header"))
    positions = np.asarray(result["positions"]).reshape(-1, 3)
    normals = np.asarray(result["normals"]).reshape(-1, 3)
    colors = np.rint(np.asarray(result["colors"]).reshape(-1, 3) * 255).astype(np.uint8)
    with path.open("w", encoding="ascii") as output:
        output.write("\n".join(header) + "\n")
        for position, normal, color, source_id in zip(positions, normals, colors, result["ids"]):
            values = [*(f"{value:.7f}" for value in position), *(f"{value:.7f}" for value in normal), *(str(int(value)) for value in color), str(int(source_id))]
            output.write(" ".join(values) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path, help="processed viewer JSON")
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--name", help="dataset name (default: input filename stem)")
    parser.add_argument("--source-url", default="", help="source asset's provenance URL")
    parser.add_argument("--license", default="unspecified", help="source license or usage terms")
    parser.add_argument("--up-axis", choices=("y", "z"), default="y")
    parser.add_argument("--ply", type=Path, help="also export normalized processed points as ASCII PLY")
    parser.add_argument("--backend", choices=("auto", "numpy", "scipy"), default="auto")
    parser.add_argument("--neighbors", type=int, default=24)
    parser.add_argument("--use-input-normals", action="store_true", help="retain interpolated supplied normals; still compute real local PCA features")
    options = parser.parse_args(argv)
    try:
        mesh = load_mesh(options.input)
        areas, _ = _triangle_geometry(mesh)
        cloud = _orient_cloud(sample_mesh(mesh, options.count, options.seed), options.up_axis)
        cloud = PointCloud(cloud.positions, cloud.colors, cloud.normals, cloud.ids, options.name or options.input.stem)
        digest = hashlib.sha256()
        with options.input.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        metadata = {
            "source": "mesh-derived",
            "originalFilename": options.input.name,
            "originalSha256": digest.hexdigest(),
            "sourceURL": options.source_url,
            "license": options.license,
            "samplingMethod": "triangle-area weighted; uniform square-root barycentric surface sampling",
            "samplingSeed": options.seed,
            "samplingCount": options.count,
            "sourceIdPolicy": "zero-based deterministic sample index; not a mesh vertex ID",
            "inputUpAxis": options.up_axis,
            "outputUpAxis": "y",
            "orientationTransform": "identity" if options.up_axis == "y" else "(x,y,z) -> (x,z,-y)",
            "originalMesh": {
                "vertexCount": len(mesh[0]),
                "triangleCount": len(mesh[1]),
                "degenerateTriangleCount": int(np.count_nonzero(areas == 0)),
                "surfaceArea": float(np.sum(areas, dtype=np.longdouble)),
                "bounds": [mesh[0].min(axis=0).tolist(), mesh[0].max(axis=0).tolist()],
                "triangulation": "polygon fan; OBJ vertices split where corner normals differ",
                "hasVertexRGB": mesh[2] is not None,
                "hasSuppliedNormals": mesh[3] is not None,
            },
            "colorSource": "barycentric interpolation of source vertex RGB" if cloud.colors is not None else "uniform pearl-white display fallback; source has no vertex RGB; material textures are not sampled",
            "colorFallback": None if cloud.colors is not None else {"srgb": list(PEARL_WHITE), "appearanceSaliency": 0},
        }
        result = preprocess_cloud(cloud, neighbors=options.neighbors, seed=options.seed, backend=options.backend, use_input_normals=options.use_input_normals, extra_metadata=metadata)
        result["metadata"]["sourceIdPolicy"] = metadata["sourceIdPolicy"]
        if cloud.colors is None:
            result["colors"] = np.tile(PEARL_WHITE, (options.count, 1)).ravel().tolist()
        json.dumps(result, allow_nan=False)
        size = write_processed(options.output, result)
        if options.ply:
            write_point_ply(options.ply, result)
    except (OSError, ValueError, OverflowError) as error:
        parser.exit(2, f"sample_mesh: {error}\n")
    print(f"Sampled {result['count']:,} mesh surface points -> {options.output} ({size:,} bytes; {result['metadata']['neighborBackend']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
