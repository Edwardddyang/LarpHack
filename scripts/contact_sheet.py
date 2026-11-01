"""Make a 3x3 grid of evenly spaced frames per clip, for eyeballing the camera angle.

    python scripts/contact_sheet.py            -> data/sheets/<pro>_<id>.jpg
"""

from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
VIDEOS = ROOT / "data" / "videos"
SHEETS = ROOT / "data" / "sheets"


def sheet(path: Path, out: Path, n=9, width=320):
    cap = cv2.VideoCapture(str(path))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    tiles = []
    for i in range(n):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * (i + 0.5) / n))
        ok, frame = cap.read()
        if not ok:
            continue
        h = int(frame.shape[0] * width / frame.shape[1])
        tile = cv2.resize(frame, (width, h))
        cv2.putText(tile, f"{i + 1}", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (58, 255, 215), 2)
        tiles.append(tile)
    cap.release()
    if not tiles:
        return False
    h = tiles[0].shape[0]
    tiles = [cv2.resize(t, (width, h)) for t in tiles]
    while len(tiles) % 3:
        tiles.append(np.zeros_like(tiles[0]))
    rows = [np.hstack(tiles[i:i + 3]) for i in range(0, len(tiles), 3)]
    cv2.imwrite(str(out), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 70])
    return True


def main():
    SHEETS.mkdir(parents=True, exist_ok=True)
    for path in sorted(VIDEOS.glob("*/*.mp4")):
        out = SHEETS / f"{path.parent.name}_{path.stem}.jpg"
        if out.exists() or sheet(path, out):
            print(out.relative_to(ROOT))


if __name__ == "__main__":
    main()
