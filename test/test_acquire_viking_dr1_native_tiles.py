import runpy
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-viking-dr1-native-tiles.py"
MODULE = runpy.run_path(str(SCRIPT))


class VikingCaptureTests(unittest.TestCase):
    def test_parses_complete_tap_status_without_overflow(self):
        body = b'''<VOTABLE><RESOURCE><TABLE><INFO name="QUERY_STATUS" value="OK"/><FIELD name="dp_id"/>
        <DATA><TABLEDATA><TR><TD>ADP.1</TD></TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>'''
        rows, overflow = MODULE["parse_votable"](body)
        self.assertFalse(overflow)
        self.assertEqual(rows, [{"dp_id": "ADP.1"}])

    def test_uses_only_the_source_listed_whole_tile_science_file(self):
        dp_id = "ADP.2013-06-13T08:59:31.740"
        filename = "viking_er1_00h05-031d26_tile_j_deepimage_1407292.fits.fz"
        image = {
            "access_url": f"https://dataportal.eso.org/dataPortal/file/{dp_id}",
            "eso_origfile": filename,
            "eso_category": "SCIENCE.IMAGE",
            "content_length": "114923520",
        }
        row = {
            "dp_id": dp_id,
            "target_name": "vikingJYZ_sgp_m31_1_1_19",
            "filter": "J",
            "obs_id": "12345",
            "obs_creator_did": f"ivo://eso.org/origfile?{filename}",
            "s_region": "POLYGON J2000 0.447047 -30.844254 2.177714 -30.840928 2.190930 -32.053821 0.437707 -32.057173",
            "access_url": f"https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?{dp_id}",
            "release_description": MODULE["RELEASE_URL"],
            "dataproduct_subtype": "",
        }
        normalized = MODULE["normalize_row"](row, image, row["access_url"], "a" * 64)
        self.assertEqual(normalized["unitId"], "1407292")
        self.assertEqual(normalized["bands"], ["J"])
        self.assertEqual(normalized["accessUris"][0]["uri"], image["access_url"])
        self.assertTrue(normalized["sRegion"].startswith("POLYGON ICRS "))
        self.assertEqual(normalized["sourceMetadata"]["officialReleaseTileCount"], 151)
        self.assertEqual(normalized["sourceMetadata"]["observedTileCount"], 110)

    def test_rejects_non_tile_or_non_j_files(self):
        with self.assertRaisesRegex(ValueError, "selected J-band Tile image"):
            MODULE["normalize_row"](
                {"dp_id": "ADP.1", "filter": "J", "release_description": MODULE["RELEASE_URL"], "dataproduct_subtype": "",
                 "obs_creator_did": "ivo://eso.org/origfile?viking_er1_00h05-031d26_off0_j_image_1.fits.fz"},
                {"eso_origfile": "viking_er1_00h05-031d26_off0_j_image_1.fits.fz"},
                "https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?ADP.1", "a" * 64)


if __name__ == "__main__":
    unittest.main()
