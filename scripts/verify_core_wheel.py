"""Verify the pinned Core wheel and source snapshot without imports."""

from __future__ import annotations

import argparse
import email
import hashlib
import json
import re
import tarfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WHEEL_DIR = ROOT / "artifacts/public-survey-footprints/moc-core"
SOURCE = ROOT / "requirements/moc-core-source.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE, help="Core provenance JSON")
    parser.add_argument("--wheel", type=Path, help="wheel path (defaults to the pinned artifact)")
    parser.add_argument("--snapshot", type=Path, help="source snapshot path (defaults to the pinned artifact)")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    if source.get("schemaVersion") != 2:
        raise SystemExit("Unsupported Core provenance schema; expected version 2")
    if source.get("sourceState") != "dirty-worktree-snapshot":
        raise SystemExit("Core provenance must identify the source as a dirty-worktree snapshot")
    base_commit = source.get("baseCommit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", base_commit):
        raise SystemExit("Core provenance has an invalid baseCommit")
    snapshot_record = source.get("sourceSnapshot", {})
    snapshot_name = snapshot_record.get("file", "")
    if not snapshot_name or Path(snapshot_name).name != snapshot_name:
        raise SystemExit("Core provenance has an invalid source snapshot filename")
    if not isinstance(snapshot_record.get("archiveCommand"), str) or not snapshot_record["archiveCommand"]:
        raise SystemExit("Core provenance is missing its deterministic source archive command")
    wheel_name = source.get("wheel", "")
    if not wheel_name or Path(wheel_name).name != wheel_name:
        raise SystemExit("Core provenance has an invalid wheel filename")
    wheel = args.wheel or WHEEL_DIR / wheel_name
    snapshot = args.snapshot or WHEEL_DIR / snapshot_name
    if wheel.name != wheel_name:
        raise SystemExit(f"Core wheel path does not match the pin: expected {wheel_name}, got {wheel.name}")
    if snapshot.name != snapshot_name:
        raise SystemExit(f"Core source snapshot path does not match the pin: expected {snapshot_name}, got {snapshot.name}")
    if not wheel.is_file():
        raise SystemExit(f"Core wheel is missing: {wheel}")
    if not snapshot.is_file():
        raise SystemExit(f"Core source snapshot is missing: {snapshot}")
    snapshot_digest = sha256(snapshot)
    expected_snapshot_digest = snapshot_record.get("sha256")
    if not re.fullmatch(r"[0-9a-f]{64}", str(expected_snapshot_digest)) or snapshot_digest != expected_snapshot_digest:
        raise SystemExit(f"Core source snapshot SHA-256 mismatch: expected {expected_snapshot_digest}, got {snapshot_digest}")
    try:
        with tarfile.open(snapshot, "r:gz") as archive:
            members = archive.getmembers()
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f"Core source snapshot is not a readable gzip tar archive: {error}") from error
    member_names = [member.name for member in members]
    if len(member_names) != len(set(member_names)) or any(not member.isfile() for member in members):
        raise SystemExit("Core source snapshot contains duplicate or non-file entries")
    source_files = set(member_names)
    required_source = {
        "pyproject.toml",
        "README.md",
        "LICENSE",
        "NOTICE",
        "astro_survey_moc_core/__init__.py",
        "astro_survey_moc_core/cli.py",
        "astro_survey_moc_core/contract.py",
        "astro_survey_moc_core/core.py",
        "astro_survey_moc_core/resource_package.py",
        "astro_survey_moc_core/task_contract.py",
    }
    declared_source_files = snapshot_record.get("files")
    if not isinstance(declared_source_files, list) or not all(isinstance(name, str) for name in declared_source_files):
        raise SystemExit("Core source snapshot file list is missing or malformed")
    allowed_source_files = {"pyproject.toml", "README.md", "LICENSE", "NOTICE"}
    if any(
        not re.fullmatch(r"astro_survey_moc_core/[A-Za-z0-9_]+\.py", name)
        for name in source_files - allowed_source_files
    ):
        raise SystemExit("Core source snapshot contains files outside the public build inputs")
    if source_files != set(declared_source_files) or not required_source.issubset(source_files):
        raise SystemExit("Core source snapshot contents do not match the declared build inputs")
    digest = sha256(wheel)
    expected = source["wheelSha256"]
    if not re.fullmatch(r"[0-9a-f]{64}", str(expected)) or digest != expected:
        raise SystemExit(f"Core wheel SHA-256 mismatch: expected {expected}, got {digest}")
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        required = {
            "astro_survey_moc_core/__init__.py",
            "astro_survey_moc_core/cli.py",
            "astro_survey_moc_core/core.py",
            "astro_survey_moc_core/resource_package.py",
        }
        if not required.issubset(names):
            raise SystemExit("Core wheel does not contain the expected package")
        metadata_paths = [name for name in names if name.endswith(".dist-info/METADATA")]
        if len(metadata_paths) != 1:
            raise SystemExit("Core wheel must contain exactly one distribution METADATA file")
        metadata = email.message_from_bytes(archive.read(metadata_paths[0]))
        if metadata.get("Name", "").lower() != source["package"].lower() or metadata.get("Version") != source["version"]:
            raise SystemExit("Core wheel package identity does not match the pin")
    build = source.get("build", {})
    if build.get("reproducedFromSnapshot") is not True or not isinstance(build.get("sourceDateEpoch"), int):
        raise SystemExit("Core provenance does not record a reproducible snapshot build")
    for key in ("python", "pip", "setuptools", "command"):
        if not isinstance(build.get(key), str) or not build[key]:
            raise SystemExit(f"Core provenance is missing build environment field: {key}")
    print(
        f"Core wheel verified: {source['package']}=={source['version']} wheel-sha256={digest}; "
        f"source-snapshot={snapshot_name} sha256={snapshot_digest}; dirty worktree based on {base_commit}"
    )


if __name__ == "__main__":
    main()
