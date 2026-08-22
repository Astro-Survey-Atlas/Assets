from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from astro_survey_moc_core.contract import ContractError, normalize_spec
from astro_survey_moc_core.task_contract import TaskContractError, normalize_task
from astro_survey_moc_core.core import (
    build_layer,
    canonical_cells,
    project_cells,
    read_moc_fits,
    write_moc_fits,
)


ROOT = Path(__file__).resolve().parents[1]
CSST_MOC = ROOT / "artifacts/public-survey-footprints/csst/csst-w1-image-extent-order8.fits"


class ContractTests(unittest.TestCase):
    def test_layer_registry_ids_and_csst_classification(self) -> None:
        registry = json.loads((ROOT / "src/layers/layer-registry.json").read_text())
        self.assertEqual(registry["coordinateFrame"], "ICRS")
        self.assertEqual(registry["ordering"], "NESTED")
        ids = [layer["layerId"] for layer in registry["layers"]]
        self.assertEqual(len(ids), len(set(ids)))
        csst = next(layer for layer in registry["layers"] if layer["layerId"] == "csst-sim-w1-image-extent")
        self.assertEqual((csst["coverageRole"], csst["dataOrigin"], csst["sourceTier"], csst["maxOrder"]), ("image_extent", "simulated", "user_file_derived", 8))
        self.assertEqual(csst["artifactPath"], "artifacts/public-survey-footprints/csst/csst-w1-image-extent-order8.fits")
        self.assertEqual(csst["expectedSha256"], "caa6a5287efa0ba9abc406261d4e653730b062e49282ffc82549f7d2735dbf3c")
        for layer in registry["layers"]:
            if layer["status"] == "acquired":
                self.assertIn("recipePath", layer)
                self.assertIn("artifactPath", layer)
                self.assertRegex(layer["expectedSha256"], r"^[a-f0-9]{64}$")
            if layer["status"] == "awaiting_snapshot":
                self.assertIn("plannedMode", layer)
                self.assertIn("pendingReason", layer)

    def test_removed_evidence_role_is_rejected(self) -> None:
        with self.assertRaisesRegex(ContractError, "evidenceRole is removed"):
            normalize_spec({
                "layerId": "legacy-record",
                "mode": "nested-healpix",
                "evidenceRole": "image_extent",
                "dataOrigin": "simulated",
                "sourceTier": "user_file_derived",
                "maxOrder": 8,
            })

    def test_assets_task_input_uses_references_and_targets_data_warehouse(self) -> None:
        task = {
            "schemaVersion": 1,
            "taskId": "csst-sim-w2-coverage",
            "layer": {
                "layerId": "csst-sim-w2-image-extent",
                "surveyId": "csst",
                "releaseId": "csst-sim-w2-20250731",
                "product": "W2 simulated wide-field images",
                "mode": "fits-wcs",
                "coverageRole": "image_extent",
                "dataOrigin": "simulated",
                "sourceTier": "user_file_derived",
            },
            "connector": {"connectorId": "connector-csst-public", "kind": "oss", "configSha256": "a" * 64},
            "recipe": {"mode": "fits-wcs", "coordinateFrame": "ICRS", "ordering": "NESTED", "maxOrder": 10, "queryOrder": 8, "previewOrder": 4},
            "execution": {"executor": "data-warehouse", "timeoutSeconds": 3600, "maxBytes": 1024},
            "output": {"resultKind": "normalized-scan", "contractVersion": "1.0.0"},
        }
        self.assertEqual(normalize_task(task).task_id, "csst-sim-w2-coverage")
        with self.assertRaises(TaskContractError):
            normalize_task({**task, "connector": {**task["connector"], "password": "secret"}})
        with self.assertRaises(TaskContractError):
            normalize_task({**task, "execution": {**task["execution"], "executor": "atlas"}})

    def test_contract_rejects_wrong_frame_and_unjustified_precision(self) -> None:
        base = {
            "layerId": "bad-layer",
            "mode": "nested-healpix",
            "coverageRole": "image_extent",
            "dataOrigin": "observed",
            "sourceTier": "official_geometry",
        }
        with self.assertRaises(ContractError):
            normalize_spec({**base, "coordinateFrame": "GALACTIC"})
        with self.assertRaises(ContractError):
            normalize_spec({**base, "maxOrder": 11})
        reviewed = normalize_spec({**base, "maxOrder": 11, "recipe": {"precisionJustification": "Native official geometry resolves order 11."}})
        self.assertEqual(reviewed.max_order, 11)

    def test_mixed_order_normalization_and_projection(self) -> None:
        cells = [(3, 20), (3, 21), (3, 22), (3, 23), (4, 999), (4, 999)]
        self.assertEqual(canonical_cells(cells), ((2, 5), (4, 999)))
        self.assertEqual(project_cells([(2, 5)], 3), (20, 21, 22, 23))
        self.assertEqual(project_cells([(8, 16)], 4), (0,))

    def test_fits_output_and_shard_union_are_byte_deterministic(self) -> None:
        cells = [(8, 10), (8, 11), (8, 12), (8, 13), (7, 100)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            full = root / "full.fits"
            reverse = root / "reverse.fits"
            shard_a = root / "shard-a.fits"
            shard_b = root / "shard-b.fits"
            merged = root / "merged.fits"
            full_hash = write_moc_fits(full, cells, max_order=10)
            self.assertEqual(full_hash, write_moc_fits(reverse, reversed(cells), max_order=10))
            write_moc_fits(shard_a, cells[:2], max_order=10)
            write_moc_fits(shard_b, cells[2:], max_order=10)
            union = canonical_cells([*read_moc_fits(shard_b), *read_moc_fits(shard_a)], max_order=10)
            self.assertEqual(full_hash, write_moc_fits(merged, union, max_order=10))
            self.assertEqual(read_moc_fits(full), union)

    def test_nested_healpix_accepts_locked_nuniq_fits_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "native.fits"
            cells = [(4, 37), (5, 148)]
            digest = write_moc_fits(source, cells, max_order=5)
            spec = {
                "layerId": "nested-fits-snapshot",
                "mode": "nested-healpix",
                "input": source.name,
                "coverageRole": "image_extent",
                "dataOrigin": "observed",
                "sourceTier": "third_party_moc",
                "maxOrder": 5,
                "queryOrder": 8,
                "previewOrder": 4,
                "snapshot": {"sha256": digest, "sizeBytes": source.stat().st_size},
            }
            result = build_layer(spec, root / "output", base_dir=root, rebuild=True)
            self.assertEqual(read_moc_fits(result.moc_path), canonical_cells(cells, max_order=5))

    def test_locked_rebuild_produces_fixed_derivatives(self) -> None:
        fixture = ROOT / "fixtures/conformance"
        spec = json.loads((fixture / "nested-mixed.lock.json").read_text())
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            old_epoch = os.environ.get("SOURCE_DATE_EPOCH")
            os.environ["SOURCE_DATE_EPOCH"] = "1787184000"
            try:
                one = build_layer(spec, first, base_dir=fixture, rebuild=True)
                two = build_layer(spec, second, base_dir=fixture, rebuild=True)
            finally:
                if old_epoch is None:
                    os.environ.pop("SOURCE_DATE_EPOCH", None)
                else:
                    os.environ["SOURCE_DATE_EPOCH"] = old_epoch
            self.assertEqual(one.sha256, two.sha256)
            for name in ("query-order8.json", "preview-order4.json", "statistics.json", "provenance.json"):
                self.assertEqual((Path(first) / name).read_bytes(), (Path(second) / name).read_bytes())

    def test_provenance_redacts_url_credentials_query_and_fragment(self) -> None:
        fixture = ROOT / "fixtures/conformance"
        raw = json.loads((fixture / "nested-mixed.lock.json").read_text())
        raw["sourceUrl"] = "https://user:password@example.test:8443/data/file.fits?token=secret#fragment"
        raw["snapshot"]["sourceUrl"] = "https://example.test/data?signature=secret"
        raw["snapshot"]["credentials"] = "must-not-appear"
        with tempfile.TemporaryDirectory() as directory:
            result = build_layer(raw, directory, base_dir=fixture, rebuild=True)
            provenance = json.loads(result.provenance_path.read_text())
        self.assertEqual(provenance["sourceUrl"], "https://example.test:8443/data/file.fits")
        self.assertEqual(provenance["snapshot"]["sourceUrl"], "https://example.test/data")
        self.assertEqual(provenance["snapshot"]["credentials"], "[REDACTED]")
        self.assertEqual(set(provenance["outputs"]), {"moc", "query", "preview", "statistics"})

    def test_csst_bytes_and_derived_counts_remain_frozen(self) -> None:
        self.assertEqual(hashlib.sha256(CSST_MOC.read_bytes()).hexdigest(), "caa6a5287efa0ba9abc406261d4e653730b062e49282ffc82549f7d2735dbf3c")
        cells = read_moc_fits(CSST_MOC)
        self.assertEqual(len(project_cells(cells, 8)), 6763)
        self.assertEqual(len(project_cells(cells, 4)), 46)


if __name__ == "__main__":
    unittest.main()
