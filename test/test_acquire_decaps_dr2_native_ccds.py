import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-decaps-dr2-native-ccds.py"
SPEC = importlib.util.spec_from_file_location("acquire_decaps_dr2_native_ccds", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SCHEMA_FIELDS = ["column_name", "description", "unit", "ucd", "utype"]


def ccd_row(filename, extension, filter_name, ra_offset=0):
    publisher = f"ivo://datalab.noirlab/decaps_dr2/{filename}#{extension}"
    access = f"https://datalab.noirlab.edu/svc/cutout?col=decaps_dr2&siaRef={filename}&extn={extension}"
    row = {
        "obs_collection": "DECaPS DR2", "propid": "2016B-0279", "obs_id": "decaps_dr2",
        "obs_pub_did": publisher, "access_url": access, "access_format": "image/fits", "access_estsize": "311073",
        "filter": filter_name, "im_naxis1": "2046", "im_naxis2": "4094", "wcsaxes1": "RA---TPV",
        "wcsaxes2": "DEC--TPV", "date_obs": "2016-03-14T00:01:47.483177", "mjd_obs": "57461.00124402",
        "expnum": "525811", "exptime": "30", "fileref": filename, "proctype": "Stack", "prodtype": "image",
        "obstype": "object", "telescope": "CTIO Blanco 4m", "instrument_name": "DECam", "object": "DECaPS DR2",
    }
    for index, (ra, dec) in enumerate([
        (99.489 + ra_offset, -26.0936), (99.8221 + ra_offset, -25.9442),
        (99.8219 + ra_offset, -26.0936), (99.4898 + ra_offset, -26.0933),
    ], 1):
        row[f"ra{index}"] = str(ra)
        row[f"dec{index}"] = str(dec)
    return row


def votable(fields, rows, statuses=("OK",)):
    field_xml = "".join(f'<FIELD name="{name}" datatype="char" arraysize="*"/>' for name in fields)
    row_xml = "".join("<TR>" + "".join(f"<TD>{escape(str(row.get(name, '')))}</TD>" for name in fields) + "</TR>" for row in rows)
    info = "".join(f'<INFO name="QUERY_STATUS" value="{status}"/>' for status in statuses)
    return (f'<?xml version="1.0"?><VOTABLE xmlns="{MODULE.VOTABLE_NS}"><RESOURCE>{info}'
            f"<TABLE>{field_xml}<DATA><TABLEDATA>{row_xml}</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>").encode()


class DecapsAcquireTest(unittest.TestCase):
    def test_row_preserves_ccd_extension_icrs_corners_and_full_image_service_url(self):
        filename = "c4d_180520_103732_ooi_r_decaps2.fits.fz"
        row = MODULE.normalize_row(ccd_row(filename, 51, "r"))
        self.assertEqual(row["unitId"], f"{filename}#51")
        self.assertEqual(row["bands"], ["R"])
        self.assertEqual(row["sourceMetadata"]["extension"], 51)
        self.assertEqual(row["sourceMetadata"]["wcsProjection"], "TPV")
        self.assertTrue(row["sRegion"].startswith("POLYGON ICRS 99.4890000000 -26.0936000000"))
        self.assertEqual(row["accessUris"][0]["accessType"], "file")
        query = parse_qs(urlsplit(row["accessUris"][0]["uri"]).query)
        self.assertEqual(query["col"], ["decaps_dr2"])
        self.assertEqual(query["siaRef"], [filename])
        self.assertEqual(query["extn"], ["51"])

        cutout = ccd_row(filename, 51, "r")
        cutout["access_url"] += "&POS=100,-26&SIZE=0.02"
        with self.assertRaisesRegex(ValueError, "POS/SIZE"):
            MODULE.normalize_row(cutout)

    def test_capture_locks_schema_denominators_all_keyset_pages_and_normalized_rows(self):
        rows = [
            ccd_row("c4d_180520_103732_ooi_g_decaps2.fits.fz", 51, "g"),
            ccd_row("c4d_180520_103732_ooi_i_decaps2.fits.fz", 52, "i", 1),
            ccd_row("c4d_180520_103732_ooi_r_decaps2.fits.fz", 51, "r", 1),
            ccd_row("c4d_180520_103732_ooi_Y_decaps2.fits.fz", 51, "Y", 2),
            ccd_row("c4d_180520_103732_ooi_z_decaps2.fits.fz", 52, "z", 2),
        ]
        rows.sort(key=lambda row: row["obs_pub_did"])
        schema_rows = [{"column_name": name, "description": "DECaPS source field", "unit": "", "ucd": "", "utype": ""}
                       for name in MODULE.ROW_FIELDS]
        counts = {"g": 1, "i": 1, "r": 1, "Y": 1, "z": 1}

        def fetch(url, timeout):
            self.assertEqual(timeout, 17)
            query = parse_qs(urlsplit(url).query)["QUERY"][0]
            if query == MODULE.SCHEMA_QUERY:
                return votable(SCHEMA_FIELDS, schema_rows), url, 200
            if query == MODULE.COUNT_QUERY:
                return votable(["n"], [{"n": len(rows)}]), url, 200
            if query == MODULE.BAND_COUNTS_QUERY:
                return votable(["filter", "n"], [{"filter": band, "n": count} for band, count in counts.items() if count]), url, 200
            self.assertIn("FROM ivoa_decaps_dr2.siav1", query)
            cursor = None
            if "AND obs_pub_did > '" in query:
                cursor = query.split("AND obs_pub_did > '", 1)[1].split("'", 1)[0]
            page = [row for row in rows if cursor is None or row["obs_pub_did"] > cursor][:MODULE.PAGE_SIZE]
            return votable(MODULE.ROW_FIELDS, page), url, 200

        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(MODULE, "EXPECTED_ROW_COUNT", 5), \
                patch.object(MODULE, "EXPECTED_BAND_COUNTS", counts), \
                patch.object(MODULE, "PAGE_SIZE", 2):
            output = Path(temporary) / "capture"
            result = MODULE.acquire(output, timeout=17, fetch=fetch)
            manifest = result["manifest"]
            self.assertEqual(result["ccdCount"], 5)
            self.assertEqual(manifest["rowCount"], 5)
            self.assertTrue(manifest["inventoryComplete"])
            self.assertEqual([page["rows"] for page in manifest["sourcePagination"]["pages"]], [2, 2, 1])
            self.assertTrue(manifest["sourcePagination"]["denominatorsStable"])
            self.assertEqual(len(manifest["metadataDocuments"]), 8)
            row_path = output / manifest["rowFiles"][0]["ref"]
            captured = [json.loads(line) for line in gzip.decompress(row_path.read_bytes()).splitlines()]
            self.assertEqual(len(captured), 5)
            self.assertEqual({row["bands"][0] for row in captured}, {"G", "I", "R", "Y", "Z"})

    def test_votable_overflow_is_rejected(self):
        body = votable(MODULE.ROW_FIELDS, [], statuses=("OK", "OVERFLOW"))
        with self.assertRaisesRegex(ValueError, "OVERFLOW"):
            MODULE.parse_votable(body)


if __name__ == "__main__":
    unittest.main()
