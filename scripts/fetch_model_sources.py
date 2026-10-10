"""Download the fixed curated input sources; no downloaded code is executed."""
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
ASSETS = [
    ("jetliner.obj", "https://opengameart.org/sites/default/files/Jetliner.obj"),
    ("funky-aircraft.obj", "https://opengameart.org/sites/default/files/high_0.obj"),
    ("bunny.tar.gz", "https://graphics.stanford.edu/pub/3Dscanrep/bunny.tar.gz"),
    ("dragon-reconstruction.tar.gz", "https://graphics.stanford.edu/pub/3Dscanrep/dragon/dragon_recon.tar.gz"),
    ("teapot.zip", "https://casual-effects.com/g3d/data10/common/model/teapot/teapot.zip"),
    ("teapot-license-info.js", "https://casual-effects.com/g3d/data10/common/model/teapot/info.js"),
]

def main():
    output = ROOT / "data" / "sources"
    output.mkdir(parents=True, exist_ok=True)
    for filename, url in ASSETS:
        target = output / filename
        if target.exists():
            print(f"Preserving existing {target.name}")
            continue
        request = urllib.request.Request(url, headers={"User-Agent": "COMP5411-PointCloud-Research/0.1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            content = response.read(25_000_001)
        if len(content) > 25_000_000:
            raise ValueError(f"Source exceeds 25 MB limit: {filename}")
        target.write_bytes(content)
        print(f"Downloaded {filename}: {len(content):,} bytes")

if __name__ == "__main__":
    main()
