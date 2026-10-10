"""Mesh readers, surface sampling and processed point export regression checks."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from preprocess import read_ply
from sample_mesh import PEARL_WHITE, _orient_cloud, load_mesh, main, sample_mesh


class MeshSamplingTests(unittest.TestCase):
    @staticmethod
    def triangle(colors=None, normals=None):
        return (np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]), np.array([[0, 1, 2]]), colors, normals)

    def test_obj_quad_slash_negative_indices_and_rgb(self):
        text = """# Vertex RGB extension; face includes negative position/UV/normal indices.
v 0 0 0 255 0 0
v 1 0 0 0 255 0
v 1 1 0 0 0 255
v 0 1 0 255 255 255
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 2
usemtl ignored-texture
f -4/-4/-1 -3/-3/-1 -2/-2/-1 -1/-1/-1 # quad
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "quad.obj"
            path.write_text(text)
            vertices, faces, colors, normals = load_mesh(path)
        np.testing.assert_array_equal(faces, [[0, 1, 2], [0, 2, 3]])
        np.testing.assert_array_equal(vertices, [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])
        np.testing.assert_array_equal(colors, [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]])
        np.testing.assert_array_equal(normals, np.tile([0, 0, 2], (4, 1)))

    def test_obj_double_slash_normals_preserve_corner_seams(self):
        text = "v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nvn 0 0 -1\nf 1//1 2//1 3//1\nf 1//2 3//2 2//2\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seam.obj"
            path.write_text(text)
            vertices, faces, colors, normals = load_mesh(path)
        self.assertEqual(len(vertices), 6)
        self.assertIsNone(colors)
        np.testing.assert_array_equal(normals[faces[0]], np.tile([0, 0, 1], (3, 1)))
        np.testing.assert_array_equal(normals[faces[1]], np.tile([0, 0, -1], (3, 1)))

    def test_obj_position_uv_only_and_homogeneous_vertex(self):
        text = "v 0 0 0 2\nv 2 0 0 2\nv 0 2 0 2\nvt 0\nf 1/1 2/1 3/1\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "homogeneous.obj"
            path.write_text(text)
            vertices, faces, colors, normals = load_mesh(path)
        np.testing.assert_array_equal(vertices, self.triangle()[0])
        np.testing.assert_array_equal(faces, [[0, 1, 2]])
        self.assertIsNone(colors)
        self.assertIsNone(normals)

    def test_ascii_ply_property_order_and_unrelated_face_properties(self):
        text = """ply
format ascii 1.0
element vertex 4
property uchar blue
property double y
property float x
property uchar red
property float z
property uchar green
element face 1
property float quality
property list uchar float texcoord
property list uchar uint vertex_indices
property ushort material
end_header
0 0 0 255 0 0
0 0 1 0 0 255
255 1 1 0 0 0
255 1 0 255 0 255
0.7 4 0.1 0.2 0.3 0.4 4 0 1 2 3 19
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ordered.ply"
            path.write_text(text)
            vertices, faces, colors, normals = load_mesh(path)
        np.testing.assert_array_equal(faces, [[0, 1, 2], [0, 2, 3]])
        np.testing.assert_array_equal(vertices[2], [1, 1, 0])
        np.testing.assert_array_equal(colors[0], [1, 0, 0])
        self.assertIsNone(normals)

    @staticmethod
    def binary_ply(endian):
        encoding = "binary_little_endian" if endian == "<" else "binary_big_endian"
        header = f"""ply
