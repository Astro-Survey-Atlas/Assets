import runpy
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-cfhtls-wide-t0007.py"
MODULE = runpy.run_path(str(SCRIPT))


def sample_row():
    return {
        "collection": "CFHTTERAPIX",
        "observationid": "CFHTLS_W_022539-041200",
        "obsid": "00000000-0000-0000-0000-000000000001",
        "productid": "CFHTLS_W_g_022539-041200_T0007_MEDIAN",
        "provenance_version": "T0007",
        "energy_bandpassname": "g.MP9401",
        "position_bounds": "polygon 36.91524084390912 -3.699893292981912 36.91588330980907 -4.699786330549173 35.91261669019093 -4.699786330549173 35.91325915609087 -3.699893292981912",
        "position_dimension_naxis1": "19354",
        "position_dimension_naxis2": "19354",
        "artifactid": "00000000-0000-0000-0000-000000000002",
        "uri": "cadc:CFHTTERAPIX/CFHTLS_W_g_022539-041200_T0007_MEDIAN.fits",
        "producttype": "science",
        "contenttype": "application/fits",
        "contentlength": "1498320000",
        "contentchecksum": "md5:5bbeb87faa312d42428f07facc9112ca",
        "position_coordsys": "ICRS",
        "position_equinox": "2000.0",
    }


class CfhtlsCaptureTests(unittest.TestCase):
    def test_normalizes_a_real_median_field_with_direct_cadc_file_uri(self):
        row = MODULE["normalize_row"](sample_row())
        self.assertEqual(row["unitId"], "CFHTLS_W_022539-041200")
        self.assertEqual(row["bands"], ["G"])
        self.assertEqual(row["filename"], "CFHTLS_W_g_022539-041200_T0007_MEDIAN.fits")
        self.assertEqual(
            row["accessUris"][0]["uri"],
            "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/data/pub/CFHTTERAPIX/CFHTLS_W_g_022539-041200_T0007_MEDIAN.fits",
        )
        self.assertEqual(row["sourceMetadata"]["contentChecksum"], "md5:5bbeb87faa312d42428f07facc9112ca")
        self.assertTrue(row["sRegion"].startswith("POLYGON ICRS "))
        self.assertFalse(row["sourceMetadata"]["validPixelMasksChecked"])

    def test_retains_both_i_filter_epochs_as_one_photometric_band(self):
        row = sample_row() | {
            "productid": "CFHTLS_W_i_022539-041200_T0007_MEDIAN",
            "energy_bandpassname": "i.MP9702",
            "uri": "cadc:CFHTTERAPIX/CFHTLS_W_i_022539-041200_T0007_MEDIAN.fits",
        }
        self.assertEqual(MODULE["normalize_row"](row)["bands"], ["I"])

    def test_rejects_wrong_frame_filter_or_mismatched_artifact_identity(self):
        with self.assertRaisesRegex(ValueError, "corroborated as ICRS"):
            MODULE["normalize_row"](sample_row() | {"position_coordsys": "FK5"})
        with self.assertRaisesRegex(ValueError, "unsupported band"):
            MODULE["normalize_row"](sample_row() | {"energy_bandpassname": "gri"})
        with self.assertRaisesRegex(ValueError, "productID does not match"):
            MODULE["normalize_row"](sample_row() | {"uri": "cadc:CFHTTERAPIX/another_T0007_MEDIAN.fits"})

    def test_parses_tap_status_and_rejects_overflow(self):
        valid = b"""<VOTABLE><RESOURCE><INFO name='QUERY_STATUS' value='OK'/><TABLE><FIELD name='row_count'/><DATA><TABLEDATA><TR><TD>855</TD></TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>"""
        fields, rows, overflow = MODULE["parse_votable"](valid)
        self.assertEqual(fields, ["row_count"])
        self.assertEqual(rows, [{"row_count": "855"}])
        self.assertFalse(overflow)
        invalid = valid.replace(b"value='OK'/>", b"value='OK'/><INFO name='QUERY_STATUS' value='OVERFLOW'/>")
        with self.assertRaisesRegex(ValueError, "overflowed"):
            MODULE["parse_votable"](invalid)

    def test_normalizes_denominator_keys_for_the_managed_import_contract(self):
        self.assertEqual(
            MODULE["count_record"]([{"row_count": "855", "field_count": "171"}]),
            {"rowCount": 855, "fieldCount": 171},
        )


if __name__ == "__main__":
    unittest.main()
