"""Register CSST W2/W3/W4 as pending Assets inputs.

No geometry is fabricated here.  The records become publishable only after the
Atlas coverage jobs lock real FITS-WCS scan manifests and Core outputs.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    source_url = "https://nadc.china-vo.org/data/"
    releases = []
    for band in ("W2", "W3", "W4"):
        release_id = f"csst-sim-{band.lower()}-20250731"
        product = f"{band} simulated wide-field images"
        prefix = f"http://oss-cn-hangzhou-zjy-d01-a.res.cloud.zhejianglab.com/data-and-computing/projects/CSST/shared-data/simulation-1000-w1-20250731/outputs_wide1000sqdeg/{band}_Phot"
        releases.append({
            "id": release_id,
            "label": f"CSST {band} Simulation 2025-07-31",
            "kind": "early_release",
            "releasedYear": 2025,
            "modalities": ["imaging", "photometry", "simulation"],
            "products": [{
                "name": product,
                "modality": "imaging",
                "description": f"CSST {band}_Phot 仿真宽场 FITS 图像；覆盖待通过独立 coverage job 扫描并由 Assets MOC Core 锁定。",
                "status": "awaiting_geometry",
                "sourceUrl": source_url,
                "geometrySourceUrl": prefix,
                "reason": "W2/W3/W4 FITS-WCS scan has not been completed and locked by Assets.",
                "manualStep": f"Run the {band}_Phot FITS-WCS coverage job with the existing CSST Connector, then import the locked Core result.",
            }],
        })

    survey_path = ROOT / "src/surveys/survey-catalog.json"
    survey = json.loads(survey_path.read_text(encoding="utf-8"))
    csst = next(item for item in survey["surveys"] if item["id"] == "csst")
    existing = {item["id"] for item in csst["releases"]}
    csst["releases"].extend(item for item in releases if item["id"] not in existing)
    write(survey_path, survey)

    registry_path = ROOT / "src/layers/layer-registry.json"
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    existing = {item["layerId"] for item in registry["layers"]}
    for band in ("w2", "w3", "w4"):
        band_upper = band.upper()
        layer = {
            "layerId": f"csst-sim-{band}-image-extent",
            "surveyId": "csst",
            "releaseId": f"csst-sim-{band}-20250731",
            "product": f"{band_upper} simulated wide-field images",
            "modality": "imaging",
            "coverageRole": "image_extent",
            "dataOrigin": "simulated",
            "sourceTier": "user_file_derived",
            "maxOrder": 10,
            "status": "awaiting_snapshot",
            "plannedMode": "fits-wcs",
            "sourceUrl": source_url,
            "geometrySourceUrl": f"http://oss-cn-hangzhou-zjy-d01-a.res.cloud.zhejianglab.com/data-and-computing/projects/CSST/shared-data/simulation-1000-w1-20250731/outputs_wide1000sqdeg/{band_upper}_Phot",
            "pendingReason": f"{band_upper}_Phot FITS-WCS scan is pending; .cat files are intentionally excluded from image_extent coverage.",
        }
        if layer["layerId"] not in existing:
            registry["layers"].append(layer)
    write(registry_path, registry)

    sources_path = ROOT / "artifacts/public-survey-footprints/sources.json"
    sources = json.loads(sources_path.read_text(encoding="utf-8"))
    existing = {(item["surveyId"], item["releaseId"]) for item in sources["releases"]}
    for release in releases:
        if ("csst", release["id"]) not in existing:
            product = release["products"][0]
            sources["releases"].append({
                "surveyId": "csst",
                "releaseId": release["id"],
                "products": [{
                    "product": product["name"],
                    "status": "awaiting_geometry",
                    "sourceUrl": product["sourceUrl"],
                    "geometrySourceUrl": product["geometrySourceUrl"],
                    "reason": product["reason"],
                    "manualStep": product["manualStep"],
                    "coverageRole": "image_extent",
                }],
            })
    write(sources_path, sources)


if __name__ == "__main__":
    main()
