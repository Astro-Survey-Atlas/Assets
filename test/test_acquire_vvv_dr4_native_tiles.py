import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from acquire_vvv_dr4_native_tiles import parse_datalink_response, query_url, transform_s_region_j2000


class VvvAcquisitionTests(unittest.TestCase):
    def test_query_is_release_scoped_and_uses_keyset_cursor(self):
        first, first_query = query_url(None)
        next_page, next_query = query_url("ADP.2016-05-25T15:33:38.726")
        self.assertIn("releaseDescriptions/80", urllib.parse.parse_qs(urllib.parse.urlsplit(first).query)["QUERY"][0])
        self.assertIn("dataproduct_type = 'image'", first_query)
        self.assertNotIn("dp_id >", first_query)
        self.assertIn("dp_id > 'ADP.2016-05-25T15:33:38.726'", next_query)
        self.assertIn("ORDER BY dp_id", next_query)
        self.assertNotEqual(first, next_page)

    def test_obs_id_format_accepts_eso_timestamp_colons(self):
        import re
        self.assertRegex("ADP.2016-05-25T15:33:36.267", r"^ADP\.[A-Za-z0-9.:-]+$")

    def test_j2000_polygon_is_transformed_and_labeled_icrs(self):
        result = transform_s_region_j2000("POLYGON J2000 266.109381 -21.655805 266.927526 -20.383779 268.040839 -21.000602 267.228951 -22.278009")
        self.assertTrue(result.startswith("POLYGON ICRS "))
        self.assertEqual(len(result.split()), 10)
        self.assertNotEqual(result, "POLYGON ICRS 266.109381 -21.655805 266.927526 -20.383779 268.040839 -21.000602 267.228951 -22.278009")
        with self.assertRaises(ValueError):
            transform_s_region_j2000("CIRCLE ICRS 1 2 3")

    def test_datalink_uses_only_the_exact_this_file_not_related_products(self):
        dp_id = "ADP.2016-05-25T15:33:38.726"
        xml = f'''<?xml version="1.0"?>
        <VOTABLE xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE><TABLE>
          <FIELD name="access_url"/><FIELD name="semantics"/><FIELD name="eso_origfile"/><FIELD name="content_length"/>
          <DATA><TABLEDATA>
            <TR><TD>https://dataportal.eso.org/dataPortal/file/{dp_id}</TD><TD>#this</TD><TD>v20140402_00373_st_tl.fits.fz</TD><TD>223058880</TD></TR>
            <TR><TD>https://dataportal.eso.org/dataPortal/file/ADP.2016-05-25T15:33:38.727</TD><TD>#auxiliary</TD><TD>v20140402_00373_st_tl_conf.fits.fz</TD><TD>72671040</TD></TR>
          </TABLEDATA></DATA>
        </TABLE></RESOURCE></VOTABLE>'''.encode()
        result = parse_datalink_response(xml, dp_id)
        self.assertEqual(result["semantics"], "#this")
        self.assertEqual(result["eso_origfile"], "v20140402_00373_st_tl.fits.fz")
        with self.assertRaises(ValueError):
            parse_datalink_response(xml.replace(dp_id.encode(), b"ADP.2016-05-25T15:33:38.999"), dp_id)


if __name__ == "__main__":
    unittest.main()
