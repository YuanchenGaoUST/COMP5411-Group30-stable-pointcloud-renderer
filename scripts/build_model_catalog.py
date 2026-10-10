"""Build curated point-cloud inputs from already downloaded, attributed meshes.

Downloads are separate. Archive extraction reads exactly the named regular
member into a known filename; archive paths are never used as output paths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "data" / "sources"
MODELS = ROOT / "data" / "models"
STANFORD_URL = "https://graphics.stanford.edu/data/3Dscanrep/"
STANFORD_LICENSE = "Stanford research-use permission; acknowledgment required; commercial use requires permission"
ASSETS = [
    {"id": "jetliner", "label": "宽体客机 / Jumbo Jet", "name": "Jumbo Jet / mesh-derived points", "mesh": "jetliner.obj", "sourceURL": "https://opengameart.org/content/jumbo-jetwide-body", "downloadURL": "https://opengameart.org/sites/default/files/Jetliner.obj", "author": "NuclearOsmosis", "license": "CC0-1.0", "licenseURL": "https://opengameart.org/content/jumbo-jetwide-body", "preview": {"yaw": .85, "pitch": .55, "budgetRatio": .5}, "purpose": "Thin wings, engine rims, fuselage and silhouette coverage."},
    {"id": "funky-aircraft", "label": "风格化飞机 / Funky aircraft", "name": "Funky aircraft / mesh-derived points", "mesh": "funky-aircraft.obj", "sourceURL": "https://opengameart.org/content/funky-aircraft", "downloadURL": "https://opengameart.org/sites/default/files/high_0.obj", "author": "Savino", "license": "CC0-1.0", "licenseURL": "https://opengameart.org/content/funky-aircraft", "preview": {"yaw": .8, "pitch": .55, "budgetRatio": .5}, "purpose": "Smooth aircraft surfaces with low-complexity geometry."},
    {"id": "stanford-bunny", "label": "Stanford Bunny / 兔子", "name": "Stanford Bunny / reconstructed-mesh samples", "archive": "bunny.tar.gz", "member": "bunny/reconstruction/bun_zipper.ply", "mesh": "stanford-bunny.ply", "sourceURL": STANFORD_URL, "downloadURL": "https://graphics.stanford.edu/pub/3Dscanrep/bunny.tar.gz", "author": "Stanford University Computer Graphics Laboratory", "license": STANFORD_LICENSE, "licenseURL": STANFORD_URL, "preview": {"yaw": .4, "pitch": .2, "budgetRatio": .5}, "purpose": "Curved body, thin ears, source reconstruction holes."},
    {"id": "stanford-dragon", "label": "Stanford Dragon / 龙", "name": "Stanford Dragon / reconstructed-mesh samples", "archive": "dragon-reconstruction.tar.gz", "member": "dragon_recon/dragon_vrip.ply", "mesh": "stanford-dragon.ply", "sourceURL": STANFORD_URL, "downloadURL": "https://graphics.stanford.edu/pub/3Dscanrep/dragon/dragon_recon.tar.gz", "author": "Stanford University Computer Graphics Laboratory", "license": STANFORD_LICENSE, "licenseURL": STANFORD_URL, "preview": {"yaw": .6, "pitch": .2, "budgetRatio": .5}, "purpose": "Complex curves and fine sculptural features."},
    {"id": "teapot", "label": "Utah Teapot / 茶壶", "name": "Utah Teapot / mesh-derived points", "archive": "teapot.zip", "member": "teapot.obj", "mesh": "teapot.obj", "sourceURL": "https://casual-effects.com/g3d/data10/", "downloadURL": "https://casual-effects.com/g3d/data10/common/model/teapot/teapot.zip", "author": "Martin Newell; closed/welded adaptation by Kenzie Lamar; archive by Morgan McGuire", "license": "CC0-1.0", "licenseURL": "https://casual-effects.com/g3d/data10/common/model/teapot/info.js", "preview": {"yaw": .4, "pitch": .35, "budgetRatio": .5}, "purpose": "Narrow spout and handle, cavities and surface curvature."},
]


def prepare_mesh(asset: dict) -> Path:
    target = SOURCES / asset["mesh"]
    if "archive" not in asset:
        if not target.is_file():
            raise FileNotFoundError(f"Download {asset['downloadURL']} to {target}")
        return target
    archive = SOURCES / asset["archive"]
    if not archive.is_file():
        raise FileNotFoundError(f"Download {asset['downloadURL']} to {archive}")
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as container:
            info = container.getinfo(asset["member"])
            if info.is_dir() or info.file_size > 100_000_000:
                raise ValueError("Invalid or oversized mesh archive member")
            content = container.read(info)
    else:
        with tarfile.open(archive, "r:gz") as container:
            member = container.getmember(asset["member"])
            if not member.isfile() or member.size > 100_000_000:
                raise ValueError("Invalid or oversized mesh archive member")
            with container.extractfile(member) as source:
                content = source.read()
    target.write_bytes(content)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=15000)
    parser.add_argument("--seed", type=int, default=20261010)
    args = parser.parse_args()
    if not 1 <= args.count <= 16000:
        parser.error("Use 1–16000 points for the tested NumPy preprocessing path.")
    SOURCES.mkdir(parents=True, exist_ok=True)
    MODELS.mkdir(parents=True, exist_ok=True)
    entries = []
    for asset in ASSETS:
        mesh = prepare_mesh(asset)
        output = MODELS / f"{asset['id']}.json"
        command = [sys.executable, str(ROOT / "scripts" / "sample_mesh.py"), str(mesh), str(output), "--count", str(args.count), "--seed", str(args.seed), "--name", asset["name"], "--source-url", asset["sourceURL"], "--license", asset["license"], "--up-axis", "y"]
        subprocess.run(command, check=True)
        data = json.loads(output.read_text())
        metadata = data.setdefault("metadata", {})
        metadata.update({"source": "mesh-derived online model", "sourceKind": "mesh-derived", "sourceURL": asset["sourceURL"], "license": asset["license"], "licenseURL": asset["licenseURL"], "author": asset["author"], "downloadURL": asset["downloadURL"], "preview": asset["preview"], "preprocessorRecommended": False, "meshSHA256": hashlib.sha256(mesh.read_bytes()).hexdigest(), "featureSources": {"normals": "local PCA on sampled points", "radii": "sampled-point neighborhood spacing", "geometry": "normalized PCA variation", "saliency": "zero for uncolored input; no invented textures", "confidence": "PCA planarity"}})
        output.write_text(json.dumps(data, separators=(",", ":"), allow_nan=False))
        entries.append({**{key: asset[key] for key in ["id", "label", "sourceURL", "license", "licenseURL", "author", "downloadURL", "purpose"]}, "path": f"/data/models/{asset['id']}.json", "count": data["count"], "sourceKind": "mesh-derived", "samplingSeed": args.seed, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()})
    catalog = {"version": 1, "builtDate": "2026-10-10", "datasets": entries}
    (ROOT / "data" / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2))
    print(f"Built {len(entries)} local dataset options, {args.count:,} points each.")


if __name__ == "__main__":
    main()
