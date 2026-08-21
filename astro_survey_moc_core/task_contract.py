"""Dependency-light validation for the Assets/data-warehouse task handoff."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Mapping

from .contract import normalize_spec

TASK_SCHEMA_VERSION = 1
TASK_CONTRACT_VERSION = "1.0.0"
_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_SAFE_OUTPUT = re.compile(r"^(?:warehouse-results|snapshots)/[^\\\x00]+$")


class TaskContractError(ValueError):
    """Raised when a public coverage task would cross the service boundary."""


@dataclass(frozen=True)
class PublicCoverageTask:
    task_id: str
    layer: Mapping[str, Any]
    connector: Mapping[str, Any]
    recipe: Mapping[str, Any]
    execution: Mapping[str, Any]
    output: Mapping[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": TASK_SCHEMA_VERSION,
            "taskId": self.task_id,
            "layer": dict(self.layer),
            "connector": dict(self.connector),
            "recipe": dict(self.recipe),
            "execution": dict(self.execution),
            "output": dict(self.output),
        }


def normalize_task(raw: Mapping[str, Any]) -> PublicCoverageTask:
    """Validate and normalize an internal one-shot warehouse handoff.

    Connector credentials, arbitrary endpoints, user paths and Atlas-specific
    fields are deliberately rejected. The warehouse resolves credentials from
    ``connectorId`` and returns only a hashed normalized result.
    """

    if raw.get("schemaVersion") != TASK_SCHEMA_VERSION:
        raise TaskContractError("Unsupported coverage task schemaVersion")
    task_id = raw.get("taskId")
    if not isinstance(task_id, str) or _ID.fullmatch(task_id) is None:
        raise TaskContractError("taskId must be a lower-case stable identifier")
    layer = raw.get("layer")
    connector = raw.get("connector")
    recipe = raw.get("recipe")
    execution = raw.get("execution")
    output = raw.get("output")
    if not all(isinstance(value, Mapping) for value in (layer, connector, recipe, execution, output)):
        raise TaskContractError("coverage task layer, connector, recipe, execution and output are required objects")
    if any(key in raw for key in ("credentials", "userAsset", "atlasTask", "callbackUrl", "database")):
        raise TaskContractError("coverage task contains a forbidden runtime or user field")

    layer_input = dict(layer)
    layer_input["input"] = layer_input.get("input", "warehouse-result.json")
    layer_input.update({key: value for key, value in recipe.items() if key in {"coordinateFrame", "ordering", "maxOrder", "queryOrder", "previewOrder"}})
    normalize_spec(layer_input)

    connector_id = connector.get("connectorId")
    kind = connector.get("kind")
    config_hash = connector.get("configSha256")
    if not isinstance(connector_id, str) or _ID.fullmatch(connector_id) is None:
        raise TaskContractError("connector.connectorId must be a lower-case stable identifier")
    if kind not in {"s3", "oss", "jdbc", "filesystem"}:
        raise TaskContractError("Unsupported connector kind")
    if not isinstance(config_hash, str) or _HASH.fullmatch(config_hash) is None:
        raise TaskContractError("connector.configSha256 must be a SHA-256 digest")
    if any(key in connector for key in ("secret", "password", "accessKey", "accessSecret", "token", "uri")):
        raise TaskContractError("Connector credentials and endpoints do not belong in the task")

    if recipe.get("coordinateFrame") != "ICRS" or recipe.get("ordering") != "NESTED":
        raise TaskContractError("Coverage recipes must use ICRS/NESTED")
    if recipe.get("mode") != layer.get("mode"):
        raise TaskContractError("Task layer mode and recipe mode must match")
    if recipe.get("queryOrder") != 8 or recipe.get("previewOrder") != 4:
        raise TaskContractError("Coverage recipes must provide order-8 query and order-4 preview projections")

    if execution.get("executor") != "data-warehouse":
        raise TaskContractError("Public coverage tasks must execute in data-warehouse")
    for key in ("timeoutSeconds", "maxBytes"):
        if not isinstance(execution.get(key), int) or execution[key] < 1:
            raise TaskContractError(f"execution.{key} must be a positive integer")

    if output.get("resultKind") not in {"normalized-scan", "locked-build-input"}:
        raise TaskContractError("Unsupported task resultKind")
    if output.get("contractVersion") != TASK_CONTRACT_VERSION:
        raise TaskContractError("Unsupported task result contract version")
    if "path" in output and (not isinstance(output["path"], str) or _SAFE_OUTPUT.fullmatch(output["path"]) is None):
        raise TaskContractError("Task output path must remain inside the warehouse result namespace")
    if "sha256" in output and (not isinstance(output["sha256"], str) or _HASH.fullmatch(output["sha256"]) is None):
        raise TaskContractError("Task output sha256 must be a SHA-256 digest")
    if "sizeBytes" in output and (not isinstance(output["sizeBytes"], int) or output["sizeBytes"] < 1):
        raise TaskContractError("Task output sizeBytes must be positive")

    return PublicCoverageTask(task_id, dict(layer), dict(connector), dict(recipe), dict(execution), dict(output))
