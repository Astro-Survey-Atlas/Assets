# CSST W1 simulation coverage evidence

This approved static package describes the ICRS FITS-WCS image extent of the current CSST W1 simulation files. It is not an OSS mirror, contains no raw remote credentials or image bytes, and does not represent a formal CSST survey footprint or catalog-object distribution.

The data-warehouse coverage run matched 178,056 `W1_Phot` basenames with `^CSST_MSC_MS_WIDE_.*\.fits$`. One file was excluded because its input `CD2_1` makes a 20,000-pixel axis span about 73 degrees. The reviewed union contains 6,763 NESTED order-8 pixels and measures 354.759 square degrees. “1000 square degrees” remains the simulation project label, not the measured footprint of this file set.

`csst-w1-image-extent-order8.fits` is the native NUNIQ MOC. `display-footprint-nside16.json` is only a display-resolution parent-pixel reduction. The complete input manifest preserves OSS ETags as metadata and never treats multipart ETags as SHA-256 hashes.
