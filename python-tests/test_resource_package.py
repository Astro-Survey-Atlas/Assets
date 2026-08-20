from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
import warnings
import zipfile
from unittest.mock import patch
from pathlib import Path

from astro_survey_moc_core.resource_package import (
    PackageValidationError,
    build_resource_package,
    validate_resource_package,
)


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "fixtures/conformance/csst-resource-package-v3.json"


class ResourcePackageTests(unittest.TestCase):
    def test_v3_build_is_deterministic_and_strictly_valid(self) -> None:
        spec = json.loads(SPEC.read_text())
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.zip"
            second = Path(directory) / "second.zip"
            old_epoch = os.environ.get("SOURCE_DATE_EPOCH")
            os.environ["SOURCE_DATE_EPOCH"] = "1787184000"
            try:
                one = build_resource_package(spec, first, base_dir=ROOT)
                two = build_resource_package(spec, second, base_dir=ROOT)
            finally:
                if old_epoch is None:
                    os.environ.pop("SOURCE_DATE_EPOCH", None)
                else:
                    os.environ["SOURCE_DATE_EPOCH"] = old_epoch
            self.assertEqual(one.archive_sha256, two.archive_sha256)
            self.assertEqual(one.manifest["schemaVersion"], 3)
            self.assertEqual(one.manifest["version"], "3.0.0")
            self.assertEqual(one.manifest["layers"][0]["surveyId"], "csst")
            self.assertEqual(one.manifest["layers"][0]["coverageRole"], "image_extent")
            catalog = {"packages": [{"id": "public-csst-footprints", "version": "3.0.0", "sha256": one.archive_sha256}]}
            validate_resource_package(first, require_public_catalog=catalog)
            with self.assertRaises(PackageValidationError):
                validate_resource_package(first, require_public_catalog={"packages": []})

    def test_rejects_traversal_extra_files_duplicates_and_links(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = []
            traversal = root / "traversal.zip"
            with zipfile.ZipFile(traversal, "w") as archive:
                archive.writestr("../resource-package.json", b"{}")
            cases.append(traversal)

            extra = root / "extra.zip"
            with zipfile.ZipFile(extra, "w") as archive:
                archive.writestr("unexpected.txt", b"x")
            cases.append(extra)

            duplicate = root / "duplicate.zip"
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                with zipfile.ZipFile(duplicate, "w") as archive:
                    archive.writestr("README.md", b"one")
                    archive.writestr("README.md", b"two")
            cases.append(duplicate)

            link = root / "link.zip"
            with zipfile.ZipFile(link, "w") as archive:
                info = zipfile.ZipInfo("README.md")
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, b"target")
            cases.append(link)

            for case in cases:
                with self.subTest(case=case.name), self.assertRaises(PackageValidationError):
                    validate_resource_package(case)

    def test_rejects_size_limit_and_content_hash_tampering(self) -> None:
        spec = json.loads(SPEC.read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / "valid.zip"
            build_resource_package(spec, valid, base_dir=ROOT)
            with patch("astro_survey_moc_core.resource_package.MAX_ENTRY_BYTES", 16):
                with self.assertRaisesRegex(PackageValidationError, "uncompressed size"):
                    validate_resource_package(valid)

            tampered = root / "tampered.zip"
            with zipfile.ZipFile(valid) as source, zipfile.ZipFile(tampered, "w") as target:
                for info in source.infolist():
                    data = source.read(info.filename)
                    if info.filename.endswith(".moc.fits"):
                        data = data[:-1] + bytes([data[-1] ^ 1])
                    target.writestr(info, data)
            with self.assertRaisesRegex(PackageValidationError, "SHA-256 mismatch"):
                validate_resource_package(tampered)


if __name__ == "__main__":
    unittest.main()
