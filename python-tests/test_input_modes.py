from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import numpy as np
from astropy.io import fits

from astro_survey_moc_core.core import build_layer, read_moc_fits


SCIENTIFIC_EXTRAS = all(importlib.util.find_spec(name) is not None for name in ("astropy_healpix", "mocpy", "regions"))


def spec(layer_id: str, mode: str, input_name: str, **extra):
    return {
        "layerId": layer_id,
        "mode": mode,
        "input": input_name,
        "coverageRole": extra.pop("coverageRole", "image_extent"),
        "dataOrigin": extra.pop("dataOrigin", "observed"),
        "sourceTier": extra.pop("sourceTier", "best_effort_derived"),
        "maxOrder": extra.pop("maxOrder", 8),
        "queryOrder": 8,
        "previewOrder": 4,
        **extra,
    }


@unittest.skipUnless(SCIENTIFIC_EXTRAS, "full scientific dependency lock is not installed")
class InputModeTests(unittest.TestCase):
    def _wcs_header(self, ra: float, dec: float, rotation: float = 0) -> fits.Header:
        angle = np.deg2rad(rotation)
        scale = 0.02
        header = fits.Header()
        header["NAXIS"] = 2
        header["NAXIS1"] = 32
        header["NAXIS2"] = 24
        header["CTYPE1"] = "RA---TAN"
        header["CTYPE2"] = "DEC--TAN"
        header["CRPIX1"] = 16.5
        header["CRPIX2"] = 12.5
        header["CRVAL1"] = ra
        header["CRVAL2"] = dec
        header["CD1_1"] = -scale * np.cos(angle)
        header["CD1_2"] = scale * np.sin(angle)
        header["CD2_1"] = scale * np.sin(angle)
        header["CD2_2"] = scale * np.cos(angle)
        return header

    def test_fits_wcs_handles_ra_zero_poles_rotation_multi_hdu_and_parsed_headers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fits_path = root / "multi.fits"
            headers = [self._wcs_header(0, 0, 27), self._wcs_header(45, 89.4, -11)]
            fits.HDUList([
                fits.PrimaryHDU(),
                fits.ImageHDU(data=np.zeros((24, 32), dtype=np.uint8), header=headers[0]),
                fits.ImageHDU(data=np.zeros((24, 32), dtype=np.uint8), header=headers[1]),
            ]).writeto(fits_path)
            parsed_path = root / "headers.json"
            parsed_path.write_text(json.dumps({"headers": [dict(header) for header in headers]}))
            fits_result = build_layer(spec("wcs-fits", "fits-wcs", fits_path.name), root / "fits", base_dir=root)
            parsed_result = build_layer(spec("wcs-json", "fits-wcs", parsed_path.name), root / "json", base_dir=root)
            self.assertTrue(fits_result.cells)
            self.assertEqual(fits_result.cells, parsed_result.cells)

    def test_invalid_wcs_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "invalid.json"
            header = self._wcs_header(0, 0)
            header["CTYPE1"] = "RA---INVALID"
            path.write_text(json.dumps(dict(header)))
            with self.assertRaisesRegex(ValueError, "Invalid WCS"):
                build_layer(spec("invalid-wcs", "fits-wcs", path.name), root / "out", base_dir=root)

    def test_catalog_empty_catalog_regions_and_tile_filter(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            empty = root / "empty.json"
            empty.write_text("[]\n")
            empty_result = build_layer(spec("empty-catalog", "catalog-radec", empty.name, coverageRole="object_presence", dataOrigin="catalog"), root / "empty", base_dir=root)
            self.assertEqual(read_moc_fits(empty_result.moc_path), ())

            catalog = root / "catalog.json"
            catalog.write_text(json.dumps([{"ra": 0, "dec": 0}, {"ra": 359.999, "dec": 89.999}]))
            catalog_result = build_layer(spec("point-catalog", "catalog-radec", catalog.name, coverageRole="object_presence", dataOrigin="catalog"), root / "catalog", base_dir=root)
            self.assertEqual(len(catalog_result.cells), 2)

            regions = root / "regions.reg"
            regions.write_text("# Region file format: DS9\nicrs\npolygon(359.8,-0.2,0.2,-0.2,0.2,0.2,359.8,0.2)\ncircle(45,89.5,0.2)\nbox(20,10,0.4,0.2,27)\n")
            region_result = build_layer(spec("region-coverage", "regions", regions.name), root / "regions", base_dir=root)
            self.assertTrue(region_result.cells)

            region_zip = root / "regions.zip"
            with zipfile.ZipFile(region_zip, "w") as archive:
                archive.writestr("one.reg", regions.read_text())
            zip_result = build_layer(spec("region-archive", "regions", region_zip.name, recipe={"format": "ds9", "members": ["one.reg"]}), root / "region-zip", base_dir=root)
            self.assertEqual(region_result.cells, zip_result.cells)

            tiles = root / "tiles.fits"
            columns = [
                fits.Column(name="RA", format="D", array=np.asarray([0.0, 180.0])),
                fits.Column(name="DEC", format="D", array=np.asarray([0.0, 0.0])),
                fits.Column(name="NEXP", format="J", array=np.asarray([0, 1])),
            ]
            fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU.from_columns(columns, name="TILE_COMPLETENESS")]).writeto(tiles)
            tile_result = build_layer(spec("observed-tiles", "tile-table", tiles.name, coverageRole="footprint_extent", recipe={"hdu": "TILE_COMPLETENESS", "raColumn": "RA", "decColumn": "DEC", "nexpColumn": "NEXP", "nexpMin": 1, "radiusDeg": 1.628032452049}), root / "tiles", base_dir=root)
            self.assertTrue(tile_result.cells)


if __name__ == "__main__":
    unittest.main()
