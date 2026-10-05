import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from xml.sax.saxutils import escape
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acquire-2mass-6x-atlas.py"
SPEC = importlib.util.spec_from_file_location("acquire_2mass_6x_atlas", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

FIELDS = [
    "name", "download", "center_ra", "center_dec", "naxes", "naxis", "scale", "format", "crpix", "crval", "crota2",
    "band", "bref", "bhi", "blo", "pers_art", "glint_art", "type", "dataset", "pixflags", "id", "scntr", "date",
    "hem", "scan", "image", "ut_date", "coadd_key", "seesh", "magzp", "msnr10", "bin",
]


def record(band):
    name = f"{band.lower()}i0460033.fits"
    return [
        f"6X Catalog {band}-Band Atlas Image: 001114 n 046 0033",
        f"https://irsa.ipac.caltech.edu:443/cgi-bin/2MASS/IM/nph-im?ds=sx&atdir=%2Fti09%2F6x&dh=001114n&scan=046&name={name}",
        "1.068145330e+01", "4.129402879e+01", "2", "512 1024", "-2.777777845e-04 2.777777845e-04",
        "image/fits", "256.5 512.5", "10.68145330 41.29402879", "0.03385583169", band,
        "1.235e-06", "1.404e-06", "1.066e-06", "null", "null", "A", "sx", "CZ", "null", "null",
        "001114", "n", "46", "33", "001114", "54225", "3.14123", "23.0688", "17.2280", "233001202",
    ]


def votable(rows, status="OK"):
    fields = "".join(f'<FIELD name="{name}" datatype="char" arraysize="*"/>' for name in FIELDS)
    records = "".join("<TR>" + "".join(f"<TD>{escape(value)}</TD>" for value in row) + "</TR>" for row in rows)
    return (f'<?xml version="1.0"?><VOTABLE xmlns="{MODULE.VOTABLE_NS}"><RESOURCE><INFO name="QUERY_STATUS" value="{status}"/>'
            f"<TABLE>{fields}<DATA><TABLEDATA>{records}</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>").encode()


class TwoMassAcquireTest(unittest.TestCase):
    def test_wcs_and_ibe_rule_produce_a_whole_image_identity(self):
        row = MODULE.normalize_row(dict(zip(FIELDS, record("J"))))
        self.assertEqual(row["unitId"], "001114n/s046/0033/J")
        self.assertEqual(row["filename"], "ji0460033.fits.gz")
        self.assertEqual(row["accessUris"][0]["uri"], "https://irsa.ipac.caltech.edu/ibe/data/twomass/sixxcat/sixxcat/001114n/s046/image/ji0460033.fits.gz")
        self.assertEqual(row["sRegion"], "POLYGON ICRS 10.7759944164 41.1518082455 10.5871124880 41.1517243701 10.5864760203 41.4361687116 10.7761833685 41.4362529535")
        self.assertEqual(row["sourceMetadata"]["coaddKey"], 54225)

    def test_capture_locks_raw_query_pages_and_normalized_image_rows(self):
        body = votable([record(band) for band in ("J", "H", "K")])
        query = MODULE.QUERY_TEMPLATE.format(position="10.6847083%2C41.26875")
        def fetch(url, timeout):
            self.assertEqual(url, MODULE.SOURCE_URL + "?" + query)
            return body, url, 200
        m31 = {**MODULE.REGION_SPECS["m31"], "expectedRows": 3, "expectedBandCounts": {"J": 1, "H": 1, "K": 1}, "expectedCoadds": 1}
        with tempfile.TemporaryDirectory() as temporary, patch.dict(MODULE.REGION_SPECS, {"m31": m31}):
            output = Path(temporary) / "capture"
            manifest = MODULE.acquire(output, fetch=fetch)
            self.assertEqual(manifest["rowCount"], 3)
            self.assertFalse(manifest["inventoryComplete"])
            self.assertTrue(manifest["queryPagesComplete"])
            self.assertEqual(manifest["scope"]["coaddCount"], 1)
            self.assertEqual(manifest["scope"]["region"], "m31")
            self.assertEqual(manifest["sourcePagination"]["pages"][0]["query"], query)
            row_file = output / "rows/2mass-6x-m31-1deg-atlas-images.ndjson.gz"
            rows = [json.loads(line) for line in gzip.decompress(row_file.read_bytes()).splitlines()]
            self.assertEqual([row["bands"][0] for row in rows], ["J", "H", "K"])
            self.assertEqual((output / "metadata/sia-response.votable.xml").read_bytes(), body)

    def test_lmc_query_has_a_separate_source_identity_and_bounded_denominator(self):
        spec = MODULE.REGION_SPECS["lmc"]
        self.assertEqual(spec["sourceId"], "2mass-6x-lmc-1deg-atlas-images")
        self.assertEqual(spec["position"], "80.894,-69.756")
        self.assertEqual(spec["expectedRows"], 165)
        self.assertEqual(spec["expectedCoadds"], 55)
        self.assertEqual(spec["expectedBandCounts"], {"J": 55, "H": 55, "K": 55})

    def test_capture_rejects_overflow_and_query_status_errors(self):
        body = votable([record("J")], status="OVERFLOW")
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "QUERY_STATUS=OVERFLOW"):
                MODULE.parse_votable(body)


if __name__ == "__main__":
    unittest.main()
