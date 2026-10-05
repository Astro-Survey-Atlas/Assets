import importlib.util
import base64
from pathlib import Path
import unittest

import numpy as np
from astropy.io import fits


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "acquire-panstarrs-dr1-skycells.py"
SPEC = importlib.util.spec_from_file_location("acquire_panstarrs_dr1_skycells", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


ZONE_23 = {
    "zone": 23,
    "projectionStart": 1322,
    "projectionCount": 90,
    "decCenter": 2.0,
    "decMin": 1.3877787807814457e-17,
    "decMax": 3.998086931795508,
    "xCell": 6240,
    "yCell": 6243,
    "crpix1": 240.0,
    "crpix2": 242.0,
}


class PanstarrsDr1CaptureTests(unittest.TestCase):
    def test_zone_23_enumerates_exact_projection_and_subcell_identities(self):
        cells = MODULE.skycell_ids(ZONE_23)
        self.assertEqual(len(cells), 9000)
        self.assertEqual(cells[:3], ["1322.000", "1322.001", "1322.002"])
        self.assertEqual(cells[99], "1322.099")
        self.assertEqual(cells[100], "1323.000")
        self.assertEqual(cells[-1], "1411.099")

    def test_listing_parser_keeps_real_stack_path_and_accepts_empty_cells(self):
        header = b"projcell subcell ra dec filter mjd type filename shortname badflag\n"
        filename = "/rings.v3.skycell/1405/053/rings.v3.skycell.1405.053.stk.g.unconv.fits"
        row = f"1405 53 332.6004516572 2.1998090576 g 0.0 stack {filename} {filename.rsplit('/', 1)[1]} 0\n".encode()
        parsed = MODULE.parse_listing(header + row, "1405.053")
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["filename"], filename)
        self.assertEqual(parsed[0]["badflag"], 0)
        negative_ra = row.replace(b"332.6004516572", b"-0.1999643937")
        self.assertAlmostEqual(MODULE.parse_listing(header + negative_ra, "1405.053")[0]["ra"], 359.8000356063)
        self.assertEqual(MODULE.parse_listing(header, "1411.999"), [])
        with self.assertRaisesRegex(ValueError, "outside requested"):
            MODULE.parse_listing(header + row, "1405.054")

    def test_query_checkpoint_requires_matching_url_body_hash_and_row_count(self):
        skycell = "1405.053"
        body = b"projcell subcell ra dec filter mjd type filename shortname badflag\n"
        receipt = {
            "skycell": skycell,
            "url": MODULE.listing_url(skycell),
            "status": 200,
            "rows": 0,
            "responseSha256": MODULE.sha256(body),
            "bodyBase64": base64.b64encode(body).decode("ascii"),
        }
        self.assertTrue(MODULE.validate_query_receipt(receipt, skycell))
        self.assertFalse(MODULE.validate_query_receipt({**receipt, "url": MODULE.listing_url("1405.054")}, skycell))
        self.assertFalse(MODULE.validate_query_receipt({**receipt, "responseSha256": "0" * 64}, skycell))
        self.assertFalse(MODULE.validate_query_receipt({**receipt, "rows": 1}, skycell))

    def test_grid_wcs_generates_a_spherical_icrs_polygon(self):
        region, vertices = MODULE.frame_polygon(ZONE_23, 1405, 53)
        self.assertTrue(region.startswith("POLYGON ICRS "))
        self.assertEqual(len(vertices), 4)
        self.assertTrue(all(0 <= ra < 360 and -90 <= dec <= 90 for ra, dec in vertices))
        self.assertTrue(np.allclose(vertices[0], [332.81706, 1.983023], atol=0.001))

    def test_fits_extension_header_parser_stops_before_any_pixel_data(self):
        primary = fits.Header()
        primary["SIMPLE"] = True
        primary["BITPIX"] = 8
        primary["NAXIS"] = 0
        extension = fits.Header()
        extension["XTENSION"] = "BINTABLE"
        extension["BITPIX"] = 8
        extension["NAXIS"] = 2
        extension["NAXIS1"] = 80
        extension["NAXIS2"] = 1
        extension["SKYCELL"] = "skycell.1405.053"
        extension["ZNAXIS1"] = 6240
        extension["ZNAXIS2"] = 6243
        body = primary.tostring(endcard=True, padding=True).encode("ascii") + extension.tostring(endcard=True, padding=True).encode("ascii")
        parsed = MODULE.fits_extension_header(body)
        self.assertEqual(parsed["SKYCELL"], "skycell.1405.053")
        self.assertEqual(parsed["ZNAXIS1"], 6240)


if __name__ == "__main__":
    unittest.main()
