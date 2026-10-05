import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-des-dr2-native-tiles.py"
SPEC = importlib.util.spec_from_file_location("acquire_des_dr2_native_tiles", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SCHEMA_FIELDS = ["column_name", "description", "unit", "ucd", "utype"]
DENOMINATOR_FIELDS = ["object", "files"]
BAND_COUNT_FIELDS = ["filter", "n"]


def tile_row(tile, band, corners=None):
    filename = f"{tile}_r4907p01_{band}.fits.fz"
    publisher = f"ivo://datalab.noao/des_dr2/{filename}#1"
    access = f"https://datalab.noirlab.edu/svc/cutout?col=des_dr2&siaRef={filename}&extn=1"
    corners = corners or [[20.8, -18.9], [20.0, -18.9], [20.0, -18.1], [20.8, -18.1]]
    row = {"object": tile, "fileref": filename, "filter": band, "obs_pub_did": publisher, "access_url": access}
    for index, (ra, dec) in enumerate(corners, 1):
        row[f"ra{index}"] = str(ra)
        row[f"dec{index}"] = str(dec)
    return row


def votable(fields, rows, statuses=("OK",)):
    field_xml = "".join(f'<FIELD name="{name}" datatype="char" arraysize="*"/>' for name in fields)
    row_xml = "".join("<TR>" + "".join(f"<TD>{escape(str(row.get(name, '')))}</TD>" for name in fields) + "</TR>" for row in rows)
    info = "".join(f'<INFO name="QUERY_STATUS" value="{status}"/>' for status in statuses)
    return (f'<?xml version="1.0"?><VOTABLE xmlns="{MODULE.VOTABLE_NS}"><RESOURCE>{info}'
            f"<TABLE>{field_xml}<DATA><TABLEDATA>{row_xml}</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>").encode()


class DesAcquireTest(unittest.TestCase):
    def test_unqualified_votable_12_from_tap_is_parsed_by_local_element_names(self):
        body = (
            b'<?xml version="1.0"?><VOTABLE version="1.2"><RESOURCE>'
            b'<INFO name="QUERY_STATUS" value="OK"/><TABLE>'
            b'<FIELD name="column_name" datatype="char" arraysize="*"/>'
            b'<DATA><TABLEDATA><TR><TD>object</TD></TR></TABLEDATA></DATA>'
            b'</TABLE></RESOURCE></VOTABLE>'
        )
        fields, rows = MODULE.parse_votable(body)
        self.assertEqual(fields, ["column_name"])
        self.assertEqual(rows, [{"column_name": "object"}])

    def test_tile_row_keeps_icrs_corners_and_only_the_no_cutout_full_file_uri(self):
        corners = [[359.9, 1.9], [0.1, 1.9], [0.1, 2.3], [359.9, 2.3]]
        row = MODULE.normalize_row(tile_row("DES0000+0209", "g", corners))
        self.assertEqual(row["unitId"], "DES0000+0209")
        self.assertEqual(row["sRegion"], "POLYGON ICRS 359.9000000000 1.9000000000 0.1000000000 1.9000000000 0.1000000000 2.3000000000 359.9000000000 2.3000000000")
        self.assertEqual(row["accessUris"][0]["accessType"], "file")
        self.assertEqual(row["accessUris"][0]["fileName"], "DES0000+0209_r4907p01_g.fits.fz")
        query = parse_qs(urlsplit(row["accessUris"][0]["uri"]).query)
        self.assertEqual(query["col"], ["des_dr2"])
        self.assertEqual(query["extn"], ["1"])
        self.assertIn("siaRef=DES0000+0209_r4907p01_g.fits.fz", urlsplit(row["accessUris"][0]["uri"]).query)
        self.assertEqual(row["sourceMetadata"]["accessSemantics"], "full-coadd-image-no-region-cutout")

        cutout = tile_row("DES0000+0209", "g")
        cutout["access_url"] += "&POS=25,-45&SIZE=0.02"
        with self.assertRaisesRegex(ValueError, "no-cutout"):
            MODULE.normalize_row(cutout)

    def test_capture_locks_schema_denominators_every_keyset_page_and_normalized_rows(self):
        rows = [tile_row(tile, band) for tile in ["DES0000-0000", "DES0000+0001"] for band in MODULE.FILTERS]
        rows.sort(key=lambda row: row["obs_pub_did"])
        schema_rows = [{"column_name": name, "description": "ICRS or native identity column", "unit": "", "ucd": "", "utype": ""} for name in MODULE.ROW_FIELDS]

        def fetch(url, timeout):
            self.assertEqual(timeout, 17)
            query = parse_qs(urlsplit(url).query)["QUERY"][0]
            if query == MODULE.SCHEMA_QUERY:
                return votable(SCHEMA_FIELDS, schema_rows), url, 200
            if query == MODULE.DENOMINATOR_QUERY:
                return votable(DENOMINATOR_FIELDS, [{"object": "DES0000-0000", "files": 10}, {"object": "DES0000+0001", "files": 10}]), url, 200
            if query == MODULE.BAND_COUNTS_QUERY:
                return votable(BAND_COUNT_FIELDS, [{"filter": band, "n": 2} for band in MODULE.FILTERS]), url, 200
            self.assertIn("FROM ivoa_des_dr2.siav1", query)
            cursor = None
            if "AND obs_pub_did > '" in query:
                cursor = query.split("AND obs_pub_did > '", 1)[1].split("'", 1)[0]
            page = [row for row in rows if cursor is None or row["obs_pub_did"] > cursor][:MODULE.PAGE_SIZE]
            return votable(MODULE.ROW_FIELDS, page), url, 200

        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(MODULE, "EXPECTED_TILE_COUNT", 2), \
                patch.object(MODULE, "EXPECTED_ROW_COUNT", 10), \
                patch.object(MODULE, "PAGE_SIZE", 6):
            output = Path(temporary) / "capture"
            result = MODULE.acquire(output, timeout=17, fetch=fetch)
            manifest = result["manifest"]
            self.assertEqual(result["tileCount"], 2)
            self.assertEqual(manifest["rowCount"], 10)
            self.assertTrue(manifest["inventoryComplete"])
            self.assertEqual([page["rows"] for page in manifest["sourcePagination"]["pages"]], [6, 4])
            self.assertEqual(manifest["sourcePagination"]["denominator"]["tileCount"], 2)
            self.assertEqual(manifest["sourcePagination"]["bandCounts"]["perBandCount"], 2)
            self.assertEqual(len(manifest["metadataDocuments"]), 5)
            row_path = output / manifest["rowFiles"][0]["ref"]
            captured = [json.loads(line) for line in gzip.decompress(row_path.read_bytes()).splitlines()]
            self.assertEqual(len(captured), 10)
            self.assertEqual({row["unitId"] for row in captured}, {"DES0000-0000", "DES0000+0001"})

    def test_votable_overflow_is_rejected(self):
        body = votable(MODULE.ROW_FIELDS, [], statuses=("OK", "OVERFLOW"))
        with self.assertRaisesRegex(ValueError, "OVERFLOW"):
            MODULE.parse_votable(body)


if __name__ == "__main__":
    unittest.main()
