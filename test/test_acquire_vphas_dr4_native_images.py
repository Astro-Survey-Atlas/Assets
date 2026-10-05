import runpy
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-vphas-dr4-native-images.py"
MODULE = runpy.run_path(str(SCRIPT))


class VphasCaptureTests(unittest.TestCase):
    def test_parses_complete_source_union_without_bridging_ccd_gaps(self):
        source = "UNION J2000 (POLYGON J2000 10 1 10.1 1 10.1 1.1 10 1.1 POLYGON J2000 11 1 11.1 1 11.1 1.1 11 1.1)"
        polygons = MODULE["parse_j2000_union"](source)
        self.assertEqual(len(polygons), 2)
        geometry, count = MODULE["transform_j2000_union"](source)
        self.assertEqual(count, 2)
        self.assertTrue(geometry.startswith("UNION ICRS (POLYGON "))
        self.assertEqual(geometry.count("POLYGON"), 2)
        self.assertNotIn("POLYGON ICRS 10", geometry)

    def test_rejects_non_j2000_or_more_than_32_components(self):
        with self.assertRaisesRegex(ValueError, "UNION J2000"):
            MODULE["parse_j2000_union"]("UNION ICRS POLYGON 1 1 2 1 2 2")
        component = "POLYGON J2000 1 1 2 1 2 2"
        with self.assertRaisesRegex(ValueError, "between 1 and 32"):
            MODULE["parse_j2000_union"]("UNION J2000 (" + " ".join([component] * 33) + ")")

    def test_pagination_continues_a_full_top_page_even_without_overflow(self):
        self.assertTrue(MODULE["should_continue_page"](5000, False))
        self.assertTrue(MODULE["should_continue_page"](5000, True))
        self.assertFalse(MODULE["should_continue_page"](534, False))
        with self.assertRaisesRegex(ValueError, "invalid row count"):
            MODULE["should_continue_page"](534, True)

    def test_datalink_requires_the_source_listed_whole_mef_image(self):
        dp_id = "ADP.2019-10-07T14:31:45.774"
        filename = "o20151119_00083.fits.fz"
        body = f'''<VOTABLE xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE><TABLE>
        <FIELD name="access_url"/><FIELD name="semantics"/><FIELD name="content_length"/>
        <FIELD name="eso_origfile"/><FIELD name="eso_category"/><DATA><TABLEDATA>
        <TR><TD>https://dataportal.eso.org/dataPortal/file/{dp_id}</TD><TD>#this</TD><TD>160683840</TD><TD>{filename}</TD><TD>SCIENCE.MEFIMAGE</TD></TR>
        </TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>'''.encode()
        image = MODULE["parse_datalink"](body, dp_id, filename)
        self.assertEqual(image["semantics"], "#this")
        self.assertEqual(image["eso_origfile"], filename)
        with self.assertRaisesRegex(ValueError, "#this"):
            MODULE["parse_datalink"](body, dp_id, "another-file.fits.fz")

    def test_normalized_row_keeps_native_file_identity_and_band(self):
        dp_id = "ADP.2019-10-07T14:31:45.774"
        filename = "o20151119_00083.fits.fz"
        data_link_url = f"https://archive.eso.org/datalink/links?ID=ivo://eso.org/ID?{dp_id}"
        image = {"access_url": f"https://dataportal.eso.org/dataPortal/file/{dp_id}", "eso_origfile": filename,
                 "eso_category": "SCIENCE.MEFIMAGE", "content_length": "160683840"}
        row = {"dp_id": dp_id, "filter": "NB_659", "release_description": MODULE["RELEASE_URL"],
               "obs_id": "1001970", "obs_creator_did": f"ivo://eso.org/origfile?{filename}",
               "access_url": data_link_url, "target_name": "vphas_0418", "s_region": "UNION J2000 (POLYGON J2000 1 1 2 1 2 2)"}
        normalized = MODULE["normalize_row"](row | {"sourceFileName": filename}, image, "a" * 64,
                                               "UNION ICRS (POLYGON 1 1 2 1 2 2)", 1)
        self.assertEqual(normalized["unitId"], dp_id)
        self.assertEqual(normalized["bands"], ["HALPHA"])
        self.assertEqual(normalized["accessUris"][0]["uri"], image["access_url"])
        self.assertEqual(normalized["sourceMetadata"]["ccdPolygonCount"], 1)


if __name__ == "__main__":
    unittest.main()
