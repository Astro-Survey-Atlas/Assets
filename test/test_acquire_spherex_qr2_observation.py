import gzip
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

from astropy.io import fits


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-spherex-qr2-observation.py"
SPEC = importlib.util.spec_from_file_location("acquire_spherex_qr2_observation", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fits_header_bytes(header):
    return header.tostring(endcard=True, padding=True).encode("ascii")


def sample_headers(detector):
    primary = fits.Header()
    primary["SIMPLE"] = True
    primary["BITPIX"] = 8
    primary["NAXIS"] = 0
    primary["EXTEND"] = True

    image = fits.Header()
    image["XTENSION"] = "IMAGE"
    image["BITPIX"] = -32
    image["NAXIS"] = 2
    image["NAXIS1"] = 2040
    image["NAXIS2"] = 2040
    image["PCOUNT"] = 0
    image["GCOUNT"] = 1
    image["DETECTOR"] = detector
    image["OBSID"] = MODULE.OBSERVATION_ID
    image["RADESYS"] = "ICRS"
    image["CTYPE1"] = "RA---TAN-SIP"
    image["CTYPE2"] = "DEC--TAN-SIP"
    image["CRPIX1"] = 1020.5
    image["CRPIX2"] = 1020.5
    image["CRVAL1"] = 164.705590379
    image["CRVAL2"] = 29.1388961408
    image["CDELT1"] = 1.0
    image["CDELT2"] = 1.0
    image["PC1_1"] = 0.00154389700165
    image["PC1_2"] = -0.000720527610548
    image["PC2_1"] = -0.000720941111231
    image["PC2_2"] = -0.00154621993133
    image["A_ORDER"] = 3
    image["A_0_0"] = 0.130603836949
    image["B_ORDER"] = 3
    return fits_header_bytes(primary) + fits_header_bytes(image)


class FakeS3:
    def __init__(self):
        self.range_requests = []

    def __call__(self, url, headers, timeout):
        parsed = urlsplit(url)
        if "Range" in headers:
            start, end = [int(value) for value in headers["Range"].removeprefix("bytes=").split("-")]
            self.range_requests.append((parsed.path.lstrip("/"), start, end))
            self.assert_header_only(start, end)
            detector = int(parsed.path.split("/")[-2])
            body = sample_headers(detector)[start:end + 1]
            if len(body) != end - start + 1:
                raise AssertionError("collector requested beyond the available metadata header")
            return body, url, 206, {"Content-Range": f"bytes {start}-{end}/71634240"}

        prefix = parse_qs(parsed.query)["prefix"][0]
        detector_match = re.search(r"/(\d)/level2_2025W17_4B_0001_1D\d_spx_", prefix)
        if not detector_match:
            raise AssertionError(f"unexpected listing prefix: {prefix}")
        detector = int(detector_match.group(1))
        root = ET.Element("ListBucketResult", xmlns="http://s3.amazonaws.com/doc/2006-03-01/")
        ET.SubElement(root, "Name").text = "nasa-irsa-spherex"
        ET.SubElement(root, "IsTruncated").text = "false"
        contents = ET.SubElement(root, "Contents")
        filename = f"level2_{MODULE.OBSERVATION_SELECTOR}D{detector}_spx_{MODULE.PROCESSING_VERSION}.fits"
        ET.SubElement(contents, "Key").text = prefix
        ET.SubElement(contents, "Size").text = "71634240"
        ET.SubElement(contents, "ETag").text = '"ee30fd35a2ab3d38e52d06acc1128cca"'
        ET.SubElement(contents, "LastModified").text = "2026-04-02T02:08:18.000Z"
        return ET.tostring(root), url, 200, {}

    @staticmethod
    def assert_header_only(start, end):
        if start not in (0, MODULE.BLOCK_SIZE) or end != start + MODULE.BLOCK_SIZE - 1:
            raise AssertionError("collector must request only aligned header blocks")


class SpherexAcquireTest(unittest.TestCase):
    def test_capture_locks_one_complete_observation_and_only_fits_headers(self):
        fake = FakeS3()
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "capture"
            result = MODULE.acquire(output, timeout=17, fetch=fake)
            manifest = result["manifest"]
            rows_path = output / manifest["rowFiles"][0]["ref"]
            rows = [json.loads(line) for line in gzip.decompress(rows_path.read_bytes()).splitlines()]

            self.assertEqual(result["rowCount"], 5)
            self.assertEqual(MODULE.SOURCE_ID, "spherex-qr2-2025w17-4b-0001-1")
            self.assertEqual(manifest["adapter"], "spherex-qr2-s3-observation")
            self.assertTrue(manifest["queryPagesComplete"])
            self.assertFalse(manifest["inventoryComplete"])
            self.assertEqual(manifest["scope"]["detectors"], [2, 3, 4, 5, 6])
            self.assertEqual(len(manifest["sourcePagination"]["pages"]), 5)
            self.assertEqual(len(manifest["metadataDocuments"]), 10)
            self.assertEqual(len(fake.range_requests), 10)
            self.assertTrue(all(start <= 2880 and end < 5760 for _, start, end in fake.range_requests))
            self.assertEqual({row["sourceMetadata"]["detector"] for row in rows}, {2, 3, 4, 5, 6})
            self.assertEqual({row["unitId"] for row in rows}, {f"{MODULE.OBSERVATION_ID}/D{detector}" for detector in MODULE.DETECTORS})
            self.assertTrue(all(len(row["sourceMetadata"]["frameEdgeIcrs"]) == 32 for row in rows))
            self.assertTrue(all(row["sourceMetadata"]["coordinateFrame"] == "ICRS" for row in rows))
            self.assertTrue(all(len(row["accessUris"]) == 2 for row in rows))

    def test_truncated_listing_without_a_continuation_token_is_rejected(self):
        body = b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>nasa-irsa-spherex</Name><IsTruncated>true</IsTruncated></ListBucketResult>'
        with self.assertRaisesRegex(ValueError, "without a continuation token"):
            MODULE.parse_listing(body)


if __name__ == "__main__":
    unittest.main()