format {encoding} 1.0
element vertex 3
property uchar blue
property double z
property float x
property short nx
property float y
property uchar red
property short ny
property uchar green
property short nz
element auxiliary 1
property list uchar double ignored
element face 1
property uchar material
property list ushort float texcoord
property float quality
property list uchar int vertex_indices
property int trailing
end_header
""".encode("ascii")
        body = b"".join(struct.pack(endian + "BdfhfBhBh", blue, 0.0, x, 0, y, red, 0, green, 4) for x, y, red, green, blue in ((0, 0, 255, 0, 0), (1, 0, 0, 255, 0), (0, 1, 0, 0, 255)))
        body += struct.pack(endian + "B2d", 2, 13.0, 14.0)
        body += struct.pack(endian + "BH4ffB3ii", 7, 4, 0.0, 0.0, 1.0, 1.0, 0.5, 3, 0, 1, 2, 123)
        return header + body

    def test_binary_ply_mixed_scalar_list_properties_both_byte_orders(self):
        with tempfile.TemporaryDirectory() as directory:
            for endian in ("<", ">"):
                with self.subTest(endian=endian):
                    path = Path(directory) / "mixed.ply"
                    path.write_bytes(self.binary_ply(endian))
                    vertices, faces, colors, normals = load_mesh(path)
                    np.testing.assert_array_equal(vertices, self.triangle()[0])
                    np.testing.assert_array_equal(faces, [[0, 1, 2]])
                    np.testing.assert_array_equal(colors, np.eye(3))
                    np.testing.assert_array_equal(normals, np.tile([0, 0, 4], (3, 1)))

    def test_uniform_barycentric_distribution_and_attribute_interpolation(self):
        normals = np.tile([0, 0, 2], (3, 1))
        cloud = sample_mesh(self.triangle(np.eye(3), normals), 40_000, 38)
        self.assertTrue((cloud.positions[:, :2] >= 0).all())
        self.assertTrue((cloud.positions[:, 0] + cloud.positions[:, 1] <= 1 + 1e-14).all())
        np.testing.assert_array_equal(cloud.positions[:, 2], 0)
        np.testing.assert_allclose(cloud.positions.mean(axis=0), [1 / 3, 1 / 3, 0], atol=0.006)
        np.testing.assert_allclose(cloud.colors[:, 1:3], cloud.positions[:, :2], atol=1e-14)
        np.testing.assert_allclose(cloud.colors[:, 0], 1 - cloud.positions[:, 0] - cloud.positions[:, 1], atol=1e-14)
        np.testing.assert_array_equal(cloud.normals, np.tile([0, 0, 1], (len(cloud.positions), 1)))
        # Area of the subtriangle near the origin is 1/4, not 1/2.
        fraction = np.mean(cloud.positions[:, 0] + cloud.positions[:, 1] < 0.5)
        self.assertAlmostEqual(float(fraction), 0.25, delta=0.01)

    def test_triangle_selection_is_proportional_to_surface_area(self):
        vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [10, 0, 0], [13, 0, 0], [10, 3, 0]], dtype=float)
        mesh = (vertices, np.array([[0, 1, 2], [3, 4, 5]]), None, None)
        cloud = sample_mesh(mesh, 40_000, 91)
        self.assertAlmostEqual(float(np.mean(cloud.positions[:, 0] > 5)), 0.9, delta=0.01)

    def test_white_rgb_stays_in_range_and_large_normals_are_normalized(self):
        cloud = sample_mesh(self.triangle(np.ones((3, 3)), np.full((3, 3), 1e308)), 10_000, 7)
        self.assertTrue((cloud.colors <= 1).all())
        np.testing.assert_allclose(cloud.colors, 1, atol=1e-15)
        np.testing.assert_allclose(np.linalg.norm(cloud.normals, axis=1), 1, atol=1e-14)
        self.assertTrue(np.isfinite(cloud.normals).all())

    def test_sampling_is_deterministic_with_stable_zero_based_ids(self):
        first = sample_mesh(self.triangle(), 200, 17)
        second = sample_mesh(self.triangle(), 200, 17)
        other = sample_mesh(self.triangle(), 200, 18)
        np.testing.assert_array_equal(first.positions, second.positions)
        np.testing.assert_array_equal(first.ids, np.arange(200))
        np.testing.assert_array_equal(first.ids, other.ids)
        self.assertFalse(np.array_equal(first.positions, other.positions))
        self.assertIsNone(first.colors)
        self.assertIsNone(first.normals)

    def test_degenerate_triangles_skipped_and_all_degenerate_rejected(self):
        vertices = self.triangle()[0]
        mesh = (vertices, np.array([[0, 0, 0], [0, 1, 2]]), None, None)
        cloud = sample_mesh(mesh, 200, 0)
        self.assertTrue((cloud.positions[:, 0] + cloud.positions[:, 1] > 0).all())
        with self.assertRaisesRegex(ValueError, "nondegenerate"):
            sample_mesh((vertices, np.array([[0, 0, 0]]), None, None), 5, 0)

    def test_invalid_geometry_counts_and_finite_values_rejected(self):
        vertices, faces, _, _ = self.triangle()
        with self.assertRaisesRegex(ValueError, "non-finite"):
            sample_mesh((vertices * np.nan, faces, None, None), 5, 0)
        with self.assertRaisesRegex(ValueError, "non-finite"):
            sample_mesh((vertices * 1e300, faces, None, None), 5, 0)
        with self.assertRaisesRegex(ValueError, "integers"):
            sample_mesh((vertices, faces.astype(float), None, None), 5, 0)
        with self.assertRaisesRegex(ValueError, "outside"):
            sample_mesh((vertices, np.array([[0, 1, 3]]), None, None), 5, 0)
        for count in (0, -1, 1.5, True):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "sample count"):
                sample_mesh(self.triangle(), count, 0)

    def test_malformed_obj_indices_partial_color_and_nonfinite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.obj"
            for text, error in (
                ("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 0 1 2\n", "outside"),
                ("v 0 0 nan\n", "non-finite"),
                ("v 0 0 0 1 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "every OBJ vertex"),
            ):
                with self.subTest(error=error):
                    path.write_text(text)
                    with self.assertRaisesRegex(ValueError, error):
                        load_mesh(path)

    def test_ply_huge_counts_negative_lists_and_truncation_fail_safely(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.ply"
            header = b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uint int vertex_indices\nend_header\n"
            points = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
            path.write_bytes(header + points + struct.pack("<I", 2 ** 32 - 1))
            with self.assertRaisesRegex(ValueError, "list count.*safe limit"):
                load_mesh(path)
            path.write_bytes(header.replace(b"vertex 3", b"vertex 99999999999999999"))
            with self.assertRaisesRegex(ValueError, "element count.*safe limit"):
                load_mesh(path)
            path.write_bytes(header + points + struct.pack("<I", 3) + struct.pack("<i", 0))
            with self.assertRaisesRegex(ValueError, "truncated"):
                load_mesh(path)
            ascii_header = header.replace(b"binary_little_endian", b"ascii").replace(b"list uint int", b"list int int")
            path.write_bytes(ascii_header + b"0 0 0\n1 0 0\n0 1 0\n-1\n")
            with self.assertRaisesRegex(ValueError, "list count.*negative"):
                load_mesh(path)

    def test_z_up_conversion_is_a_proper_rotation_for_positions_and_normals(self):
        cloud = sample_mesh(self.triangle(normals=np.tile([0, 0, 1], (3, 1))), 8, 8)
        transformed = _orient_cloud(cloud, "z")
        np.testing.assert_array_equal(transformed.positions[:, 0], cloud.positions[:, 0])
        np.testing.assert_array_equal(transformed.positions[:, 1], cloud.positions[:, 2])
        np.testing.assert_array_equal(transformed.positions[:, 2], -cloud.positions[:, 1])
        np.testing.assert_array_equal(transformed.normals, np.tile([0, 1, 0], (8, 1)))
        np.testing.assert_array_equal(transformed.ids, cloud.ids)

    def test_cli_runs_real_preprocessing_discloses_provenance_and_exports_points(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.obj"
            output = Path(directory) / "points.json"
            point_ply = Path(directory) / "points.ply"
            path.write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
            with contextlib.redirect_stdout(io.StringIO()):
                status = main([str(path), str(output), "--count", "160", "--seed", "31", "--name", "real-mesh", "--source-url", "https://example.org/asset", "--license", "CC0", "--up-axis", "z", "--backend", "numpy", "--ply", str(point_ply)])
            self.assertEqual(status, 0)
            result = json.loads(output.read_text())
            metadata = result["metadata"]
            dataset = metadata["dataset"]
            self.assertEqual(result["name"], "real-mesh")
            self.assertEqual(result["ids"], list(range(160)))
            self.assertEqual(metadata["neighborBackend"], "numpy-exact-batched")
            self.assertEqual(metadata["normalSource"], "local PCA")
            self.assertFalse(metadata["hasColors"])
            self.assertEqual(dataset["source"], "mesh-derived")
            self.assertEqual(dataset["samplingSeed"], 31)
            self.assertEqual(dataset["samplingCount"], 160)
            self.assertEqual(dataset["originalFilename"], "source.obj")
            self.assertEqual(dataset["originalSha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            self.assertEqual(dataset["sourceURL"], "https://example.org/asset")
            self.assertEqual(dataset["license"], "CC0")
            self.assertEqual(dataset["originalMesh"]["surfaceArea"], 0.5)
            self.assertIn("pearl-white", dataset["colorSource"])
            np.testing.assert_array_equal(result["saliency"], np.zeros(160))
            np.testing.assert_allclose(result["geometry"], 0, atol=1e-6)
            self.assertGreater(np.mean(result["confidence"]), 0.99)
            np.testing.assert_array_equal(np.asarray(result["colors"]).reshape(-1, 3), np.tile(PEARL_WHITE, (160, 1)))
            cloud = read_ply(point_ply)
            np.testing.assert_array_equal(cloud.ids, result["ids"])
            np.testing.assert_allclose(cloud.positions, np.asarray(result["positions"]).reshape(-1, 3))
            np.testing.assert_allclose(cloud.normals, np.asarray(result["normals"]).reshape(-1, 3))
            self.assertNotIn("element face", point_ply.read_text())


if __name__ == "__main__":
    unittest.main()
