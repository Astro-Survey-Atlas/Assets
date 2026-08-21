"""Astro Survey MOC Core deterministic coverage generation primitives."""

from .contract import (
    CORE_VERSION,
    DEFAULT_MAX_ORDER,
    PREVIEW_ORDER,
    QUERY_ORDER,
    CoverageSpec,
    DataOrigin,
    CoverageRole,
    SourceTier,
    normalize_spec,
)
from .core import BuildResult, build_layer, canonical_cells, read_moc_fits, validate_moc_fits, write_moc_fits
from .task_contract import TASK_CONTRACT_VERSION, PublicCoverageTask, TaskContractError, normalize_task

__all__ = [
    "CORE_VERSION",
    "DEFAULT_MAX_ORDER",
    "PREVIEW_ORDER",
    "QUERY_ORDER",
    "CoverageSpec",
    "DataOrigin",
    "CoverageRole",
    "SourceTier",
    "BuildResult",
    "build_layer",
    "canonical_cells",
    "normalize_spec",
    "read_moc_fits",
    "validate_moc_fits",
    "write_moc_fits",
    "TASK_CONTRACT_VERSION",
    "PublicCoverageTask",
    "TaskContractError",
    "normalize_task",
]
