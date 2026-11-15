"""Legacy IRSA input is normalized at acquisition; SDK outputs stay strict."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np
from astropy.io import fits
from astro_survey_moc_core.core import validate_moc_fits

spec = importlib.util.spec_from_file_location("moc_worker", Path(__file__).parents[1] / "scripts/moc_build_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class LegacyMocSourceTests(unittest.TestCase):
    def source(self, directory, *, ordering="NUNIQ", coords="C", column="PIXEL", fmt="1J"):
        source = Path(directory) / "source.fits"
        values = np.array([4 * 4**4 + 10, 4 * 4**13 + 70000000], dtype=np.int64)
        table = fits.BinTableHDU.from_columns([fits.Column(name=column, format=fmt, array=values)])
        for key, value in {"PIXTYPE": "HEALPIX", "ORDERING": ordering, "COORDSYS": coords, "MOCORDER": 13}.items():
            table.header[key] = value
        fits.HDUList([fits.PrimaryHDU(), table]).writeto(source, overwrite=True)
        return source

    def test_integer_pixel_nuniq_becomes_sdk_moc_without_geometry_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self.source(directory)
            original = source.read_bytes()
            result = worker.build(source, Path(directory) / "output", 13, 8, 4)
            self.assertEqual(validate_moc_fits(result["moc"]["path"]), ((4, 10), (13, 70000000)))
            self.assertEqual(result["maxOrder"], 13)
            self.assertEqual(source.read_bytes(), original)
            with fits.open(result["moc"]["path"]) as hdul:
                self.assertEqual(hdul[1].columns.names, ["UNIQ"])
                self.assertEqual(hdul[1].header["MOCVERS"], "2.0")

    def test_fixed_order_pixels_galactic_and_noninteger_columns_are_rejected(self):
        for kwargs in ({"ordering": "NESTED"}, {"coords": "G"}, {"fmt": "1D"}, {"column": "OTHER"}):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(ValueError):
                    worker.read_source_moc(self.source(directory, **kwargs))

    def test_normalized_validator_does_not_accept_legacy_output(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                worker.validate(self.source(directory))


if __name__ == "__main__":
    unittest.main()
