import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "acquire-iphas-dr2-native-images.py"
SPEC = importlib.util.spec_from_file_location("acquire_iphas_dr2_native_images", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def row(**overrides):
    value = {
        "filename": "r375643-1.fits.fz",
        "run": 375643,
        "ccd": 1,
        "in_dr2": "true",
        "band": "halpha",
        "ra": 40.68416590173798,
        "dec": 56.22358397750068,
        "ra_min": 40.34307304889804,
        "ra_max": 41.02527536218735,
        "dec_min": 56.12732988220369,
        "dec_max": 56.32031808508418,
    }
    value.update(overrides)
    return value


class IphasDr2CaptureTests(unittest.TestCase):
    def test_run_ccd_band_identity_and_source_rule_uri_are_retained(self):
        normalized, band = MODULE.normalized_record(row())
        self.assertEqual(band, "halpha")
        self.assertEqual(normalized["unitId"], "375643/1")
        self.assertEqual(normalized["bands"], ["HALPHA"])
        self.assertEqual(normalized["accessUris"][0]["uri"], "http://www.iphas.org/data/images/r375/r375643-1.fits.fz")
        self.assertTrue(normalized["sRegion"].startswith("POLYGON ICRS "))
        self.assertEqual(normalized["sourceMetadata"]["geometrySource"], MODULE.GEOMETRY_SOURCE)

    def test_ra_wrap_is_encoded_as_a_short_spherical_edge(self):
        normalized, _ = MODULE.normalized_record(row(ra=359.9, ra_min=359.5, ra_max=360.2))
        coordinates = [float(value) for value in normalized["sRegion"].split()[2:]]
        self.assertAlmostEqual(coordinates[0], 359.5)
        self.assertAlmostEqual(coordinates[2], 0.2)

    def test_non_dr2_rows_are_preserved_with_a_false_membership_flag(self):
        normalized, _ = MODULE.normalized_record(row(in_dr2="false"))
        self.assertFalse(normalized["sourceMetadata"]["inDr2"])

    def test_filename_and_run_ccd_must_agree(self):
        with self.assertRaisesRegex(ValueError, "run/CCD filename"):
            MODULE.normalized_record(row(run=375644))

    def test_invalid_bounds_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "four-corner"):
            MODULE.normalized_record(row(dec_max=91.0))


if __name__ == "__main__":
    unittest.main()
