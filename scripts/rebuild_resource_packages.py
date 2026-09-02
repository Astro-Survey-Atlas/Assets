"""Rebuild the public Resource Package v3 archives for selected surveys.

The layer registry is the only identity/classification authority.  The script
keeps the v3 archive shape stable, writes support files in a temporary
directory, and refreshes the package catalog with the resulting archive hash.
It never includes input manifests, normalized scans, or task snapshots.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = Path(os.environ.get("MOC_CORE_ROOT", ROOT.parent / "MOC-Core-SDK")).resolve()
sys.path.insert(0, str(CORE_ROOT))
from astro_survey_moc_core.resource_package import build_resource_package
ARTIFACT_ROOT = ROOT / "artifacts/public-survey-footprints"
REGISTRY_PATH = ROOT / "src/layers/layer-registry.json"
FOOTPRINT_PATH = ROOT / "src/footprints/survey-footprints.json"
CATALOG_PATH = ARTIFACT_ROOT / "packages/catalog.json"
SOURCE_DATE_EPOCH = 1787184000
TARGETS = {
    "public-desi-footprints": "desi",
    "public-euclid-footprints": "euclid",
    "public-gaia-footprints": "gaia",
}


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_layers(registry: dict[str, Any], survey_id: str) -> list[dict[str, Any]]:
    layers = [
        layer
        for layer in registry["layers"]
        if layer.get("surveyId") == survey_id
        and layer.get("status") in {"acquired", "frozen-review-exception"}
        and layer.get("artifactPath")
    ]
    if not layers:
        raise RuntimeError(f"No acquired registry layers for {survey_id}")
    return sorted(layers, key=lambda layer: layer["layerId"])


def support_documents(package_id: str, survey_id: str, layers: list[dict[str, Any]], footprint: dict[str, Any], registry: dict[str, Any]) -> tuple[dict[str, Any], str, str]:
    layer_keys = {(layer["surveyId"], layer["releaseId"], layer["product"]) for layer in layers}
    selected = [
        item for item in footprint.get("footprints", [])
        if (item.get("surveyId"), item.get("releaseId"), item.get("product")) in layer_keys
    ]
    if len(selected) != len(layers):
        raise RuntimeError(f"Footprint manifest does not cover every {survey_id} registry layer")
    footprint_doc = {
        "schemaVersion": footprint["schemaVersion"],
        "generatedAt": footprint["generatedAt"],
        "coordinateFrame": "ICRS",
        "nside": footprint["nside"],
        "footprints": selected,
    }
    provenance_layers: list[dict[str, Any]] = []
    for layer in layers:
        recipe = read_json(ROOT / layer["recipePath"]) if layer.get("recipePath") else {}
        snapshot = recipe.get("snapshot") if isinstance(recipe.get("snapshot"), dict) else {}
        provenance_layers.append({
            "layerId": layer["layerId"],
            "surveyId": layer["surveyId"],
            "releaseId": layer["releaseId"],
            "product": layer["product"],
            "modality": layer["modality"],
            "coverageRole": layer["coverageRole"],
            "dataOrigin": layer["dataOrigin"],
            "sourceTier": layer["sourceTier"],
            "method": recipe.get("mode"),
            "sourceUrl": recipe.get("sourceUrl"),
            "sourceSnapshot": {
                "sha256": snapshot.get("sha256"),
                "sizeBytes": snapshot.get("sizeBytes"),
            },
            **({"attributionUrl": recipe["recipe"]["attributionUrl"]}
               if isinstance(recipe.get("recipe"), dict)
               and isinstance(recipe["recipe"].get("attributionUrl"), str)
               else {}),
            "mocSha256": layer["expectedSha256"],
        })
    provenance_doc = {
        "schemaVersion": 1,
        "packageId": package_id,
        "packageVersion": "3.0.0",
        "generatedAt": footprint["generatedAt"],
        "coordinateFrame": "ICRS",
        "ordering": "NESTED",
        "generator": {"name": "astro-survey-moc-core", "version": registry["coreVersion"]},
        "layers": provenance_layers,
    }
    readme = f"""# {survey_id.upper()} public coverage\n\nThis Resource Package v3 contains reviewed {survey_id} coverage layers from the Assets layer registry. The authoritative files are ICRS/NESTED FITS MOCs. The footprint JSON is an order-4 display projection and must not be treated as a finer measurement.\n\nUse the official release links for scientific files and queries. Assets publishes discovery geometry and verification metadata; it does not proxy the survey archive.\n"""
    return footprint_doc, provenance_doc, readme


def main() -> None:
    os.environ.setdefault("SOURCE_DATE_EPOCH", str(SOURCE_DATE_EPOCH))
    registry = read_json(REGISTRY_PATH)
    footprint = read_json(FOOTPRINT_PATH)
    catalog = read_json(CATALOG_PATH)
    catalog_by_id = {entry["id"]: entry for entry in catalog["packages"]}
    generated: list[tuple[str, str, int]] = []
    with tempfile.TemporaryDirectory(prefix="assets-package-support-") as temp_dir:
        support_root = Path(temp_dir)
        for package_id, survey_id in TARGETS.items():
            layers = package_layers(registry, survey_id)
            footprint_doc, provenance_doc, readme = support_documents(package_id, survey_id, layers, footprint, registry)
            support = support_root / package_id
            support.mkdir()
            footprint_file = support / "footprints.json"
            provenance_file = support / "provenance.json"
            readme_file = support / "README.md"
            footprint_file.write_text(json.dumps(footprint_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            provenance_file.write_text(json.dumps(provenance_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            readme_file.write_text(readme, encoding="utf-8")
            spec = {
                "id": package_id,
                "version": "3.0.0",
                "surveyId": survey_id,
                "footprintPath": str(footprint_file),
                "provenancePath": str(provenance_file),
                "readmePath": str(readme_file),
                "layers": [
                    {
                        "layerId": layer["layerId"],
                        "surveyId": layer["surveyId"],
                        "releaseId": layer["releaseId"],
                        "modality": layer["modality"],
                        "coverageRole": layer["coverageRole"],
                        "dataOrigin": layer["dataOrigin"],
                        "sourceTier": layer["sourceTier"],
                        "sourcePath": str(ROOT / layer["artifactPath"]),
                    }
                    for layer in layers
                ],
            }
            archive = ARTIFACT_ROOT / "packages" / f"{package_id}-3.0.0.zip"
            result = build_resource_package(spec, archive, base_dir=ROOT)
            if result.manifest["id"] != package_id or result.manifest["version"] != "3.0.0":
                raise RuntimeError(f"Unexpected manifest identity for {package_id}")
            catalog_entry = catalog_by_id.get(package_id)
            if catalog_entry is None:
                raise RuntimeError(f"Package catalog lacks {package_id}")
            catalog_entry["sizeBytes"] = archive.stat().st_size
            catalog_entry["sha256"] = sha256(archive)
            generated.append((package_id, catalog_entry["sha256"], catalog_entry["sizeBytes"]))
    CATALOG_PATH.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for package_id, archive_hash, size in generated:
        print(f"rebuilt {package_id}: {size} bytes sha256={archive_hash}")


if __name__ == "__main__":
    main()
