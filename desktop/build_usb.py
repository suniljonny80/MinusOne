"""Assemble the portable USB folder (dist/MinusOne) and zip it (dist/MinusOne-USB.zip).

    python desktop/build_usb.py

Copy the MinusOne folder from the zip to a USB stick, then run "Set up USB.bat" once.
"""
import shutil
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist"
OUT = DIST / "MinusOne"

README = """MinusOne (portable)
===================

Play along with any song, minus your part.

FIRST TIME (on a PC with internet):
  1. Copy this whole MinusOne folder to your USB stick. It needs about 6 GB free
     for GPU speed on NVIDIA PCs, or 2 GB for the processor-only version.
  2. Double-click "Set up USB.bat". It downloads 2-5 GB onto the USB
     (portable Python and the instrument-splitting AI). Takes 10-30 minutes.

EVERY TIME, ON ANY WINDOWS 10/11 PC:
  Double-click MinusOne.exe.

  - Paste a YouTube link (needs internet) or upload a song (works offline).
  - Your songs are saved on the USB, so they go wherever it goes.
  - Mixes you save go to the Exports folder.

If Windows says "Windows protected your PC", click More info, then Run anyway.
"""


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    (OUT / "app" / "server").mkdir(parents=True)
    shutil.copy(REPO / "desktop" / "launcher" / "MinusOne.exe", OUT / "MinusOne.exe")
    shutil.copy(REPO / "desktop" / "Set up USB.bat", OUT / "Set up USB.bat")
    for f in ("desktop.py", "setup-usb.ps1", "minusone.ico"):
        shutil.copy(REPO / "desktop" / "app" / f, OUT / "app" / f)
    for f in ("app.py", "requirements.txt"):
        shutil.copy(REPO / "server" / f, OUT / "app" / "server" / f)
    shutil.copytree(REPO / "site", OUT / "app" / "site")
    (OUT / "README.txt").write_text(README.replace("\n", "\r\n"), encoding="utf-8")

    zpath = DIST / "MinusOne-USB.zip"
    zpath.unlink(missing_ok=True)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(OUT.rglob("*")):
            if p.is_file():
                z.write(p, Path("MinusOne") / p.relative_to(OUT))
    print("built", zpath, f"{zpath.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
