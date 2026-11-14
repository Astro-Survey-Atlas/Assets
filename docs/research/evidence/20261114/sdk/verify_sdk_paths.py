"""Bounded offline SDK audit: synthetic astronomy inputs and one captured MOC.

Run with the Assets-pinned wheel, not from the upstream SDK checkout:
  /workspace/work/venv-sdk/bin/python verify_sdk_paths.py
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy_healpix import HEALPix

from astro_survey_moc_core.core import (
    build_layer, canonical_cells, cell_for_uniq, project_cells,
    read_moc_fits, validate_moc_fits, write_moc_fits,
)
from astro_survey_moc_core.resource_package import (
    PackageValidationError, build_resource_package, validate_resource_package,
)

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "synthetic-sdk-paths"
OUT.mkdir(exist_ok=True)
os.environ["SOURCE_DATE_EPOCH"] = "1787184000"
results = {}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def spec(layer_id, mode, source, role="image_extent", **extra):
    return {
        "layerId": layer_id, "mode": mode, "input": str(source),
        "coverageRole": role, "dataOrigin": "simulated",
        "sourceTier": "user_file_derived", "maxOrder": 8,
        "queryOrder": 8, "previewOrder": 4, **extra,
    }


def synthetic_image(ra, filename):
    header = fits.Header({
        "CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN",
        "CRPIX1": 16.5, "CRPIX2": 12.5,
        "CRVAL1": ra, "CRVAL2": 0.0,
        "CD1_1": -0.1, "CD1_2": 0.0,
        "CD2_1": 0.0, "CD2_2": 0.1,
    })
    target = OUT / filename
    fits.PrimaryHDU(np.zeros((24, 32), dtype=np.uint8), header).writeto(target, overwrite=True)
    return target


one = build_layer(spec("synthetic-image-a", "fits-wcs", synthetic_image(10, "image-a.fits")), OUT / "wcs-a")
two = build_layer(spec("synthetic-image-b", "fits-wcs", synthetic_image(30, "image-b.fits")), OUT / "wcs-b")
hp = HEALPix(nside=256, order="nested", frame="icrs")
center = int(hp.skycoord_to_healpix(SkyCoord(10*u.deg, 0*u.deg, frame="icrs")))
assert center in project_cells(one.cells, 8)
assert len(project_cells(one.cells, 8)) > 1, "WCS must cover image extent, not just its center"
results["fits_wcs"] = {"nativeCells": len(one.cells), "order8Cells": len(project_cells(one.cells, 8)), "centerPresent": True}

catalog = OUT / "catalog.json"
catalog.write_text(json.dumps([{"ra": 10.0, "dec": 0.0}, {"ra": 30.0, "dec": 10.0}, {"ra": 370.0, "dec": 0.0}]))
points = build_layer(spec("synthetic-catalog", "catalog-radec", catalog, "object_presence", dataOrigin="catalog"), OUT / "catalog-build")
expected = sorted(set(int(x) for x in hp.skycoord_to_healpix(SkyCoord([10,30]*u.deg, [0,10]*u.deg))))
assert list(project_cells(points.cells, 8)) == expected
results["catalog_radec"] = {"inputRows": 3, "uniquePointCells": expected, "raWrapDeduplicated": True}

expected_union = canonical_cells([*one.cells, *two.cells])
expected_path = OUT / "expected-union.fits"
expected_sha = write_moc_fits(expected_path, expected_union, max_order=8)
merged = OUT / "merged.fits"
merge_command = [sys.executable, "-m", "astro_survey_moc_core.cli", "merge", "--input", str(two.moc_path), "--input", str(one.moc_path), "--output", str(merged), "--max-order", "8"]
merge = subprocess.run(merge_command, capture_output=True, text=True, check=True)
assert read_moc_fits(merged) == expected_union
assert digest(merged) == expected_sha
results["merge"] = {"command": merge_command, "result": json.loads(merge.stdout), "canonicalUnionAndBytesEqual": True}

coarse = [(4, 30)]
assert len(project_cells(coarse, 4)) == 1
assert len(project_cells(coarse, 8)) == 256
assert max(o for o, _ in canonical_cells(coarse)) == 4
results["projection_precision"] = {"nativeMaxOrder": 4, "order4Pixels": 1, "order8Pixels": 256, "finerProjectionChangesNativePrecision": False}

official = ROOT.parent / "spherex" / "hips_moc.body"
if official.is_file():
    source = OUT / "spherex-dr1-cube-official.moc.fits"
    source.write_bytes(official.read_bytes())
    with fits.open(source) as hdul:
        native = next(h for h in hdul if getattr(h.data, "names", None) and "UNIQ" in h.data.names)
        raw_order = max(cell_for_uniq(v)[0] for v in native.data["UNIQ"])
        header_order = native.header["MOCORDER"]
    cells = validate_moc_fits(source)
    official_spec = spec("official-spherex-dr1-cube-audit", "nested-healpix", source,
        dataOrigin="observed", sourceTier="official_geometry", maxOrder=raw_order,
        sourceUrl="https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Moc.fits",
        snapshot={"sha256": digest(source), "sizeBytes": source.stat().st_size})
    (OUT / "official.lock.json").write_text(json.dumps(official_spec, indent=2)+"\n")
    normalized = build_layer(official_spec, OUT / "official-normalized", rebuild=True)
    assert cells == normalized.cells == tuple((0, i) for i in range(12))
    assert len(project_cells(normalized.cells, 4)) == 3072
    assert len(project_cells(normalized.cells, 8)) == 786432
    locked_rejects = False
    try:
        build_layer({**official_spec, "snapshot": {"sha256": "0"*64}}, OUT / "official-bad-lock", rebuild=True)
    except ValueError as error:
        locked_rejects = "SHA-256" in str(error)
    assert locked_rejects
    results["official_dr1_cube_moc"] = {
        "sourceBytes": source.stat().st_size, "sourceSha256": digest(source),
        "headerOrder": header_order, "decodedNativeMaxOrder": raw_order,
        "nativeCanonicalCells": len(cells), "normalizedSha256": normalized.sha256,
        "normalizedMaxOrder": max(o for o, _ in normalized.cells),
        "order4Pixels": 3072, "order8Pixels": 786432,
        "geometryUnchanged": True, "wrongSnapshotShaRejected": locked_rejects,
        "assetsNativeOrder4PublicationGateSatisfied": raw_order >= 4,
    }

# Build a public-shaped synthetic package without using any private fixture.
mixed_moc = OUT / "mixed.moc.fits"
coarse_moc = OUT / "coarse.moc.fits"
write_moc_fits(mixed_moc, [(4, 30), (8, 9999)], max_order=8)
write_moc_fits(coarse_moc, [(4, 100)], max_order=4)
(OUT / "footprints.json").write_text('{"footprints":[]}\n')
(OUT / "provenance.json").write_text('{"schemaVersion":1,"synthetic":true}\n')
(OUT / "README.md").write_text("Synthetic SDK audit fixture; no survey inventory claim.\n")
layer_base = {"surveyId": "audit", "releaseId": "synthetic", "coverageRole": "image_extent", "dataOrigin": "simulated", "sourceTier": "user_file_derived", "modality": "imaging", "geometryPrecision": "estimated", "completeness": "unknown"}
package_spec = {
    "id": "synthetic-sdk-audit", "version": "3.0.0", "surveyId": "audit", "includeHealpixSidecars": True,
    "footprintPath": str(OUT / "footprints.json"), "provenancePath": str(OUT / "provenance.json"), "readmePath": str(OUT / "README.md"),
    "layers": [
        {**layer_base, "layerId": "mixed", "productId": "mixed", "product": "Mixed-order synthetic", "sourcePath": str(mixed_moc)},
        {**layer_base, "layerId": "coarse", "productId": "coarse", "product": "Coarse synthetic", "sourcePath": str(coarse_moc)},
    ],
}
first = OUT / "package-first.zip"
second = OUT / "package-second.zip"
packaged = build_resource_package(package_spec, first)
repeated = build_resource_package(package_spec, second)
assert packaged.archive_sha256 == repeated.archive_sha256
with zipfile.ZipFile(first) as archive:
    sidecar8 = json.loads(archive.read("healpix/order8.json"))
    assert [x["layerId"] for x in sidecar8["layers"]] == ["mixed"]
    assert sidecar8["surveyUnion"]["omittedLayers"][0]["layerId"] == "coarse"
    assert sidecar8["surveyUnion"]["completeness"] == "incomplete"
    assert len(sidecar8["layers"][0]["cells"]) == 257
tampered = OUT / "package-tampered.zip"
with zipfile.ZipFile(first) as source, zipfile.ZipFile(tampered, "w") as target:
    for member in source.infolist():
        data = source.read(member.filename)
        if member.filename == "healpix/order8.json":
            data = data.replace(b'9999', b'9998', 1)
        target.writestr(member, data)
tamper_rejected = False
try:
    validate_resource_package(tampered)
except PackageValidationError as error:
    tamper_rejected = "Supporting file mismatch: healpix/order8.json" == str(error)
assert tamper_rejected
results["resource_package"] = {"archiveSha256": packaged.archive_sha256, "entries": list(packaged.entries), "repeatBytesEqual": True, "order8OmittedCoarseLayer": True, "tamperedSidecarHashRejected": tamper_rejected}

production = ROOT.parent / "production" / "spherex-resource-package.zip"
if production.is_file():
    real = validate_resource_package(production)
    results["production_qr2_package"] = {"id": real.manifest["id"], "version": real.manifest["version"], "archiveSha256": real.archive_sha256, "entryCount": len(real.entries), "strictSdkValidation": "passed", "catalogTrustGate": "not tested by this call"}

(ROOT / "sdk-path-results.json").write_text(json.dumps(results, indent=2)+"\n")
print(json.dumps(results, indent=2))
