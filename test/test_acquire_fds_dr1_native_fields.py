import runpy
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-fds-dr1-native-fields.py"
MODULE = runpy.run_path(str(SCRIPT))


class FdsCaptureTests(unittest.TestCase):
    def test_parses_votable_status_and_rows(self):
        body = b'''<?xml version="1.0"?>
        <VOTABLE xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE><TABLE>
        <INFO name="QUERY_STATUS" value="OK"/><FIELD name="dp_id" datatype="char" arraysize="*"/>
        <DATA><TABLEDATA><TR><TD>ADP.2020-08-26T11:45:32.261</TD></TR></TABLEDATA></DATA>
        </TABLE></RESOURCE></VOTABLE>'''
        status, fields, rows = MODULE["parse_votable"](body)
        self.assertEqual(status, "OK")
        self.assertEqual(fields, ["dp_id"])
        self.assertEqual(rows, [{"dp_id": "ADP.2020-08-26T11:45:32.261"}])

    def test_rejects_tap_overflow_even_after_initial_ok(self):
        body = b'''<VOTABLE><RESOURCE><TABLE><INFO name="QUERY_STATUS" value="OK"/>
        <INFO name="QUERY_STATUS" value="OVERFLOW"/><FIELD name="dp_id"/>
        <DATA><TABLEDATA/></DATA></TABLE></RESOURCE></VOTABLE>'''
        with self.assertRaisesRegex(ValueError, "overflowed"):
            MODULE["parse_votable"](body)

    def test_parses_source_listed_science_and_ancillary_weight_links(self):
        dp_id = "ADP.2020-08-26T11:45:32.261"
        body = f'''<VOTABLE xmlns="http://www.ivoa.net/xml/VOTable/v1.3"><RESOURCE><TABLE>
        <FIELD name="access_url"/><FIELD name="semantics"/><FIELD name="content_length"/>
        <FIELD name="eso_origfile"/><FIELD name="eso_category"/><DATA><TABLEDATA>
        <TR><TD>https://dataportal.eso.org/dataPortal/file/{dp_id}</TD><TD>#this</TD><TD>260331840</TD><TD>FDS_F10_OCAM_g_SDSS_sci.fits.fz</TD><TD>SCIENCE.IMAGE</TD></TR>
        <TR><TD>https://dataportal.eso.org/dataPortal/file/ADP.2020-08-26T11:45:32.262</TD><TD>#auxiliary</TD><TD>1763835840</TD><TD>FDS_F10_OCAM_g_SDSS_wei.fits</TD><TD>ANCILLARY.WEIGHTMAP</TD></TR>
        </TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>'''.encode()
        image, weight = MODULE["parse_datalink"](body, dp_id, "FDS_F10_OCAM_g_SDSS_sci.fits.fz")
        self.assertEqual(image["semantics"], "#this")
        self.assertEqual(weight["semantics"], "#auxiliary")
        with self.assertRaisesRegex(ValueError, "#this"):
            MODULE["parse_datalink"](body, dp_id, "other-file.fits.fz")

    def test_transforms_declared_fk5_j2000_polygon_to_icrs(self):
        source_region = "POLYGON J2000 55.33476 -35.031069 53.910128 -35.0325 53.918524 -33.866384 55.322879 -33.865015"
        result = MODULE["transform_j2000_polygon"](source_region)
        self.assertTrue(result.startswith("POLYGON ICRS "))
        self.assertEqual(len(result.split()), len(source_region.split()))
        with self.assertRaisesRegex(ValueError, "POLYGON J2000"):
            MODULE["transform_j2000_polygon"]("POLYGON ICRS 1 2 3 4")


if __name__ == "__main__":
    unittest.main()
