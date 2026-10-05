import gzip
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import urllib.parse

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-skymapper-dr4-ccds.py"
SPEC = importlib.util.spec_from_file_location("acquire_skymapper_dr4_ccds", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
acquire = MODULE.acquire
immutable_write = MODULE.immutable_write
parse_votable = MODULE.parse_votable
spherical_center = MODULE.spherical_center


NS = "http://www.ivoa.net/xml/VOTable/v1.3"
FIELDS = ("image_id", "ccd", "filter", "filename", "coverage")
POLYGON = "POLYGON ICRS 10.0 2.0 10.2 2.0 10.2 2.2 10.0 2.2"


def votable(fields, rows):
    field_nodes = "".join(f'<FIELD name="{field}" datatype="char" arraysize="*"/>' for field in fields)
    row_nodes = "".join("<TR>" + "".join(f"<TD>{value}</TD>" for value in row) + "</TR>" for row in rows)
    return (
        f'<VOTABLE xmlns="{NS}"><RESOURCE><INFO name="QUERY_STATUS" value="OK"/>'
        f"<TABLE>{field_nodes}<DATA><TABLEDATA>{row_nodes}</TABLEDATA></DATA></TABLE>"
        "</RESOURCE></VOTABLE>"
    ).encode()


def record(image_id, ccd, band):
    return [
        str(image_id),
        str(ccd),
        band,
        f"56731/01/Skymapper_1206517766_2014-03-16T02:31:00_{ccd:02d}_red.fits",
        POLYGON,
    ]


class SkyMapperAcquisitionTests(unittest.TestCase):
    def test_acquisition_records_expected_count_and_complete_keyset_pages(self):
        responses = [
            (votable(["n"], [["3"]]), "https://api.skymapper.nci.org.au/public/tap/sync?count", 200),
            (votable(FIELDS, [record(20140315153115, 1, "g"), record(20140315153115, 2, "r")]), "https://api.skymapper.nci.org.au/public/tap/sync?page=1", 200),
            (votable(FIELDS, [record(20140315153115, 3, "i")]), "https://api.skymapper.nci.org.au/public/tap/sync?page=2", 200),
        ]

        def fetch(query, _timeout):
            self.assertIn("20140315000000", query)
            self.assertIn("20140318000000", query)
            self.assertIn("filter IN ('g','r','i')", query)
            return responses.pop(0)

        with tempfile.TemporaryDirectory() as temporary, patch("acquire_skymapper_dr4_ccds.EXPECTED_ROWS", 3), patch("acquire_skymapper_dr4_ccds.PAGE_SIZE", 2):
            manifest = acquire(Path(temporary), fetch=fetch)
            self.assertEqual(manifest["rowCount"], 3)
            self.assertEqual(manifest["sourcePagination"]["expectedRowCount"], 3)
            self.assertEqual([page["rows"] for page in manifest["sourcePagination"]["pages"]], [2, 1])
            self.assertTrue(manifest["sourcePagination"]["queryPagesComplete"])
            row_file = Path(temporary) / manifest["rowFiles"][0]["ref"]
            rows = [json.loads(line) for line in gzip.decompress(row_file.read_bytes()).decode().splitlines()]
            self.assertEqual([row["unitId"] for row in rows], ["20140315153115-01", "20140315153115-02", "20140315153115-03"])
            self.assertEqual(rows[0]["sourceMetadata"]["accessSemantics"], "five-arcmin-fits-cutout-not-full-ccd")
            cutout = urllib.parse.urlsplit(rows[0]["accessUris"][0]["uri"])
            self.assertEqual(cutout.path, "/public/siap/dr4/get_image")
            self.assertEqual(urllib.parse.parse_qs(cutout.query)["SIZE"], ["0.0833"])
            self.assertEqual(manifest["inventoryComplete"], False)

    def test_acquisition_rejects_unexpected_bounded_count_before_fetching_pages(self):
        response = votable(["n"], [["4"]])

        def fetch(query, _timeout):
            self.assertIn("COUNT(*)", query)
            return response, "https://api.skymapper.nci.org.au/public/tap/sync", 200

        with tempfile.TemporaryDirectory() as temporary, patch("acquire_skymapper_dr4_ccds.EXPECTED_ROWS", 3):
            with self.assertRaisesRegex(ValueError, "expected 3 rows"):
                acquire(Path(temporary), fetch=fetch)

    def test_parser_rejects_failed_query_status_and_bad_geometry(self):
        with self.assertRaisesRegex(ValueError, "QUERY_STATUS=ERROR"):
            parse_votable(f'<VOTABLE xmlns="{NS}"><RESOURCE><INFO name="QUERY_STATUS" value="ERROR">bad query</INFO></RESOURCE></VOTABLE>'.encode())
        with self.assertRaisesRegex(ValueError, "ICRS polygon"):
            spherical_center("CIRCLE ICRS 10 2 0.1")

    def test_immutable_evidence_write_rejects_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence.bin"
            immutable_write(path, b"first")
            immutable_write(path, b"first")
            with self.assertRaisesRegex(ValueError, "Refusing to replace"):
                immutable_write(path, b"different")


if __name__ == "__main__":
    unittest.main()
