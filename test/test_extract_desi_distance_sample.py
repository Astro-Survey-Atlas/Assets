import hashlib
from pathlib import Path
import runpy
import tempfile
import unittest

from astropy.io import fits

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/extract-desi-distance-sample.py"))


class DesiDistanceSampleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / MODULE["RELATIVE_PATH"]
        self.source.parent.mkdir(parents=True)
        self.columns = [
            fits.Column(name="TARGETID", format="K", array=[39628473198710603, 39628473198711006, 39628473198711342]),
            fits.Column(name="TARGET_RA", format="D", array=[12, 13, 14]),
            fits.Column(name="TARGET_DEC", format="D", array=[-2, -3, -4]),
            fits.Column(name="Z", format="D", array=[.3, -.01, float("nan")]),
            fits.Column(name="ZERR", format="D", array=[.0001, .0002, .0003]),
            fits.Column(name="ZWARN", format="K", array=[0, 0, 4]),
            fits.Column(name="SPECTYPE", format="6A", array=["GALAXY", "STAR", "GALAXY"]),
            fits.Column(name="DELTACHI2", format="D", array=[31, 22, 10]),
            fits.Column(name="SURVEY", format="7A", array=["main"] * 3),
            fits.Column(name="PROGRAM", format="6A", array=["bright"] * 3),
            fits.Column(name="ZCAT_PRIMARY", format="L", array=[True, False, True]),
            fits.Column(name="OBJTYPE", format="3A", array=["TGT", "TGT", "SKY"]),
        ]
        self.write_fits()

    def write_fits(self):
        primary = fits.PrimaryHDU()
        primary.header["ZCATVER"] = "v1"
        fits.HDUList([primary, fits.BinTableHDU.from_columns(self.columns, name="ZCATALOG")]).writeto(self.source, overwrite=True)

    def test_preserves_big_ids_logicals_quality_and_negative_measurements(self):
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.source.with_name("redux_iron_zcatalog_v1.sha256sum").write_text(f"{digest}  {self.source.name}\n")
        result = MODULE["extract"](self.root, 0, 3)
        self.assertEqual([r["objectId"] for r in result["objects"]][:2], ["39628473198710603", "39628473198711006"])
        self.assertEqual([r["zcatPrimary"] for r in result["objects"]], [True, False, True])
        self.assertEqual(result["objects"][1]["redshift"], -.01)
        self.assertIsNone(result["objects"][2]["redshift"])
        self.assertEqual(result["objects"][0]["redshiftFrame"], "barycentric")
        self.assertEqual(result["objects"][2]["objtype"], "SKY")
        self.assertEqual(result["source"]["expectedFileSha256"], digest)
        self.assertFalse(result["source"]["wholeFileSha256Verified"])
        self.assertFalse(result["source"]["skyRegionComplete"])

    def test_hashes_exact_row_window_and_marks_only_its_completeness(self):
        result = MODULE["extract"](self.root, 1, 1)
        self.assertEqual([r["sourceRow"] for r in result["objects"]], [1])
        self.assertFalse(result["source"]["catalogueComplete"])
        self.assertTrue(result["source"]["sampleComplete"])
        with fits.open(self.source) as hdus:
            hdu = hdus["ZCATALOG"]
            start = hdu.fileinfo()["datLoc"] + hdu.header["NAXIS1"]
            width = hdu.header["NAXIS1"]
        self.assertEqual(result["source"]["rowBytesSha256"], hashlib.sha256(self.source.read_bytes()[start:start + width]).hexdigest())
        self.assertEqual(len(MODULE["extract"](self.root, 2, 100)["objects"]), 1)

    def test_rejects_unbounded_out_of_range_and_unsupported_schema(self):
        for start, count in [(-1, 1), (0, 0), (0, 200001), (3, 1)]:
            with self.assertRaises(ValueError):
                MODULE["extract"](self.root, start, count)
        self.columns = [col for col in self.columns if col.name != "ZCAT_PRIMARY"]
        self.write_fits()
        with self.assertRaises(KeyError):
            MODULE["extract"](self.root, 0, 1)


if __name__ == "__main__":
    unittest.main()
