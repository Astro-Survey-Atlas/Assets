import gzip
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "acquire-skyview-radio-native-maps.py"
SPEC = importlib.util.spec_from_file_location("acquire_skyview_radio_native_maps", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def fits_header(*, survey="nvss", frequency=None):
    header = MODULE.fits.Header()
    header["SIMPLE"] = True
    header["BITPIX"] = -32
    header["NAXIS"] = 2
    header["NAXIS1"] = 32
    header["NAXIS2"] = 24
    if survey == "wenss":
        header["CTYPE1"] = "RA---NCP"
        header["CTYPE2"] = "DEC--NCP"
        header["CRVAL1"] = 0.0
        header["CRVAL2"] = 30.0
        header["CRPIX1"] = 513.0
        header["CRPIX2"] = 193.0
        header["CDELT1"] = -0.00585937
        header["CDELT2"] = 0.00585937
        header["RADESYS"] = "FK4"
        header["EQUINOX"] = 1950.0
    else:
        header["CTYPE1"] = "RA---SIN"
        header["CTYPE2"] = "DEC--SIN"
        header["CRVAL1"] = 10.0
        header["CRVAL2"] = 30.0
        header["CRPIX1"] = 16.5
        header["CRPIX2"] = 12.5
        header["CDELT1"] = -0.1
        header["CDELT2"] = 0.1
        header["RADESYS"] = "FK5"
        header["EQUINOX"] = 2000.0
    if frequency is not None:
        header["CRVAL3"] = frequency
    return header.tostring(endcard=True, padding=True).encode("ascii")


def ranged_header(body):
    def ranged(url, start, end, timeout):
        stop = min(end + 1, len(body))
        part = body[start:stop]
        return part, {
            "totalBytes": len(body),
            "etag": '"fixture"',
            "lastModified": "Tue, 06 Oct 2026 00:00:00 GMT",
            "contentEncoding": "",
        }
    return ranged


class SkyViewRadioCaptureTests(unittest.TestCase):
    def test_inventory_paths_become_direct_whole_map_uris(self):
        xml = b"""<Survey><Images><SpellPrefix>/surveys/nvss/</SpellPrefix>
          <Image>I0000M04.fits.gz,I0000M04 0 0 J2000</Image>
        </Images></Survey>"""
        with patch.dict(MODULE.EXPECTED_ROWS, {"nvss": 1}):
            rows, prefix, decoded_sha = MODULE.parse_inventory(gzip.compress(xml), "nvss")

        self.assertEqual(prefix, "https://skyview.gsfc.nasa.gov/surveys/nvss/")
        self.assertEqual(decoded_sha, MODULE.sha256(xml))
        self.assertEqual(rows[0]["unitId"], "I0000M04.fits.gz")
        self.assertEqual(rows[0]["uri"], "https://skyview.gsfc.nasa.gov/surveys/nvss/I0000M04.fits.gz")

    def test_inventory_rejects_paths_outside_the_publisher_filename_rules(self):
        xml = b"""<Survey><Images><SpellPrefix>/surveys/nvss/</SpellPrefix>
          <Image>https://example.test/other.fits,other 0 0 J2000</Image>
        </Images></Survey>"""
        with patch.dict(MODULE.EXPECTED_ROWS, {"nvss": 1}):
            with self.assertRaisesRegex(ValueError, "unsafe or duplicate"):
                MODULE.parse_inventory(xml, "nvss")

    def test_compressed_header_reader_stops_at_the_padded_fits_header(self):
        raw_header = fits_header()
        compressed = gzip.compress(raw_header)
        calls = []

        def ranged(url, start, end, timeout):
            calls.append((start, end))
            return ranged_header(compressed)(url, start, end, timeout)

        header, receipt = MODULE.read_fits_header("https://example.test/map.fits.gz", 5, ranged)

        self.assertEqual(header, raw_header)
        self.assertEqual(receipt["headerBytes"], 2880)
        self.assertEqual(len(receipt["ranges"]), 1)
        self.assertEqual(calls, [(0, 511)])

    def test_actual_wenss_header_keeps_frame_and_spectral_conflict(self):
        header = MODULE.fits.Header.fromstring(fits_header(survey="wenss", frequency=609_585_595.238).decode("ascii"), sep="")
        result = MODULE.frame_from_header("wenss", header)

        self.assertEqual(result["nativeCoordinateFrame"], "FK4(B1950)")
        self.assertEqual(result["coordinateFrame"], "ICRS")
        self.assertEqual(len(result["frameEdgeIcrs"]), MODULE.EDGE_SEGMENTS * 4)
        self.assertTrue(result["spectralMetadataConflict"])
        self.assertEqual(result["rawFrequencyHz"], 609_585_595.238)

    def test_capture_keeps_whole_file_identity_when_header_geometry_fails(self):
        item = {
            "unitId": "I0000M04.fits.gz",
            "relativePath": "I0000M04.fits.gz",
            "fileName": "I0000M04.fits.gz",
            "uri": "https://skyview.gsfc.nasa.gov/surveys/nvss/I0000M04.fits.gz",
        }
        with patch.object(MODULE, "read_fits_header", side_effect=ValueError("HTTP 503 for metadata-only byte range")):
            row, result = MODULE.capture_map("nvss", item, timeout=5)

        self.assertIsNone(row["sRegion"])
        self.assertEqual(row["unitId"], item["unitId"])
        self.assertEqual(row["accessUris"][0]["uri"], item["uri"])
        self.assertEqual(result["receipt"]["headerStatus"], "failed")
        self.assertIn("HTTP 503", result["evidence"]["error"])

    def test_uncompressed_header_capture_maps_the_actual_image_frame(self):
        body = fits_header(survey="sumss")
        item = {
            "unitId": "Extragalactic/J0000M84.FITS",
            "relativePath": "Extragalactic/J0000M84.FITS",
            "fileName": "J0000M84.FITS",
            "uri": "https://skyview.gsfc.nasa.gov/surveys/sumss/mosaics/Extragalactic/J0000M84.FITS",
        }
        row, result = MODULE.capture_map("sumss", item, timeout=5, ranged=ranged_header(body))

        self.assertTrue(row["sRegion"].startswith("POLYGON ICRS "))
        self.assertEqual(row["accessUris"][0]["uri"], item["uri"])
        self.assertEqual(row["sourceMetadata"]["geometryPrecision"], "estimated")
        self.assertEqual(row["sourceMetadata"]["footprint"], row["sRegion"])
        self.assertEqual(result["receipt"]["geometryStatus"], "mapped")


if __name__ == "__main__":
    unittest.main()
