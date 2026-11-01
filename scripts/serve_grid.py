"""One tile per detected serve (frame at contact), numbered, for labeling camera view.

    python scripts/serve_grid.py            -> data/sheets/serves_<pro>_<id>.jpg

Record labels in data/serve_labels.json as {video_id: {serve_index: "side"|"back"|"skip"}}.
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from alterego import ingest  # noqa: E402

CACHE = ROOT / "data" / "cache"
SHEETS = ROOT / "data" / "sheets"
TILE_W, COLS = 240, 5


def grid(result):
    path = ingest.VIDEOS / result["pro_id"] / f"{result['video_id']}.mp4"
    cap = cv2.VideoCapture(str(path))
    tiles = []
    for i, s in enumerate(result["samples"]):
        cap.set(cv2.CAP_PROP_POS_MSEC, s["features"]["contact_time"] * 1000)
        ok, img = cap.read()
        if not ok:
            continue
        tile = cv2.resize(img, (TILE_W, int(TILE_W * img.shape[0] / img.shape[1])))
        cv2.rectangle(tile, (0, 0), (44, 28), (0, 0, 0), -1)
        cv2.putText(tile, str(i), (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (58, 255, 215), 2)
        tiles.append(tile)
    cap.release()
    if not tiles:
        return None
    h = tiles[0].shape[0]
    tiles = [cv2.resize(t, (TILE_W, h)) for t in tiles]
    while len(tiles) % COLS:
        tiles.append(np.zeros_like(tiles[0]))
    return np.vstack([np.hstack(tiles[i:i + COLS]) for i in range(0, len(tiles), COLS)])


def main():
    SHEETS.mkdir(parents=True, exist_ok=True)
    for f in sorted(CACHE.glob("*.json")):
        result = json.loads(f.read_text())
        img = grid(result)
        if img is None:
            continue
        out = SHEETS / f"serves_{result['pro_id']}_{result['video_id']}.jpg"
        cv2.imwrite(str(out), img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        print(out.relative_to(ROOT), len(result["samples"]), "serves")


if __name__ == "__main__":
    main()
