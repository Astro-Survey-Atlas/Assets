"""Promote reviewed CDS MOC snapshots into deterministic public layers.

The networked acquisition itself is intentionally done outside this script.
It consumes the already downloaded, SHA-256-checked snapshots recorded by the
2026-08-28 discovery probe, updates the registries, and prepares the offline
build inputs.  Re-running it is idempotent for the four allowlisted products.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = Path(os.environ.get("MOC_CORE_ROOT", ROOT.parent / "MOC-Core-SDK")).resolve()
sys.path.insert(0, str(CORE_ROOT))
from astro_survey_moc_core.core import project_cells, read_moc_fits

RAW = ROOT / "artifacts/public-survey-footprints/raw/moc"
FOOTPRINTS = ROOT / "src/footprints/survey-footprints.json"
CATALOG = ROOT / "src/surveys/survey-catalog.json"
SOURCES = ROOT / "artifacts/public-survey-footprints/sources.json"
SOURCE_REGISTRY = ROOT / "src/moc-sources/source-registry.json"
LAYERS = ROOT / "src/layers/layer-registry.json"
BUILD_PLAN = ROOT / "src/layers/public-build-plan.json"

TARGETS: list[dict[str, Any]] = [
    {
        "sourceId": "CDS/I/355/gaiadr3",
        "surveyId": "gaia",
        "releaseId": "gaia-dr3",
        "product": "Gaia DR3 main source presence",
        "layerId": "gaia-dr3-main-source-presence",
        "label": "Gaia DR3 main source catalog presence",
        "rawFile": "gaia-gaia-dr3-main-source-presence.fits",
        "recordFile": "gaia-gaia-dr3-main-source-presence.record.json",
        "officialUrl": "https://www.cosmos.esa.int/web/gaia/data-release-3",
        "mocUrl": "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=smoc&order=10&fmt=fits",
        "recordUrl": "https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FI%2F355%2Fgaiadr3&get=record&fmt=json",
        "attributionUrl": "https://www.cosmos.esa.int/web/gaia-users/credits",
        "coverageRole": "object_presence",
        "dataOrigin": "catalog",
        "modality": "catalog",
        "notes": "Reviewed Gaia DR3 main-source catalog row-presence SMOC in ICRS/NUNIQ. This is an exact catalog presence map, not an imaging or scanning-law footprint.",
        "retrievedAt": "2026-09-02T02:59:38Z",
    },
    {
        "sourceId": "CDS/P/Skymapper/DR4/color",
        "surveyId": "skymapper",
        "releaseId": "skymapper-dr4",
        "product": "DR4 g/r/i color footprint",
        "layerId": "skymapper-dr4-color-footprint",
        "label": "SkyMapper DR4 g/r/i color coverage",
        "rawFile": "skymapper-skymapper-dr4-dr4-gri-color-footprint.fits",
        "recordFile": "skymapper-skymapper-dr4-dr4-gri-color-footprint.record.json",
        "officialUrl": "https://skymapper.anu.edu.au/data-release/dr4/",
        "mocUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&get=smoc&order=10&fmt=fits",
        "recordUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FSkymapper%2FDR4%2Fcolor&get=record&fmt=json",
    },
    {
        "sourceId": "CDS/P/KiDS/DR5/color-gri",
        "surveyId": "kids",
        "releaseId": "kids-dr5",
        "product": "DR5 gri imaging",
        "layerId": "kids-dr5-color-footprint",
        "label": "KiDS DR5 gri imaging coverage",
        "rawFile": "kids-kids-dr5-dr5-gri-imaging.fits",
        "recordFile": "kids-kids-dr5-dr5-gri-imaging.record.json",
        "officialUrl": "https://kids.strw.leidenuniv.nl/DR5/index.php",
        "mocUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=smoc&order=10&fmt=fits",
        "recordUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FKiDS%2FDR5%2Fcolor-gri&get=record&fmt=json",
    },
    {
        "sourceId": "CDS/P/VISTA/VIKING/J",
        "surveyId": "vista",
        "releaseId": "viking",
        "product": "VIKING J footprint",
        "layerId": "vista-viking-j-footprint",
        "label": "VISTA VIKING J coverage",
        "rawFile": "vista-vista-viking-viking-j-footprint.fits",
        "recordFile": "vista-vista-viking-viking-j-footprint.record.json",
        "officialUrl": "https://www.eso.org/sci/observing/phase3/data_releases.html",
        "mocUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FVISTA%2FVIKING%2FJ&get=smoc&order=10&fmt=fits",
        "recordUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FVISTA%2FVIKING%2FJ&get=record&fmt=json",
    },
    {
        "sourceId": "CDS/P/DECaLS/DR5/color",
        "surveyId": "decals",
        "releaseId": "decals-dr5",
        "product": "DR5 g/r/z color footprint",
        "layerId": "decals-dr5-color-footprint",
        "label": "DECaLS DR5 g/r/z color coverage",
        "rawFile": "decals-decals-dr5-dr5-grz-color-footprint.fits",
        "recordFile": "decals-decals-dr5-dr5-grz-color-footprint.record.json",
        "officialUrl": "https://www.legacysurvey.org/dr5/",
        "mocUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FDECaLS%2FDR5%2Fcolor&get=smoc&order=10&fmt=fits",
        "recordUrl": "https://alasky.unistra.fr/MocServer/query?ID=CDS%2FP%2FDECaLS%2FDR5%2Fcolor&get=record&fmt=json",
    },
]

LEGACY_FOOTPRINT_ORDER = [
    ("2mass", "2mass-all-sky", "H-band imaging"), ("2mass", "2mass-all-sky", "J-band imaging"), ("2mass", "2mass-all-sky", "K-band imaging"),
    ("allwise", "allwise", "W1 imaging"), ("allwise", "allwise", "W2 imaging"), ("allwise", "allwise", "W3 imaging"), ("allwise", "allwise", "W4 imaging"),
    ("csst", "csst-sim-w1-20250731", "W1 simulated wide-field images"), ("csst", "csst-sim-w2-20250731", "W2 simulated wide-field images"), ("csst", "csst-sim-w3-20250731", "W3 simulated wide-field images"), ("csst", "csst-sim-w4-20250731", "W4 simulated wide-field images"),
    ("des", "des-dr2", "DR2 color imaging"), ("desi", "desi-dr1", "DR1 spectra and redshifts"), ("desi", "desi-edr", "Early Data Release spectra"), ("euclid", "euclid-q1", "Euclid Q1 deep fields"),
    ("galex", "galex-gr6-gr7", "FUV imaging"), ("galex", "galex-gr6-gr7", "NUV imaging"), ("galex", "galex-gr6-gr7", "ultraviolet image coverage"),
    ("hsc-ssp", "hsc-pdr2", "PDR2 Wide + Deep image coverage"), ("hsc-ssp", "hsc-pdr2", "PDR2 g-band imaging"), ("hsc-ssp", "hsc-pdr2", "PDR2 i-band imaging"), ("hsc-ssp", "hsc-pdr2", "PDR2 r-band imaging"), ("hsc-ssp", "hsc-pdr2", "PDR2 y-band imaging"), ("hsc-ssp", "hsc-pdr2", "PDR2 z-band imaging"),
    ("hst", "hst-mast-snapshot-2026", "published HST HiPS pointings"), ("kids", "kids-dr5", "DR5 gri imaging"),
    ("legacy-surveys", "legacy-dr1", "Coadded imaging"), ("legacy-surveys", "legacy-dr10", "DR10 color imaging"), ("legacy-surveys", "legacy-dr2", "Coadded imaging"), ("legacy-surveys", "legacy-dr3", "Coadded imaging"), ("legacy-surveys", "legacy-dr4", "Coadded imaging"), ("legacy-surveys", "legacy-dr5", "Coadded imaging"), ("legacy-surveys", "legacy-dr6", "Coadded imaging"), ("legacy-surveys", "legacy-dr7", "Coadded imaging"), ("legacy-surveys", "legacy-dr8", "Coadded imaging"), ("legacy-surveys", "legacy-dr9", "Coadded imaging"),
    ("nvss", "nvss-final", "1.4 GHz radio imaging"), ("panstarrs", "panstarrs-dr1", "DR1 color imaging"), ("panstarrs", "panstarrs-dr1", "DR1 g-band imaging"), ("panstarrs", "panstarrs-dr1", "DR1 i-band imaging"), ("panstarrs", "panstarrs-dr1", "DR1 r-band imaging"), ("panstarrs", "panstarrs-dr1", "DR1 y-band imaging"), ("panstarrs", "panstarrs-dr1", "DR1 z-band imaging"), ("sdss", "sdss-dr09", "DR9 color imaging"),
]
LEGACY_SOURCE_ORDER = [
    ("csst", "csst-sim-w1-20250731"), ("euclid", "euclid-ero"), ("euclid", "euclid-q1"), ("euclid", "euclid-q2"), ("desi", "desi-edr"), ("desi", "desi-dr1"),
    *[("sdss", f"sdss-dr{number:02d}") for number in range(1, 20)], ("galex", "galex-gr1"), ("galex", "galex-gr2-gr3"), ("galex", "galex-gr4-gr5"), ("galex", "galex-gr6-gr7"),
    *[("legacy-surveys", f"legacy-dr{number}") for number in range(1, 11)], ("hsc-ssp", "hsc-pdr1"), ("hsc-ssp", "hsc-pdr2"), ("hsc-ssp", "hsc-pdr3"), ("hst", "hst-mast-snapshot-2026"), ("panstarrs", "panstarrs-dr1"), ("des", "des-dr2"), ("2mass", "2mass-all-sky"), ("allwise", "allwise"), ("kids", "kids-dr5"), ("nvss", "nvss-final"),
    ("csst", "csst-sim-w2-20250731"), ("csst", "csst-sim-w3-20250731"), ("csst", "csst-sim-w4-20250731"),
]
LEGACY_LAYER_ORDER = [
    "csst-sim-w1-image-extent", "euclid-q1-deep-fields-image-extent", "desi-edr-spectra-footprint", "desi-dr1-spectra-footprint",
    "euclid-ero-image-extent", "euclid-q2-galactic-bulge-image-extent",
    *[f"legacy-dr{number}-{kind}" for number in range(1, 10) for kind in ("coadd-image-extent", "tractor-object-presence")],
    "legacy-dr10-coadd-image-extent", "legacy-dr10-tractor-object-presence", "csst-sim-w2-image-extent", "csst-sim-w3-image-extent", "csst-sim-w4-image-extent",
]


def restore_order(items: list[dict[str, Any]], keys: list[Any], key_fn: Any) -> list[dict[str, Any]]:
    by_key = {key_fn(item): item for item in items}
    ordered = [by_key[key] for key in keys if key in by_key]
    known = set(keys)
    ordered.extend(item for item in items if key_fn(item) not in known)
    return ordered


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identity(survey_id: str, release_id: str, product: str) -> tuple[str, str, str]:
    return survey_id, release_id, product


def update_footprints() -> None:
    document = load(FOOTPRINTS)
    by_identity = {identity(item["surveyId"], item["releaseId"], item["product"]): item for item in document["footprints"]}
    for target in TARGETS:
        cells = read_moc_fits(RAW / target["rawFile"])
        pixels = list(project_cells(cells, 4))
        item = by_identity.get(identity(target["surveyId"], target["releaseId"], target["product"]))
        if item is None:
            item = {}
            document["footprints"].append(item)
        item.update({
            "surveyId": target["surveyId"],
            "releaseId": target["releaseId"],
            "product": target["product"],
            "label": target["label"],
            "nside": 16,
            "pixels": pixels,
            "quality": "moc",
            "sourceUrl": target["mocUrl"],
            "sourceId": target["sourceId"],
            "retrievedAt": target.get("retrievedAt", "2026-08-28T03:53:18.820Z"),
            "notes": target.get("notes", "CDS spatial SMOC projection of an STMOC. Temporal metadata is evidence-only; the order-4 manifest is a display preview."),
        })
    document["footprints"] = restore_order(document["footprints"], LEGACY_FOOTPRINT_ORDER, lambda item: identity(item["surveyId"], item["releaseId"], item["product"]))
    save(FOOTPRINTS, document)


def update_sources() -> None:
    document = load(SOURCES)
    releases = document["releases"]
    for target in TARGETS:
        release = next((entry for entry in releases if entry["surveyId"] == target["surveyId"] and entry["releaseId"] == target["releaseId"]), None)
        if release is None:
            release = {"surveyId": target["surveyId"], "releaseId": target["releaseId"], "products": []}
            releases.append(release)
        product = next((entry for entry in release["products"] if entry["product"] == target["product"]), None)
        if product is None:
            product = {"product": target["product"]}
            release["products"].append(product)
        product.update({
            "status": "acquired",
            "sourceUrl": target["officialUrl"],
            "geometrySourceUrl": target["mocUrl"],
            "coverageRole": target.get("coverageRole", "footprint_extent"),
            **({"attributionUrl": target["attributionUrl"]} if target.get("attributionUrl") else {}),
            "notes": target.get("notes", "Reviewed CDS ICRS/NUNIQ order-10 spatial MOC; native STMOC time metadata is evidence-only and precision is estimated."),
        })
    releases[:] = restore_order(releases, LEGACY_SOURCE_ORDER, lambda entry: (entry["surveyId"], entry["releaseId"]))
    document["auditedAt"] = "2026-09-02"
    save(SOURCES, document)


def update_raw_index() -> None:
    path = RAW / "index.json"
    document = load(path)
    artifacts = document["artifacts"]
    by_source = {entry.get("sourceId"): entry for entry in artifacts}
    for target in TARGETS:
        source = by_source.get(target["sourceId"])
        if source is None:
            source = {}
            artifacts.append(source)
        source.update({
            "surveyId": target["surveyId"],
            "releaseId": target["releaseId"],
            "product": target["product"],
            "sourceId": target["sourceId"],
            "sourceUrl": target["mocUrl"],
            "metadataUrl": target["recordUrl"],
            "fitsPath": target["rawFile"],
            "metadataPath": target["recordFile"],
            "retrievedAt": target.get("retrievedAt", "2026-08-28T03:53:18.820Z"),
            "mediaType": "application/fits",
            "byteLength": (RAW / target["rawFile"]).stat().st_size,
            "sha256": digest(RAW / target["rawFile"]),
        })
    save(path, document)


def update_source_registry() -> None:
    document = load(SOURCE_REGISTRY)
    for target in TARGETS:
        entry = next(item for item in document["sources"] if item["id"] == target["layerId"] or item["surveyId"] == target["surveyId"] and item["releaseId"] == target["releaseId"])
        entry.update({
            "status": "acquired",
            "acquiredAt": target.get("retrievedAt", "2026-08-28T03:53:18.820Z"),
            "sourceSnapshotSha256": digest(RAW / target["rawFile"]),
            "sourceRecordSha256": digest(RAW / target["recordFile"]),
            **({"attributionUrl": target["attributionUrl"]} if target.get("attributionUrl") else {}),
        })
    save(SOURCE_REGISTRY, document)


def update_layers() -> None:
    registry = load(LAYERS)
    plan = load(BUILD_PLAN)
    existing = {entry["layerId"]: entry for entry in registry["layers"]}
    planned = {entry["spec"]: entry for entry in plan["builds"]}
    for target in TARGETS:
        output = f"artifacts/public-survey-footprints/layers/{target['layerId']}"
        output_file = ROOT / output / f"{target['layerId']}.moc.fits"
        layer = existing.get(target["layerId"])
        if layer is None:
            layer = {"layerId": target["layerId"]}
            registry["layers"].append(layer)
        layer.update({
            "surveyId": target["surveyId"],
            "releaseId": target["releaseId"],
            "product": target["product"],
            "modality": target.get("modality", "imaging"),
            "coverageRole": target.get("coverageRole", "footprint_extent"),
            "dataOrigin": target.get("dataOrigin", "observed"),
            "sourceTier": "third_party_moc",
            "maxOrder": 10,
            "status": "acquired",
            "sourceUrl": target["officialUrl"],
            "geometrySourceUrl": target["mocUrl"],
            "recipePath": f"src/layers/recipes/{target['layerId']}.lock.json",
            "artifactPath": f"{output}/{target['layerId']}.moc.fits",
            "expectedSha256": digest(output_file),
        })
        spec = layer["recipePath"]
        planned[spec] = {"spec": spec, "output": output, "expectedSha256": layer["expectedSha256"]}
    registry["layers"] = restore_order(registry["layers"], LEGACY_LAYER_ORDER, lambda entry: entry["layerId"])
    plan["builds"] = sorted(planned.values(), key=lambda entry: entry["spec"])
    save(LAYERS, registry)
    save(BUILD_PLAN, plan)


def main() -> None:
    for target in TARGETS:
        if not (RAW / target["rawFile"]).is_file() or not (RAW / target["recordFile"]).is_file():
            raise SystemExit(f"Missing acquired snapshot for {target['layerId']}")
    update_footprints()
    update_sources()
    update_raw_index()
    update_source_registry()
    update_layers()
    normalized = ROOT / "artifacts/public-survey-footprints/normalized/survey-footprints.json"
    normalized.write_bytes(FOOTPRINTS.read_bytes())
    print(f"Prepared {len(TARGETS)} reviewed third-party MOC layers")


if __name__ == "__main__":
    main()
