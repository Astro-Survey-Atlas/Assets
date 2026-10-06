import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "acquire-rubin-firstlook-native-images.py"
SPEC = importlib.util.spec_from_file_location("acquire_rubin_firstlook_native_images", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def ifd_entry(tag, field_type, count, value):
    return struct.pack("<HHQQ", tag, field_type, count, value)


class RubinFirstLookCaptureTests(unittest.TestCase):
    def test_big_tiff_header_and_ifd_metadata_ranges_are_parsed(self):
        entries = [
            ifd_entry(256, 16, 1, 97_943),
            ifd_entry(257, 16, 1, 51_536),
            ifd_entry(700, 1, 26_089, 524),
        ]
        entries.extend(ifd_entry(3000 + index, 4, 1, 0) for index in range(19))
        parsed = MODULE.parse_big_tiff_header(
            b"II+\x00\x08\x00\x00\x00" + struct.pack("<Q", 16),
            struct.pack("<Q", 22),
            b"".join(entries),
            15_142_805_372,
        )
        self.assertEqual(parsed["width"], 97_943)
        self.assertEqual(parsed["height"], 51_536)
        self.assertEqual(parsed["xmpOffset"], 524)
        self.assertEqual(parsed["xmpLength"], 26_089)

    def test_avm_spatial_fields_and_sequence_values_are_normalized(self):
        xml = b'''<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:avm="urn:avm" xmlns:rdf="urn:rdf">
          <rdf:Description avm:Spatial.CoordinateFrame="ICRS" avm:Spatial.Equinox="J2000"
            avm:Spatial.CoordsystemProjection="TAN" avm:Spatial.Quality="Position" avm:Spatial.Rotation="48.96">
            <avm:Spatial.ReferenceValue><rdf:Seq><rdf:li>186.3</rdf:li><rdf:li>6.9</rdf:li></rdf:Seq></avm:Spatial.ReferenceValue>
            <avm:Spatial.ReferenceDimension><rdf:Seq><rdf:li>97943</rdf:li><rdf:li>51536</rdf:li></rdf:Seq></avm:Spatial.ReferenceDimension>
            <avm:Spatial.ReferencePixel><rdf:Seq><rdf:li>48971.5</rdf:li><rdf:li>25768</rdf:li></rdf:Seq></avm:Spatial.ReferencePixel>
            <avm:Spatial.Scale><rdf:Seq><rdf:li>-0.0000555</rdf:li><rdf:li>0.0000555</rdf:li></rdf:Seq></avm:Spatial.Scale>
          </rdf:Description>
        </x:xmpmeta>'''
        avm = MODULE.parse_avm(xml)
        self.assertEqual(avm["coordinateFrame"], "ICRS")
        self.assertEqual(avm["equinox"], "J2000")
        self.assertEqual(avm["projection"], "TAN")
        self.assertEqual(avm["quality"], "Position")
        self.assertEqual(avm["referenceDimension"], [97_943.0, 51_536.0])

    def test_metadata_range_must_be_exact_http_206_before_it_is_saved(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(MODULE, "request", return_value=(b"short", 200, {"content-range": "bytes 0-7/100"})):
                with self.assertRaisesRegex(ValueError, "did not honor metadata-only Range"):
                    MODULE.range_capture(Path(temp), "image", "https://example.test/image.tif", 0, 7, 100)
            self.assertFalse((Path(temp) / "metadata").exists())


if __name__ == "__main__":
    unittest.main()
