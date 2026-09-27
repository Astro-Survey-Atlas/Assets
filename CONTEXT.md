# Domain Context

## Survey products and spatial indexing

- **Survey product**: A release-scoped data product such as an image, spectrum, redshift catalog, or source catalog.
- **Modality**: The scientific kind of a product. It is independent of how its spatial index is extracted.
- **Extraction mode**: The method used to associate a source inventory with sky coordinates or source-native spatial units.
- **Spatial unit**: A source-defined unit that can guide retrieval, such as a Euclid image file, a DESI Tile, a DESI HEALPix-partitioned redrock file, or an HST observation region.
- **Coverage relation**: Evidence connecting a source file or spatial unit to explicit ICRS/NESTED cells at a declared order and precision. It does not imply that every object inside a cell was observed.
