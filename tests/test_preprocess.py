"""Run with: python -m unittest discover -s tests -v"""

from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from preprocess import PointCloud, _id_noise, nearest_neighbors, preprocess_cloud, read_ply, read_xyz, srgb_to_linear
from generate_fixture import make_fixture, write_ascii_ply, write_ascii_xyz


class PreprocessTests(unittest.TestCase):
    @staticmethod
    def plane() -> PointCloud:
        x, y = np.meshgrid(np.linspace(-2.0, 2.0, 12), np.linspace(-1.0, 1.0, 9))
        points = np.column_stack((x.ravel(), y.ravel(), np.full(x.size, 5.0)))
        return PointCloud(points, np.tile((0.2, 0.5, 0.8), (len(points), 1)), ids=np.arange(len(points)) + 100)

    def test_output_is_finite_and_shape_correct(self):
        cloud, _ = make_fixture(512)
        result = preprocess_cloud(cloud, backend="numpy")
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["count"], 512)
        for key in ("positions", "normals", "colors"):
            self.assertEqual(len(result[key]), 512 * 3)
            self.assertTrue(np.isfinite(result[key]).all(), key)
        for key in ("radii", "geometry", "saliency", "confidence", "ids"):
            self.assertEqual(len(result[key]), 512)
            self.assertTrue(np.isfinite(result[key]).all(), key)
        for key in ("colors", "geometry", "saliency", "confidence"):
            self.assertTrue((np.asarray(result[key]) >= 0).all(), key)
            self.assertTrue((np.asarray(result[key]) <= 1).all(), key)
        self.assertTrue((np.asarray(result["radii"]) > 0).all())
        normals = np.asarray(result["normals"]).reshape(-1, 3)
        np.testing.assert_allclose(np.linalg.norm(normals, axis=1), 1.0, atol=2e-6)
        positions = np.asarray(result["positions"]).reshape(-1, 3)
        self.assertAlmostEqual(float(np.max(np.ptp(positions, axis=0))), 1.0, places=5)
        np.testing.assert_allclose(positions.min(axis=0) + positions.max(axis=0), 0.0, atol=2e-6)

    def test_planar_curvature_and_normals(self):
        result = preprocess_cloud(self.plane(), backend="numpy")
        np.testing.assert_allclose(result["geometry"], 0.0, atol=1e-6)
        np.testing.assert_allclose(np.asarray(result["normals"]).reshape(-1, 3), np.tile((0.0, 0.0, 1.0), (result["count"], 1)), atol=1e-6)
        np.testing.assert_allclose(result["saliency"], 0.0, atol=1e-6)
        self.assertGreater(np.mean(result["confidence"]), 0.99)

    def test_noise_recomputes_features_and_preserves_ids(self):
        cloud = self.plane()
        clean = preprocess_cloud(cloud, backend="numpy")
        noisy = preprocess_cloud(cloud, noise_std=0.02, seed=42, backend="numpy")
        repeat = preprocess_cloud(cloud, noise_std=0.02, seed=42, backend="numpy")
        self.assertEqual(clean["ids"], noisy["ids"])
        self.assertEqual(noisy, repeat)
        self.assertNotEqual(clean["positions"], noisy["positions"])
        self.assertNotEqual(clean["normals"], noisy["normals"])
        self.assertGreater(np.mean(noisy["geometry"]), 0.1)
        self.assertLess(np.mean(noisy["confidence"]), np.mean(clean["confidence"]))
        self.assertNotEqual(clean["radii"], noisy["radii"])

    def test_noise_is_keyed_to_source_id(self):
        ids = np.array([50, 1, 99, 5], dtype=np.int64)
        order = np.array([2, 0, 3, 1])
        np.testing.assert_array_equal(_id_noise(ids, 17)[order], _id_noise(ids[order], 17))

    def test_ply_property_reorder_and_source_ids(self):
        content = """ply
format ascii 1.0
element vertex 3
property uchar blue
property float z
property uint source_id
property float x
property float nz
property uchar red
property float y
property float nx
property uchar green
property float ny
element face 1
property list uchar int vertex_indices
end_header
255 0 31 1 2 0 2 0 128 0
128 0 8 3 2 255 4 0 0 0
0 1 17 5 2 128 6 0 255 0
3 0 1 2
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ordered.ply"
            path.write_text(content)
            cloud = read_ply(path)
        np.testing.assert_array_equal(cloud.ids, [31, 8, 17])
        np.testing.assert_array_equal(cloud.positions, [[1, 2, 0], [3, 4, 0], [5, 6, 1]])
        np.testing.assert_allclose(cloud.colors[0], [0.0, 128 / 255, 1.0])
        self.assertEqual(preprocess_cloud(cloud, backend="numpy")["ids"], [31, 8, 17])

    def test_unsupported_binary_ply_has_clear_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "binary.ply"
            path.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nend_header\n\x00\xff")
            with self.assertRaisesRegex(ValueError, "binary PLY is unsupported; export ASCII PLY"):
                read_ply(path)

    def test_xyz_comments_rgb_and_nonfinite_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cloud.xyz"
            path.write_text("# example\n\n1 2 3 255 128 0\n4 5 6 0 64 255 # point\n")
            cloud = read_xyz(path)
            np.testing.assert_array_equal(cloud.ids, [0, 1])
            np.testing.assert_allclose(cloud.colors[0], [1, 128 / 255, 0])
            path.write_text("1 2 nan\n")
            with self.assertRaisesRegex(ValueError, "non-finite"):
                read_xyz(path)

    def test_numpy_fallback_guard(self):
        with self.assertRaisesRegex(ValueError, r"O\(N\^2\).*install SciPy"):
            nearest_neighbors(self.plane().positions, 8, numpy_max_points=10, backend="numpy")

    def test_degenerate_and_single_point_clouds(self):
        for positions in (np.zeros((1, 3)), np.zeros((8, 3))):
            result = preprocess_cloud(PointCloud(positions), backend="numpy")
            for key in ("positions", "normals", "radii", "geometry", "saliency", "confidence"):
                self.assertTrue(np.isfinite(result[key]).all(), key)
            self.assertTrue((np.asarray(result["radii"]) > 0).all())
            np.testing.assert_allclose(result["confidence"], 0.0)

    def test_fixture_exports_roundtrip_and_exact_surfaces(self):
        cloud, metadata = make_fixture(512)
        self.assertEqual(len(cloud.positions), 512)
        self.assertEqual(sum(group["count"] for group in metadata["groups"]), 512)
        rear = metadata["groups"][0]
        np.testing.assert_array_equal(cloud.positions[:rear["count"], 2], -0.42)
        sphere = metadata["groups"][2]
        points = cloud.positions[sphere["firstId"]:sphere["firstId"] + sphere["count"]]
        np.testing.assert_allclose(np.linalg.norm(points - [-0.52, 0.04, 0.13], axis=1), 0.24, atol=1e-12)
        with tempfile.TemporaryDirectory() as directory:
            ply_path, xyz_path = Path(directory) / "fixture.ply", Path(directory) / "fixture.xyz"
            write_ascii_ply(ply_path, cloud)
            write_ascii_xyz(xyz_path, cloud)
            ply, xyz = read_ply(ply_path), read_xyz(xyz_path)
        np.testing.assert_array_equal(ply.ids, xyz.ids)
        np.testing.assert_array_equal(ply.colors, xyz.colors)
        np.testing.assert_allclose(ply.positions, cloud.positions, atol=6e-8)

    def test_linear_rgb_appearance_and_invalid_ids(self):
        np.testing.assert_allclose(srgb_to_linear(np.array([0, 0.04045, 1])), [0, 0.0031308, 1], atol=1e-7)
        with self.assertRaisesRegex(ValueError, "unique"):
            preprocess_cloud(PointCloud(np.zeros((2, 3)), ids=np.array([1, 1])), backend="numpy")


if __name__ == "__main__":
    unittest.main()
