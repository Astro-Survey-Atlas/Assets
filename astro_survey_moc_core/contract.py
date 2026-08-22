"""The cross-repository scientific contract owned by Assets.

This module is deliberately dependency-light. Assets-side tools and compatible
task integrations can validate a normalized spec without importing any FITS or
HEALPix implementation. Public package consumers are not required to import
this module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping

CORE_VERSION = "1.0.0"
DEFAULT_MAX_ORDER = 10
QUERY_ORDER = 8
PREVIEW_ORDER = 4
COORDINATE_FRAME = "ICRS"
ORDERING = "NESTED"

CoverageRole = Literal["image_extent", "object_presence", "footprint_extent"]
DataOrigin = Literal["observed", "simulated", "catalog"]
SourceTier = Literal[
    "official_geometry",
    "official_inventory_derived",
    "third_party_moc",
    "best_effort_derived",
    "user_file_derived",
]

COVERAGE_ROLES = frozenset(("image_extent", "object_presence", "footprint_extent"))
DATA_ORIGINS = frozenset(("observed", "simulated", "catalog"))
SOURCE_TIERS = frozenset(
    (
        "official_geometry",
        "official_inventory_derived",
        "third_party_moc",
        "best_effort_derived",
        "user_file_derived",
    )
)


class ContractError(ValueError):
    """Raised when a scientific spec violates the shared contract."""


@dataclass(frozen=True)
class CoverageSpec:
    layer_id: str
    mode: str
    coverage_role: CoverageRole
    data_origin: DataOrigin
    source_tier: SourceTier
    input: str | None = None
    max_order: int = DEFAULT_MAX_ORDER
    query_order: int = QUERY_ORDER
    preview_order: int = PREVIEW_ORDER
    coordinate_frame: str = COORDINATE_FRAME
    ordering: str = ORDERING
    recipe: Mapping[str, Any] = field(default_factory=dict)
    snapshot: Mapping[str, Any] = field(default_factory=dict)
    survey_id: str | None = None
    release_id: str | None = None
    product: str | None = None
    modality: str | None = None
    source_url: str | None = None

    def validate(self) -> "CoverageSpec":
        if not self.layer_id or not _valid_id(self.layer_id):
            raise ContractError("layerId must be a lower-case stable identifier")
        if self.mode not in {"fits-wcs", "catalog-radec", "nested-healpix", "regions", "tile-table"}:
            raise ContractError(f"Unsupported coverage mode: {self.mode}")
        if self.coverage_role not in COVERAGE_ROLES:
            raise ContractError(f"Unsupported coverageRole: {self.coverage_role}")
        if self.data_origin not in DATA_ORIGINS:
            raise ContractError(f"Unsupported dataOrigin: {self.data_origin}")
        if self.source_tier not in SOURCE_TIERS:
            raise ContractError(f"Unsupported sourceTier: {self.source_tier}")
        if self.coordinate_frame != COORDINATE_FRAME:
            raise ContractError("Only ICRS is supported by the Assets MOC contract")
        if self.ordering != ORDERING:
            raise ContractError("Only NESTED HEALPix ordering is supported")
        for name, value in (("maxOrder", self.max_order), ("queryOrder", self.query_order), ("previewOrder", self.preview_order)):
            if not isinstance(value, int) or value < 0 or value > 29:
                raise ContractError(f"{name} must be an integer between 0 and 29")
        if self.max_order > DEFAULT_MAX_ORDER:
            justification = self.recipe.get("precisionJustification")
            if not isinstance(justification, str) or not justification.strip():
                raise ContractError("A maxOrder above the default requires recipe.precisionJustification")
        return self

    def as_dict(self) -> dict[str, Any]:
        self.validate()
        result: dict[str, Any] = {
            "layerId": self.layer_id,
            "mode": self.mode,
            "coverageRole": self.coverage_role,
            "dataOrigin": self.data_origin,
            "sourceTier": self.source_tier,
            "maxOrder": self.max_order,
            "queryOrder": self.query_order,
            "previewOrder": self.preview_order,
            "coordinateFrame": self.coordinate_frame,
            "ordering": self.ordering,
            "recipe": dict(self.recipe),
            "snapshot": dict(self.snapshot),
        }
        optional = {
            "input": self.input,
            "surveyId": self.survey_id,
            "releaseId": self.release_id,
            "product": self.product,
            "modality": self.modality,
            "sourceUrl": self.source_url,
        }
        result.update({key: value for key, value in optional.items() if value is not None})
        return result


def _valid_id(value: str) -> bool:
    return all(char.islower() or char.isdigit() or char == "-" for char in value) and value[0].isalnum()


def normalize_spec(raw: Mapping[str, Any]) -> CoverageSpec:
    """Normalize the current camelCase contract without legacy aliases."""

    if "evidenceRole" in raw:
        raise ContractError("evidenceRole is removed; use coverageRole")
    coverage_role = raw.get("coverageRole")
    if coverage_role is None:
        raise ContractError("coverageRole is required")
    spec = CoverageSpec(
        layer_id=str(raw.get("layerId", raw.get("layer_id", ""))),
        mode=str(raw.get("mode", "")),
        coverage_role=coverage_role,
        data_origin=str(raw.get("dataOrigin", "")),
        source_tier=str(raw.get("sourceTier", "")),
        input=raw.get("input"),
        max_order=int(raw.get("maxOrder", DEFAULT_MAX_ORDER)),
        query_order=int(raw.get("queryOrder", QUERY_ORDER)),
        preview_order=int(raw.get("previewOrder", PREVIEW_ORDER)),
        coordinate_frame=str(raw.get("coordinateFrame", COORDINATE_FRAME)),
        ordering=str(raw.get("ordering", ORDERING)),
        recipe=raw.get("recipe") or {},
        snapshot=raw.get("snapshot") or {},
        survey_id=raw.get("surveyId"),
        release_id=raw.get("releaseId"),
        product=raw.get("product"),
        modality=raw.get("modality"),
        source_url=raw.get("sourceUrl"),
    )
    return spec.validate()
