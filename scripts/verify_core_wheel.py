"""Verify the transitional Core wheel and its source provenance without imports."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WHEEL_DIR = ROOT / "artifacts/public-survey-footprints/moc-core"
SOURCE = ROOT / "requirements/moc-core-source.json"


def main() -> None:
    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    wheel = WHEEL_DIR / source["wheel"]
    if not wheel.is_file():
        raise SystemExit(f"Core wheel is missing: {wheel}")
    digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
    expected = source["wheelSha256"]
    if expected == "pending-core-wheel-build" or digest != expected:
        raise SystemExit(f"Core wheel SHA-256 mismatch: expected {expected}, got {digest}")
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        required = {"astro_survey_moc_core/__init__.py", "astro_survey_moc_core/cli.py"}
        if not required.issubset(names):
            raise SystemExit("Core wheel does not contain the expected package")
    print(f"Core wheel verified: {source['repository']}@{source['commit']} {digest}")


if __name__ == "__main__":
    main()
