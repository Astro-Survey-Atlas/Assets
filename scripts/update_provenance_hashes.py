"""Refresh checksums for generated metadata after an intentional hard cut."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACT_ROOT = ROOT / "artifacts/public-survey-footprints"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    path = ARTIFACT_ROOT / "provenance.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    for key, relative in {
        "sources": "sources.json",
        "canonicalManifest": "normalized/survey-footprints.json",
    }.items():
        if key in value.get("inputs", {}):
            value["inputs"][key]["sha256"] = sha(ARTIFACT_ROOT / relative)
    for normalized in sorted((ARTIFACT_ROOT / "csst").glob("*-normalized-scan.json")):
        value.setdefault("inputs", {})[normalized.stem] = {
            "path": str(normalized.relative_to(ARTIFACT_ROOT)),
            "sha256": sha(normalized),
            "sizeBytes": normalized.stat().st_size,
        }
    manifest_path = ARTIFACT_ROOT / "normalized/survey-footprints.json"
    value["files"]["manifest"].update({"sha256": sha(manifest_path), "sizeBytes": manifest_path.stat().st_size})
    catalog_path = ARTIFACT_ROOT / "packages/catalog.json"
    value["files"]["catalog"].update({"sha256": sha(catalog_path), "sizeBytes": catalog_path.stat().st_size})
    value["files"]["packages"] = [
        {"id": entry["id"], "version": entry["version"], "archive": entry["archiveUrl"], "sizeBytes": entry["sizeBytes"], "sha256": entry["sha256"]}
        for entry in json.loads((ARTIFACT_ROOT / "packages/catalog.json").read_text(encoding="utf-8"))["packages"]
    ]
    source = json.loads((ARTIFACT_ROOT / "sources.json").read_text(encoding="utf-8"))
    products = [product for release in source["releases"] for product in release.get("products", [])]
    value["statistics"].update({
        "releases": len(source["releases"]),
        "products": len(products),
        "acquired": sum(product.get("status") == "acquired" for product in products),
        "overview_only": sum(product.get("status") == "overview_only" for product in products),
        "awaiting_geometry": sum(product.get("status") == "awaiting_geometry" for product in products),
        "not_applicable": sum(product.get("status") == "not_applicable" for product in products),
    })
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
