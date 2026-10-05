import runpy
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-kids-dr5-native-tiles.py"
MODULE = runpy.run_path(str(SCRIPT))


class KidsCaptureTests(unittest.TestCase):
    def test_reads_terminal_overflow_status_for_keyset_pages(self):
        body = b'''<VOTABLE><RESOURCE><TABLE><INFO name="QUERY_STATUS" value="OK"/>
        <INFO name="QUERY_STATUS" value="OVERFLOW"/><FIELD name="dp_id"/>
        <DATA><TABLEDATA><TR><TD>ADP.1</TD></TR></TABLEDATA></DATA>
        </TABLE></RESOURCE></VOTABLE>'''
        rows, overflow = MODULE["parse_votable"](body)
        self.assertTrue(overflow)
        self.assertEqual(rows, [{"dp_id": "ADP.1"}])

    def test_continues_full_top_limited_pages_even_without_overflow_status(self):
        self.assertTrue(MODULE["should_continue_tap_pages"](1000, False))
        self.assertTrue(MODULE["should_continue_tap_pages"](1000, True))
        self.assertFalse(MODULE["should_continue_tap_pages"](388, False))
        with self.assertRaisesRegex(ValueError, "invalid row count or overflow status"):
            MODULE["should_continue_tap_pages"](388, True)

    def test_requires_full_unique_official_astro_wise_roster(self):
        lines = []
        for band in ("u", "g", "r", "i", "i2"):
            for tile in range(1, 1348):
                lines.append(f"wget http://ds.astro.rug.astro-wise.org:8000/KiDS_DR5.0_{tile}_-0.5_{band}_sci.fits")
        by_name, counts = MODULE["parse_roster"](("\n".join(lines) + "\n").encode())
        self.assertEqual(len(by_name), 6735)
        self.assertEqual(counts, {"u": 1347, "g": 1347, "r": 1347, "i": 1347, "i2": 1347})
        with self.assertRaisesRegex(ValueError, "Unexpected KiDS Astro-WISE file URI"):
            MODULE["parse_roster"](b"wget https://ds.astro.rug.astro-wise.org:8000/KiDS_DR5.0_1_-0.5_g_sci.fits\n")

    def test_preserves_both_i_epochs_as_individual_source_files(self):
        dp_id = "ADP.2024-12-13T18:08:20.831"
        filename = "KiDS_DR5.0_195.5_-3.5_i2_sci.fits"
        image = {
            "access_url": f"https://dataportal.eso.org/dataPortal/file/{dp_id}",
            "eso_origfile": filename,
            "eso_category": "SCIENCE.IMAGE",
            "content_length": "1500719040",
        }
        row = {
            "target_name": "KIDS_195.5_-3.5",
            "dp_id": dp_id,
            "filter": "i_SDSS",
            "obs_id": "1217602",
            "obs_creator_did": f"ivo://eso.org/origfile?{filename}",
            "s_region": "POLYGON J2000 196.060274 -4.026379 195.018337 -4.026374 195.018954 -2.913401 196.059666 -2.913405",
            "access_url": f"https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?{dp_id}",
            "release_description": MODULE["RELEASE_URL"],
        }
        normalized = MODULE["normalize_row"](row, image, "a" * 64, f"http://ds.astro.rug.astro-wise.org:8000/{filename}")
        self.assertEqual(normalized["bands"], ["I"])
        self.assertEqual(normalized["sourceMetadata"]["epoch"], "i2")
        self.assertEqual([item["sourceId"] for item in normalized["accessUris"]], ["eso-datalink", "kids-astro-wise-wget-list"])
        self.assertEqual(normalized["sourceMetadata"]["astroWiseRosterMatchedBy"], "exact-filename")
        self.assertTrue(normalized["sRegion"].startswith("POLYGON ICRS "))


if __name__ == "__main__":
    unittest.main()
