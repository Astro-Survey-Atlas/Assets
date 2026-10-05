import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from astropy.io import fits


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "acquire-act-dr5-whole-maps.py"
SPEC = importlib.util.spec_from_file_location("acquire_act_dr5_whole_maps", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def map_header() -> fits.Header:
    header = fits.Header()
    header["SIMPLE"] = True
    header["BITPIX"] = -32
    header["NAXIS"] = 3
    header["NAXIS1"] = 43_200
    header["NAXIS2"] = 10_320
    header["NAXIS3"] = 3
    header["CTYPE1"] = "RA---CAR"
    header["CTYPE2"] = "DEC--CAR"
    header["CTYPE3"] = "STOKES"
    header["CRVAL1"] = 0.0
    header["CRVAL2"] = 0.0
    header["CRVAL3"] = 1.0
    header["CRPIX1"] = 21_601.0
    header["CRPIX2"] = 7_561.0
    header["CRPIX3"] = 1.0
    header["CDELT1"] = -360.0 / 43_200
    header["CDELT2"] = 86.0 / 10_320
    header["CDELT3"] = 1.0
    header["RADESYS"] = "ICRS"
    return header


class ActDr5CaptureTests(unittest.TestCase):
    def test_header_range_stops_at_end_card_without_reading_pixels(self):
        header_bytes = map_header().tostring(endcard=True, padding=True).encode("ascii")
        self.assertEqual(len(header_bytes), MODULE.HEADER_BLOCK_BYTES)
        calls = []

        def head(url, timeout):
            return 200, url, {"Content-Length": "5368709120", "Accept-Ranges": "bytes"}

        def ranged(url, start, end, timeout):
            calls.append((start, end))
            body = header_bytes[start : end + 1]
            total = 5368709120
            return body, url, 206, {"Content-Range": f"bytes {start}-{end}/{total}"}

        body, receipt = MODULE.read_header(MODULE.MAP_ROOT + MODULE.MAP_FILES[0][2], 1, head=head, ranged=ranged)
        self.assertEqual(body, header_bytes)
        self.assertEqual(receipt["fileSizeBytes"], 5368709120)
        self.assertEqual(receipt["headerBytes"], MODULE.HEADER_BLOCK_BYTES)
        self.assertEqual(calls, [(0, MODULE.HEADER_BLOCK_BYTES - 1)])

    def test_car_frame_is_split_across_wrap_and_records_estimated_bounds(self):
        region, declination_bounds = MODULE.footprint_from_header(map_header(), segment_count=36)
        self.assertTrue(region.startswith("UNION ICRS (POLYGON ICRS "))
        self.assertEqual(region.count("POLYGON ICRS"), 36)
        self.assertLess(len(region), 131_072)
        self.assertTrue(np.allclose(declination_bounds, [-63.0041667, 22.9958333], atol=0.01))

    def test_capture_locks_six_files_and_only_header_metadata(self):
        header_bytes = map_header().tostring(endcard=True, padding=True).encode("ascii")
        script = "\n".join(MODULE.MAP_ROOT + filename for _, _, filename in MODULE.MAP_FILES).encode()
        calls = []

        def get(url, timeout):
            body = b"<html>ACT DR5</html>" if url == MODULE.GET_URL else script
            return body, url, 200, {"Content-Length": str(len(body))}

        def head(url, timeout):
            return 200, url, {"Content-Length": "5368709120", "Accept-Ranges": "bytes"}

        def ranged(url, start, end, timeout):
            calls.append((url, start, end))
            body = header_bytes[start : end + 1]
            return body, url, 206, {"Content-Range": f"bytes {start}-{end}/5368709120"}

        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "capture"
            manifest = MODULE.capture(output, 1, get=get, head=head, ranged=ranged)
            self.assertEqual(manifest["rowCount"], 6)
            self.assertFalse(manifest["inventoryComplete"])
            self.assertEqual(len(manifest["metadataDocuments"]), 8)
            self.assertEqual(len(calls), 6)
            self.assertTrue(all(call[1:] == (0, MODULE.HEADER_BLOCK_BYTES - 1) for call in calls))
            with gzip.open(output / manifest["rowFiles"][0]["ref"], "rt", encoding="utf-8") as rows_file:
                rows = [json.loads(line) for line in rows_file]
            self.assertEqual(len(rows), 6)
            self.assertEqual({row["sourceMetadata"]["frequencyGHz"] for row in rows}, {90, 150, 220})
            self.assertEqual({row["sourceMetadata"]["timeSelection"] for row in rows}, {"night", "daynight"})
            self.assertTrue(all(row["sourceMetadata"]["headerBytes"] == MODULE.HEADER_BLOCK_BYTES for row in rows))
            self.assertTrue(all(row["accessUris"][0]["uri"].endswith(row["filename"]) for row in rows))


if __name__ == "__main__":
    unittest.main()
