import runpy
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-allwise-w3-w4-atlas.py"
MODULE = runpy.run_path(str(SCRIPT))


def sample_row():
    return {
        "coadd_id": "0000m016_ac51", "band": "3",
        "ra1": "0.783066597436", "dec1": "-2.296740180822",
        "ra2": "359.217315689685", "dec2": "-2.296740318771",
        "ra3": "359.217880601775", "dec3": "-0.732247395259",
        "ra4": "0.782501409442", "dec4": "-0.732247257410",
        "crval1": "0.0", "crval2": "-1.5", "crpix1": "2048.0", "crpix2": "2048.0",
        "naxis1": "4095", "naxis2": "4095", "ctype1": "RA---SIN", "ctype2": "DEC--SIN",
        "cdelt1": "-0.0003819444", "cdelt2": "0.0003819444", "crota2": "0.0",
        "equinox": "2000.0", "cntr": "123456",
    }


class AllwiseAtlasCaptureTests(unittest.TestCase):
    def test_normalizes_real_coadd_and_retains_whole_image_path(self):
        row = MODULE["normalize_row"](sample_row())
        self.assertEqual(row["unitId"], "0000m016_ac51")
        self.assertEqual(row["bands"], ["W3"])
        self.assertEqual(row["filename"], "0000m016_ac51-w3-int-3.fits")
        self.assertEqual(
            row["accessUris"][0]["uri"],
            "https://irsa.ipac.caltech.edu/ibe/data/wise/allwise/p3am_cdd/00/0000/0000m016_ac51/0000m016_ac51-w3-int-3.fits",
        )
        self.assertTrue(row["sRegion"].startswith("POLYGON ICRS "))
        self.assertEqual(row["sourceMetadata"]["sourceCornersJ2000"][1][0], 359.217315689685)
        self.assertEqual(row["sourceMetadata"]["validPixelMasksChecked"], False)

    def test_preserves_keyset_suffix_and_advances_by_band_within_coadd(self):
        first = MODULE["page_query"]()
        next_page = MODULE["page_query"]("0384p651_ac51", 3)
        self.assertIn("ORDER BY coadd_id, band", first)
        self.assertIn("coadd_id = '0384p651_ac51' AND band > 3", next_page)
        self.assertIn("coadd_id > '0384p651_ac51'", next_page)

    def test_rejects_wrong_band_frame_or_missing_corner(self):
        invalid_band = sample_row() | {"band": "2"}
        with self.assertRaisesRegex(ValueError, "outside W3/W4"):
            MODULE["normalize_row"](invalid_band)
        invalid_frame = sample_row() | {"equinox": "1950"}
        with self.assertRaisesRegex(ValueError, "WCS differs"):
            MODULE["normalize_row"](invalid_frame)
        invalid_corner = sample_row() | {"dec4": "91"}
        with self.assertRaisesRegex(ValueError, "outside the celestial sphere"):
            MODULE["normalize_row"](invalid_corner)


if __name__ == "__main__":
    unittest.main()
