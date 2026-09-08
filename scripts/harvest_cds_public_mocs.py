#!/usr/bin/env python3
"""Acquire a reviewed batch of public CDS MOCs and register them in Assets.

The network step is intentionally narrow and allow-listed.  Every response is
saved as evidence first; layer artifacts are then generated from those local
snapshots, so a later build does not depend on CDS availability.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CORE_ROOT = Path(os.environ.get("MOC_CORE_ROOT", ROOT.parent / "MOC-Core-SDK")).resolve()
sys.path.insert(0, str(CORE_ROOT))
from astro_survey_moc_core.core import canonical_cells, project_cells, read_moc_fits, validate_moc_fits, write_moc_fits
from astro_survey_moc_core.contract import CORE_VERSION

RAW = ROOT / "artifacts/public-survey-footprints/raw/moc"
LAYERS_ROOT = ROOT / "artifacts/public-survey-footprints/layers"
CATALOG_PATH = ROOT / "src/surveys/survey-catalog.json"
FOOTPRINT_PATH = ROOT / "src/footprints/survey-footprints.json"
NORMALIZED_FOOTPRINT_PATH = ROOT / "artifacts/public-survey-footprints/normalized/survey-footprints.json"
SOURCES_PATH = ROOT / "artifacts/public-survey-footprints/sources.json"
SOURCE_REGISTRY_PATH = ROOT / "src/moc-sources/source-registry.json"
LAYER_REGISTRY_PATH = ROOT / "src/layers/layer-registry.json"
BUILD_PLAN_PATH = ROOT / "src/layers/public-build-plan.json"

RETRIEVED_AT = "2026-09-05T00:00:00Z"

SURVEY_META: dict[str, tuple[str, str, str, str]] = {
    "decaps": ("DECaPS", "DECam Plane Survey", "#e6a15c", "https://decaps.skymaps.info/"),
    "fds": ("FDS", "Fornax Deep Survey", "#e59a9c", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    "iphas": ("IPHAS", "INT Photometric H-alpha Survey", "#a6d189", "https://www.iphas.org/"),
    "vphas": ("VPHAS+", "VST Photometric H-alpha Survey", "#d9a0ff", "https://www.vphasplus.org/"),
    "ztf": ("ZTF", "Zwicky Transient Facility", "#f7c873", "https://www.ztf.caltech.edu/"),
    "spherex": ("SPHEREx", "Spectro-Photometer for the History of the Universe", "#8fd7d2", "https://www.ipac.caltech.edu/project/spherex"),
    "rubin": ("Rubin", "Vera C. Rubin Observatory", "#f08b7c", "https://rubinobservatory.org/"),
    "sumss": ("SUMSS", "Sydney University Molonglo Sky Survey", "#b8b5ff", "https://www.astrop.physics.usyd.edu.au/SUMSS/"),
    "wenss": ("WENSS", "Westerbork Northern Sky Survey", "#8cc8ff", "https://www.astron.nl/"),
    "cfhtls": ("CFHTLS", "Canada-France-Hawaii Telescope Legacy Survey", "#e8c07d", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    "act": ("ACT", "Atacama Cosmology Telescope", "#d78cf0", "https://lambda.gsfc.nasa.gov/product/act/"),
    "akari": ("AKARI", "AKARI infrared all-sky survey", "#b1d8a6", "https://www.ir.isas.jaxa.jp/AKARI/"),
}


def item(source_id: str, survey_id: str, release_id: str, product: str, modality: str, official_url: str) -> dict[str, str]:
    return {
        "sourceId": source_id,
        "surveyId": survey_id,
        "releaseId": release_id,
        "product": product,
        "modality": modality,
        "officialUrl": official_url,
    }


TARGETS: list[dict[str, str]] = [
    item("CDS/P/DECaPS/DR2/color", "decaps", "decaps-dr2", "DECaPS DR2 color imaging", "imaging", "https://decaps.skymaps.info/"),
    item("CDS/P/DES-DR2/Y", "des", "des-dr2", "DR2 Y-band imaging", "imaging", "https://www.darkenergysurvey.org/the-des-project/data-access/"),
    item("CDS/P/DES-DR2/g", "des", "des-dr2", "DR2 g-band imaging", "imaging", "https://www.darkenergysurvey.org/the-des-project/data-access/"),
    item("CDS/P/DES-DR2/i", "des", "des-dr2", "DR2 i-band imaging", "imaging", "https://www.darkenergysurvey.org/the-des-project/data-access/"),
    item("CDS/P/DES-DR2/r", "des", "des-dr2", "DR2 r-band imaging", "imaging", "https://www.darkenergysurvey.org/the-des-project/data-access/"),
    item("CDS/P/DES-DR2/z", "des", "des-dr2", "DR2 z-band imaging", "imaging", "https://www.darkenergysurvey.org/the-des-project/data-access/"),
    # CDS publishes separate Euclid ERO HiPS/MOC products for the first
    # images, each NISP band, VIS, and the combined color product. Keep every
    # source ID as its own Assets product so release and band provenance stay
    # auditable instead of collapsing them into one footprint.
    item("CDS/P/Euclid/ERO/FirstImages", "euclid", "euclid-ero", "ERO First Images", "imaging", "https://www.cosmos.esa.int/web/euclid/ero-public-release"),
    item("CDS/P/Euclid/ERO/NISP.H", "euclid", "euclid-ero", "ERO NISP.H", "imaging", "https://www.cosmos.esa.int/web/euclid/ero-public-release"),
    item("CDS/P/Euclid/ERO/NISP.J", "euclid", "euclid-ero", "ERO NISP.J", "imaging", "https://www.cosmos.esa.int/web/euclid/ero-public-release"),
    item("CDS/P/Euclid/ERO/NISP.Y", "euclid", "euclid-ero", "ERO NISP.Y", "imaging", "https://www.cosmos.esa.int/web/euclid/ero-public-release"),
    item("CDS/P/Euclid/ERO/VIS", "euclid", "euclid-ero", "ERO VIS", "imaging", "https://www.cosmos.esa.int/web/euclid/ero-public-release"),
    item("CDS/P/Euclid/ERO/color", "euclid", "euclid-ero", "ERO color imaging", "imaging", "https://www.cosmos.esa.int/web/euclid/ero-public-release"),
    item("CDS/P/Euclid/Q1/NISP.H", "euclid", "euclid-q1", "Euclid Q1 NISP.H", "imaging", "https://www.esa.int/Science_Exploration/Space_Science/Euclid"),
    item("CDS/P/Euclid/Q1/NISP.J", "euclid", "euclid-q1", "Euclid Q1 NISP.J", "imaging", "https://www.esa.int/Science_Exploration/Space_Science/Euclid"),
    item("CDS/P/Euclid/Q1/NISP.Y", "euclid", "euclid-q1", "Euclid Q1 NISP.Y", "imaging", "https://www.esa.int/Science_Exploration/Space_Science/Euclid"),
    item("CDS/P/Euclid/Q1/VIS", "euclid", "euclid-q1", "Euclid Q1 VIS", "imaging", "https://www.esa.int/Science_Exploration/Space_Science/Euclid"),
    item("CDS/P/Euclid/Q1/color", "euclid", "euclid-q1", "Euclid Q1 color imaging", "imaging", "https://www.esa.int/Science_Exploration/Space_Science/Euclid"),
    item("CDS/P/FDS/DR1/color", "fds", "fds-dr1", "FDS DR1 color imaging", "imaging", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/FDS/DR1/g", "fds", "fds-dr1", "FDS DR1 g-band imaging", "imaging", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/FDS/DR1/i", "fds", "fds-dr1", "FDS DR1 i-band imaging", "imaging", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/FDS/DR1/r", "fds", "fds-dr1", "FDS DR1 r-band imaging", "imaging", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/FDS/DR1/u", "fds", "fds-dr1", "FDS DR1 u-band imaging", "imaging", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/IPHAS/DR2/halpha", "iphas", "iphas-dr2", "IPHAS DR2 H-alpha imaging", "imaging", "https://www.iphas.org/"),
    item("CDS/P/IPHAS/DR2/i", "iphas", "iphas-dr2", "IPHAS DR2 i-band imaging", "imaging", "https://www.iphas.org/"),
    item("CDS/P/IPHAS/DR2/r", "iphas", "iphas-dr2", "IPHAS DR2 r-band imaging", "imaging", "https://www.iphas.org/"),
    item("CDS/P/VPHAS/DR4/Halpha", "vphas", "vphas-dr4", "VPHAS+ DR4 H-alpha imaging", "imaging", "https://www.vphasplus.org/"),
    item("CDS/P/VPHAS/DR4/color", "vphas", "vphas-dr4", "VPHAS+ DR4 color imaging", "imaging", "https://www.vphasplus.org/"),
    item("CDS/P/VPHAS/DR4/g", "vphas", "vphas-dr4", "VPHAS+ DR4 g-band imaging", "imaging", "https://www.vphasplus.org/"),
    item("CDS/P/VPHAS/DR4/i", "vphas", "vphas-dr4", "VPHAS+ DR4 i-band imaging", "imaging", "https://www.vphasplus.org/"),
    item("CDS/P/VPHAS/DR4/r", "vphas", "vphas-dr4", "VPHAS+ DR4 r-band imaging", "imaging", "https://www.vphasplus.org/"),
    item("CDS/P/VPHAS/DR4/u", "vphas", "vphas-dr4", "VPHAS+ DR4 u-band imaging", "imaging", "https://www.vphasplus.org/"),
    item("CDS/P/ZTF/DR7/color", "ztf", "ztf-dr7", "ZTF DR7 color imaging", "imaging", "https://www.ztf.caltech.edu/"),
    item("CDS/P/ZTF/DR7/g", "ztf", "ztf-dr7", "ZTF DR7 g-band imaging", "imaging", "https://www.ztf.caltech.edu/"),
    item("CDS/P/ZTF/DR7/i", "ztf", "ztf-dr7", "ZTF DR7 i-band imaging", "imaging", "https://www.ztf.caltech.edu/"),
    item("CDS/P/ZTF/DR7/r", "ztf", "ztf-dr7", "ZTF DR7 r-band imaging", "imaging", "https://www.ztf.caltech.edu/"),
    item("CDS/P/SPHEREx/QR2/color", "spherex", "spherex-qr2", "SPHEREx QR2 color coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/SPHEREx/QR2/D1", "spherex", "spherex-qr2", "SPHEREx QR2 D1 coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/SPHEREx/QR2/D2", "spherex", "spherex-qr2", "SPHEREx QR2 D2 coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/SPHEREx/QR2/D3", "spherex", "spherex-qr2", "SPHEREx QR2 D3 coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/SPHEREx/QR2/D4", "spherex", "spherex-qr2", "SPHEREx QR2 D4 coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/SPHEREx/QR2/D5", "spherex", "spherex-qr2", "SPHEREx QR2 D5 coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/SPHEREx/QR2/D6", "spherex", "spherex-qr2", "SPHEREx QR2 D6 coverage", "infrared", "https://www.ipac.caltech.edu/project/spherex"),
    item("CDS/P/Rubin/FirstLook", "rubin", "rubin-firstlook", "Rubin First Look imaging", "imaging", "https://rubinobservatory.org/"),
    item("CDS/P/SUMSS", "sumss", "sumss-final", "SUMSS 843 MHz imaging", "imaging", "https://www.astrop.physics.usyd.edu.au/SUMSS/"),
    item("CDS/P/WENSS", "wenss", "wenss-final", "WENSS 325 MHz imaging", "imaging", "https://www.astron.nl/"),
    item("CDS/P/CFHTLS/W/Color/ugi", "cfhtls", "cfhtls-wide", "CFHTLS Wide u/g/i color imaging", "imaging", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    item("CDS/P/CFHTLS/W/g", "cfhtls", "cfhtls-wide", "CFHTLS Wide g-band imaging", "imaging", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    item("CDS/P/CFHTLS/W/i", "cfhtls", "cfhtls-wide", "CFHTLS Wide i-band imaging", "imaging", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    item("CDS/P/CFHTLS/W/r", "cfhtls", "cfhtls-wide", "CFHTLS Wide r-band imaging", "imaging", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    item("CDS/P/CFHTLS/W/u", "cfhtls", "cfhtls-wide", "CFHTLS Wide u-band imaging", "imaging", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    item("CDS/P/CFHTLS/W/z", "cfhtls", "cfhtls-wide", "CFHTLS Wide z-band imaging", "imaging", "https://www.cfht.hawaii.edu/Science/CFHTLS/"),
    item("CDS/P/VISTA/VVV/DR4/ColorJYZ", "vista", "vista-vvv-dr4", "VVV DR4 J/Y/Z color imaging", "infrared", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/VISTA/VVV/DR4/H/Bulge", "vista", "vista-vvv-dr4", "VVV DR4 H bulge imaging", "infrared", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/VISTA/VVV/DR4/H/Disk", "vista", "vista-vvv-dr4", "VVV DR4 H disk imaging", "infrared", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/VISTA/VVV/DR4/J", "vista", "vista-vvv-dr4", "VVV DR4 J-band imaging", "infrared", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/VISTA/VVV/DR4/Y", "vista", "vista-vvv-dr4", "VVV DR4 Y-band imaging", "infrared", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/VISTA/VVV/DR4/Z", "vista", "vista-vvv-dr4", "VVV DR4 Z-band imaging", "infrared", "https://www.eso.org/sci/observing/phase3/data_releases.html"),
    item("CDS/P/GALEXGR6/AIS/color", "galex", "galex-gr6-ais", "GALEX AIS color imaging", "ultraviolet", "https://galex.stsci.edu/"),
    item("CDS/P/GALEXGR6/AIS/FUV", "galex", "galex-gr6-ais", "GALEX AIS FUV imaging", "ultraviolet", "https://galex.stsci.edu/"),
    item("CDS/P/GALEXGR6/AIS/NUV", "galex", "galex-gr6-ais", "GALEX AIS NUV imaging", "ultraviolet", "https://galex.stsci.edu/"),
    item("CDS/P/2MASS6X/H", "2mass", "2mass-6x", "2MASS 6X H-band imaging", "infrared", "https://irsa.ipac.caltech.edu/Missions/2mass.html"),
    item("CDS/P/2MASS6X/J", "2mass", "2mass-6x", "2MASS 6X J-band imaging", "infrared", "https://irsa.ipac.caltech.edu/Missions/2mass.html"),
    item("CDS/P/2MASS6X/K", "2mass", "2mass-6x", "2MASS 6X K-band imaging", "infrared", "https://irsa.ipac.caltech.edu/Missions/2mass.html"),
    item("CDS/P/SDSS9/g", "sdss", "sdss-dr09", "DR9 g-band imaging", "imaging", "https://www.sdss.org/dr9/"),
    item("CDS/P/SDSS9/i", "sdss", "sdss-dr09", "DR9 i-band imaging", "imaging", "https://www.sdss.org/dr9/"),
    item("CDS/P/SDSS9/r", "sdss", "sdss-dr09", "DR9 r-band imaging", "imaging", "https://www.sdss.org/dr9/"),
    item("CDS/P/SDSS9/u", "sdss", "sdss-dr09", "DR9 u-band imaging", "imaging", "https://www.sdss.org/dr9/"),
    item("CDS/P/SDSS9/z", "sdss", "sdss-dr09", "DR9 z-band imaging", "imaging", "https://www.sdss.org/dr9/"),
    item("CDS/P/ACT/DR5/f90", "act", "act-dr5", "ACT DR5 90 GHz coverage", "radio", "https://lambda.gsfc.nasa.gov/product/act/"),
    item("CDS/P/ACT/DR5/f150", "act", "act-dr5", "ACT DR5 150 GHz coverage", "radio", "https://lambda.gsfc.nasa.gov/product/act/"),
    item("CDS/P/ACT/DR5/f220", "act", "act-dr5", "ACT DR5 220 GHz coverage", "radio", "https://lambda.gsfc.nasa.gov/product/act/"),
    item("CDS/P/AKARI/FIS/Color", "akari", "akari-fis", "AKARI FIS color coverage", "infrared", "https://www.ir.isas.jaxa.jp/AKARI/"),
]


def load(path: Path) -> Any:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        # MocServer record responses may be declared ISO-8859-1. Keep the
        # original bytes for evidence/hash purposes, but parse their JSON.
        text = raw.decode("iso-8859-1")
    return json.loads(text)


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def slug(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))[:96]


def fetch(url: str) -> bytes:
    last: Exception | None = None
    for attempt in range(3):
        try:
            request = Request(url, headers={"User-Agent": "astro-survey-atlas-assets-cds-harvester/1"})
            with urlopen(request, timeout=90) as response:
                body = response.read()
                if not body:
                    raise RuntimeError("empty response")
                return body
        except Exception as error:  # pragma: no cover - network retries are operational
            last = error
            if attempt < 2:
                time.sleep(1 + attempt)
    raise RuntimeError(f"failed to fetch {url}: {last}")


def record_urls(source_id: str) -> tuple[str, str]:
    encoded = quote(source_id, safe="")
    base = "https://alasky.cds.unistra.fr/MocServer/query"
    return f"{base}?ID={encoded}&get=record&fmt=json", base


def cap_cells(cells: tuple[tuple[int, int], ...], max_order: int) -> tuple[tuple[int, int], ...]:
    capped = []
    for order, ipix in cells:
        if order > max_order:
            capped.append((max_order, ipix >> (2 * (order - max_order))))
        else:
            capped.append((order, ipix))
    return canonical_cells(capped, max_order=max_order)


def write_json(path: Path, value: Any) -> dict[str, Any]:
    encoded = (json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    path.write_bytes(encoded)
    return {"path": path.name, "sha256": hashlib.sha256(encoded).hexdigest(), "sizeBytes": len(encoded)}


def layer_id_for(target: dict[str, str]) -> str:
    return slug(f"{target['surveyId']}-{target['releaseId']}-{target['product']}-moc")


def acquire(target: dict[str, str]) -> dict[str, Any]:
    record_url, moc_base = record_urls(target["sourceId"])
    record_path = RAW / f"{layer_id_for(target)}.record.json"
    if record_path.exists():
        record_bytes = record_path.read_bytes()
    else:
        record_bytes = fetch(record_url)
        record_path.write_bytes(record_bytes)
    parsed = load(record_path)
    first = parsed[0] if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict) else parsed
    native_order = int(first.get("moc_order", 10)) if isinstance(first, dict) else 10
    max_order = min(native_order, 10)
    moc_url = f"{moc_base}?ID={quote(target['sourceId'], safe='')}&get=smoc&order={max_order}&fmt=fits"
    moc_path = RAW / f"{layer_id_for(target)}.fits"
    if not moc_path.exists():
        moc_path.write_bytes(fetch(moc_url))
    cells = validate_moc_fits(moc_path)
    if not cells:
        raise RuntimeError(f"empty MOC for {target['sourceId']}")
    return {
        **target,
        "layerId": layer_id_for(target),
        "recordUrl": record_url,
        "mocUrl": moc_url,
        "recordPath": record_path,
        "mocPath": moc_path,
        "record": first if isinstance(first, dict) else {},
        "recordSha256": digest(record_path),
        "snapshotSha256": digest(moc_path),
        "snapshotSizeBytes": moc_path.stat().st_size,
        "nativeOrder": native_order,
        "maxOrder": max_order,
        "mocType": str((first or {}).get("moc_type", "smoc")).lower(),
        "cells": cells,
    }


def build_layer(info: dict[str, Any]) -> dict[str, Any]:
    max_order = int(info["maxOrder"])
    query_order = min(8, max_order)
    preview_order = min(4, max_order)
    cells = cap_cells(info["cells"], max_order)
    output_root = LAYERS_ROOT / info["layerId"]
    output_root.mkdir(parents=True, exist_ok=True)
    moc_name = f"{info['layerId']}.moc.fits"
    moc_path = output_root / moc_name
    moc_sha = write_moc_fits(moc_path, cells, max_order=max_order)
    query_record = write_json(output_root / f"query-order{query_order}.json", {"schemaVersion": 1, "order": query_order, "ordering": "NESTED", "pixels": project_cells(cells, query_order)})
    preview_record = write_json(output_root / f"preview-order{preview_order}.json", {"schemaVersion": 1, "order": preview_order, "ordering": "NESTED", "pixels": project_cells(cells, preview_order)})
    stats_record = write_json(output_root / "statistics.json", {
        "schemaVersion": 1, "coordinateFrame": "ICRS", "ordering": "NESTED", "cellCount": len(cells),
        "availableOrders": sorted({order for order, _ in cells}), "queryOrder": query_order,
        "queryPixelCount": len(project_cells(cells, query_order)), "previewOrder": preview_order,
        "previewPixelCount": len(project_cells(cells, preview_order)), "sourceSha256": info["snapshotSha256"],
    })
    recipe = {
        "layerId": info["layerId"], "surveyId": info["surveyId"], "releaseId": info["releaseId"], "product": info["product"],
        "modality": info["modality"], "mode": "native-moc", "coverageRole": "footprint_extent", "dataOrigin": "observed",
        "sourceTier": "third_party_moc", "maxOrder": max_order, "queryOrder": query_order, "previewOrder": preview_order,
        "coordinateFrame": "ICRS", "ordering": "NESTED", "sourceUrl": info["officialUrl"],
        "input": f"artifacts/public-survey-footprints/raw/moc/{info['mocPath'].name}",
        "recipe": {
            "sourceKind": "hips-stmoc" if info["mocType"] == "stmoc" else "hips-smoc", "sourceId": info["sourceId"],
            "sourceRecordUrl": info["recordUrl"], "sourceMocUrl": info["mocUrl"], "sourceRecordSha256": info["recordSha256"],
            "nativeSpatialOrder": info["nativeOrder"], "exportOrder": max_order,
            "availableOrders": list(range(0, max_order + 1)), "precision": "estimated",
            "precisionJustification": "CDS public HiPS spatial MOC; exported cells are preserved or coarsened to the locked maximum order and are not an accepted-CCD or depth mask.",
            "limitations": ["The MOC describes the public CDS/HiPS product extent, not a per-exposure selection function.", "Temporal metadata in an STMOC source is retained in the source record but is not represented in this spatial layer."],
        },
        "snapshot": {"sha256": info["snapshotSha256"], "sizeBytes": info["snapshotSizeBytes"], "sourceUrl": info["mocUrl"], "recordSha256": info["recordSha256"], "retrievedAt": RETRIEVED_AT},
    }
    recipe_path = ROOT / "src/layers/recipes" / f"{info['layerId']}.lock.json"
    save(recipe_path, recipe)
    provenance = {
        "schemaVersion": 1, "generatedAt": RETRIEVED_AT, "layerId": info["layerId"], "coreVersion": CORE_VERSION,
        "coordinateFrame": "ICRS", "ordering": "NESTED", "coverageRole": "footprint_extent", "dataOrigin": "observed", "sourceTier": "third_party_moc",
        "sourceUrl": info["officialUrl"], "input": {"path": info["mocPath"].name, "sha256": info["snapshotSha256"]},
        "snapshot": {"sha256": info["snapshotSha256"], "recordSha256": info["recordSha256"], "retrievedAt": RETRIEVED_AT},
        "recipe": recipe["recipe"],
        "outputs": {
            "moc": {"path": moc_name, "sha256": moc_sha, "sizeBytes": moc_path.stat().st_size},
            "query": query_record, "preview": preview_record, "statistics": stats_record,
        },
    }
    save(output_root / "provenance.json", provenance)
    return {"recipePath": str(recipe_path.relative_to(ROOT)), "artifactPath": str((output_root / moc_name).relative_to(ROOT)), "expectedSha256": moc_sha, "queryOrder": query_order, "previewOrder": preview_order, "cells": cells, "queryPixels": project_cells(cells, query_order)}


def ensure_survey(catalog: dict[str, Any], info: dict[str, Any]) -> dict[str, Any]:
    survey_id = info["surveyId"]
    name, mission, color, official_url = SURVEY_META.get(survey_id, (survey_id.upper(), survey_id, "#8cc8ff", info["officialUrl"]))
    survey = next((entry for entry in catalog["surveys"] if entry["id"] == survey_id), None)
    if survey is None:
        survey = {"id": survey_id, "name": name, "mission": mission, "color": color, "description": f"Public {name} coverage represented by reviewed CDS HiPS/MOC products.", "modalities": [], "releases": []}
        catalog["surveys"].append(survey)
    release = next((entry for entry in survey["releases"] if entry["id"] == info["releaseId"]), None)
    if release is None:
        release = {"id": info["releaseId"], "label": info["releaseId"].replace("-", " ").title(), "kind": "public_release", "releasedYear": 2025, "modalities": [], "products": []}
        survey["releases"].append(release)
    product = next((entry for entry in release["products"] if entry["name"] == info["product"]), None)
    if product is None:
        product = {"name": info["product"]}
        release["products"].append(product)
    product.update({"modality": info["modality"], "description": f"{info['product']} public CDS HiPS/MOC availability extent.", "status": "acquired", "dataOrigin": "observed", "sourceTier": "third_party_moc", "sourceLabel": "CDS public HiPS/MOC", "sourceUrl": info["officialUrl"], "geometrySourceLabel": "CDS MocServer spatial MOC", "geometrySourceUrl": info["mocUrl"]})
    if info["modality"] not in release["modalities"]: release["modalities"].append(info["modality"])
    if info["modality"] not in survey["modalities"]: survey["modalities"].append(info["modality"])
    return survey


def update_metadata(infos: list[dict[str, Any]], builds: dict[str, dict[str, Any]]) -> None:
    catalog = load(CATALOG_PATH)
    footprints = load(FOOTPRINT_PATH)
    sources = load(SOURCES_PATH)
    source_registry = load(SOURCE_REGISTRY_PATH)
    layer_registry = load(LAYER_REGISTRY_PATH)
    build_plan = load(BUILD_PLAN_PATH)
    source_releases = {(entry["surveyId"], entry["releaseId"]): entry for entry in sources["releases"]}
    source_entries = {entry["id"]: entry for entry in source_registry["sources"]}
    layers = {entry["layerId"]: entry for entry in layer_registry["layers"]}
    plans = {entry["spec"]: entry for entry in build_plan["builds"]}
    footprint_by_key = {(entry["surveyId"], entry["releaseId"], entry["product"]): entry for entry in footprints["footprints"]}
    for info in infos:
        ensure_survey(catalog, info)
        key = (info["surveyId"], info["releaseId"], info["product"])
        footprint_by_key[key] = {"surveyId": info["surveyId"], "releaseId": info["releaseId"], "product": info["product"], "label": info["product"], "nside": 16, "pixels": list(project_cells(builds[info["layerId"]]["cells"], 4)), "quality": "moc", "sourceUrl": info["mocUrl"], "sourceId": info["sourceId"], "retrievedAt": RETRIEVED_AT, "notes": "Spatial projection of a public CDS HiPS MOC. Product availability extent is estimated and does not encode exposure depth or time-window coverage."}
        release = source_releases.get((info["surveyId"], info["releaseId"]))
        if release is None:
            release = {"surveyId": info["surveyId"], "releaseId": info["releaseId"], "products": []}
            sources["releases"].append(release)
            source_releases[(info["surveyId"], info["releaseId"])] = release
        product = next((entry for entry in release["products"] if entry["product"] == info["product"]), None)
        if product is None:
            product = {"product": info["product"]}
            release["products"].append(product)
        product.update({"status": "acquired", "sourceUrl": info["officialUrl"], "geometrySourceUrl": info["mocUrl"], "coverageRole": "footprint_extent", "notes": "Reviewed public CDS spatial MOC; effective precision is the locked export order."})
        source_entries[info["layerId"]] = {"id": info["layerId"], "surveyId": info["surveyId"], "releaseId": info["releaseId"], "product": info["product"], "authority": "CDS public HiPS/MocServer", "sourceKind": "hips-stmoc" if info["mocType"] == "stmoc" else "hips-smoc", "sourceUrl": info["officialUrl"], "recordUrl": info["recordUrl"], "mocUrl": info["mocUrl"], "maxOrder": info["maxOrder"], "overviewOrder": min(4, info["maxOrder"]), "coverageRole": "footprint_extent", "dataOrigin": "observed", "sourceTier": "third_party_moc", "precision": "estimated", "licenseStatus": "CDS-public-derivative-metadata-with-upstream-attribution", "status": "acquired", "acquiredAt": RETRIEVED_AT, "sourceSnapshotSha256": info["snapshotSha256"], "sourceRecordSha256": info["recordSha256"], "attributionUrl": info["officialUrl"], "notes": "CDS MOC/HiPS product extent; retain survey acknowledgement and do not interpret as accepted-CCD geometry."}
        build = builds[info["layerId"]]
        layers[info["layerId"]] = {"layerId": info["layerId"], "surveyId": info["surveyId"], "releaseId": info["releaseId"], "product": info["product"], "modality": info["modality"], "coverageRole": "footprint_extent", "dataOrigin": "observed", "sourceTier": "third_party_moc", "maxOrder": info["maxOrder"], "status": "acquired", "recipePath": build["recipePath"], "artifactPath": build["artifactPath"], "expectedSha256": build["expectedSha256"], "sourceUrl": info["officialUrl"], "geometrySourceUrl": info["mocUrl"]}
        plans[build["recipePath"]] = {"spec": build["recipePath"], "output": str((LAYERS_ROOT / info["layerId"]).relative_to(ROOT)), "expectedSha256": build["expectedSha256"]}
    footprints["footprints"] = sorted(footprint_by_key.values(), key=lambda entry: (entry["surveyId"], entry["releaseId"], entry["product"]))
    sources["releases"] = sorted(sources["releases"], key=lambda entry: (entry["surveyId"], entry["releaseId"]))
    source_registry["sources"] = sorted(source_entries.values(), key=lambda entry: entry["id"])
    layer_registry["layers"] = sorted(layers.values(), key=lambda entry: entry["layerId"])
    build_plan["builds"] = sorted(plans.values(), key=lambda entry: entry["spec"])
    save(CATALOG_PATH, catalog)
    save(FOOTPRINT_PATH, footprints)
    save(SOURCES_PATH, sources)
    save(SOURCE_REGISTRY_PATH, source_registry)
    save(LAYER_REGISTRY_PATH, layer_registry)
    save(BUILD_PLAN_PATH, build_plan)
    NORMALIZED_FOOTPRINT_PATH.write_bytes(FOOTPRINT_PATH.read_bytes())


def update_raw_index(infos: list[dict[str, Any]]) -> None:
    path = RAW / "index.json"
    index = load(path)
    by_id = {entry.get("sourceId"): entry for entry in index["artifacts"]}
    for info in infos:
        by_id[info["sourceId"]] = {"surveyId": info["surveyId"], "releaseId": info["releaseId"], "product": info["product"], "sourceId": info["sourceId"], "sourceUrl": info["mocUrl"], "metadataUrl": info["recordUrl"], "fitsPath": info["mocPath"].name, "metadataPath": info["recordPath"].name, "retrievedAt": RETRIEVED_AT, "mediaType": "application/fits", "byteLength": info["mocPath"].stat().st_size, "sha256": info["snapshotSha256"]}
    index["generatedAt"] = RETRIEVED_AT
    index["artifacts"] = sorted(by_id.values(), key=lambda entry: (entry.get("surveyId", ""), entry.get("releaseId", ""), entry.get("product", ""), entry.get("sourceId", "")))
    save(path, index)


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    infos = [acquire(target) for target in TARGETS]
    builds = {info["layerId"]: build_layer(info) for info in infos}
    update_raw_index(infos)
    update_metadata(infos, builds)
    print(f"Acquired and registered {len(infos)} CDS MOCs; static footprint count is now {len(load(FOOTPRINT_PATH)['footprints'])}.")


if __name__ == "__main__":
    main()
