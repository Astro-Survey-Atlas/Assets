"""Command line contract for the Assets MOC Core."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any

from .contract import CORE_VERSION, normalize_spec
from .core import build_layer, canonical_cells, canonical_json, project_cells, read_moc_fits, write_moc_fits
from .resource_package import build_resource_package, validate_resource_package


def _json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f".{target.name}.", delete=False) as handle:
            temporary = handle.name
            handle.write(canonical_json(value) + b"\n")
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def _refresh(args: argparse.Namespace) -> dict[str, Any]:
    spec = _json(args.spec)
    normalize_spec(spec)
    source_url = spec.get("sourceUrl")
    if not isinstance(source_url, str) or not source_url.startswith(("https://", "http://")):
        raise ValueError("refresh requires an HTTP(S) sourceUrl")
    parsed_url = urlsplit(source_url)
    if parsed_url.username is not None or parsed_url.password is not None:
        raise ValueError("refresh sourceUrl must not contain credentials")
    if args.timeout <= 0 or args.max_bytes <= 0:
        raise ValueError("refresh limits must be positive")
    snapshot_dir = Path(args.snapshot_dir)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(urlsplit(source_url).path).suffix
    target = snapshot_dir / f"{spec['layerId']}{suffix or '.source'}"
    digest = hashlib.sha256()
    size = 0
    request = urllib.request.Request(source_url, headers={"User-Agent": f"astro-survey-moc-core/{CORE_VERSION}"})
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=snapshot_dir, prefix=f".{spec['layerId']}.", delete=False) as output:
            temporary = output.name
            with urllib.request.urlopen(request, timeout=args.timeout) as response:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    if size > args.max_bytes:
                        raise ValueError("Snapshot exceeds --max-bytes")
                    digest.update(chunk)
                    output.write(chunk)
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    spec["input"] = target.name
    spec["snapshot"] = {"sha256": digest.hexdigest(), "sizeBytes": size, "sourceUrl": source_url}
    _write_json(args.lock, spec)
    return {"snapshot": str(target), "lock": args.lock, "sha256": digest.hexdigest(), "sizeBytes": size}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="astro-survey-moc-core")
    parser.add_argument("--version", action="version", version=CORE_VERSION)
    sub = parser.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate-spec", help="validate and normalize a coverage spec")
    validate.add_argument("spec")

    refresh = sub.add_parser("refresh", help="the only command allowed to access the network")
    refresh.add_argument("--spec", required=True)
    refresh.add_argument("--snapshot-dir", required=True)
    refresh.add_argument("--lock", required=True)
    refresh.add_argument("--timeout", type=float, default=60)
    refresh.add_argument("--max-bytes", type=int, default=2 * 1024 * 1024 * 1024)

    build = sub.add_parser("build", help="build a MOC and fixed-order projections from local input")
    build.add_argument("--spec", required=True)
    build.add_argument("--output", required=True)
    build.add_argument("--base-dir", default=".")
    build.add_argument("--rebuild", action="store_true")

    rebuild = sub.add_parser("rebuild", help="offline rebuild from a SHA-256 locked local snapshot")
    rebuild.add_argument("--spec", required=True)
    rebuild.add_argument("--output", required=True)
    rebuild.add_argument("--base-dir", default=".")

    rebuild_public = sub.add_parser("rebuild-public", help="offline rebuild of all locked Assets public layers")
    rebuild_public.add_argument("--plan", default="src/layers/public-build-plan.json")
    rebuild_public.add_argument("--base-dir", default=".")

    merge = sub.add_parser("merge", help="merge partial FITS MOCs in stable path order")
    merge.add_argument("--input", action="append", required=True)
    merge.add_argument("--output", required=True)
    merge.add_argument("--max-order", type=int, default=10)

    project = sub.add_parser("project", help="derive one fixed-order NESTED index from FITS MOC")
    project.add_argument("--moc", required=True)
    project.add_argument("--order", type=int, required=True)
    project.add_argument("--output", required=True)

    package = sub.add_parser("package", help="build or validate Resource Package v3")
    package_sub = package.add_subparsers(dest="package_command", required=True)
    package_build = package_sub.add_parser("build")
    package_build.add_argument("--spec", required=True)
    package_build.add_argument("--output", required=True)
    package_build.add_argument("--base-dir", default=".")
    package_validate = package_sub.add_parser("validate")
    package_validate.add_argument("archive")
    package_validate.add_argument("--public-catalog")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "validate-spec":
            result: Any = normalize_spec(_json(args.spec)).as_dict()
        elif args.command == "refresh":
            result = _refresh(args)
        elif args.command in {"build", "rebuild"}:
            built = build_layer(_json(args.spec), args.output, base_dir=args.base_dir, rebuild=args.command == "rebuild" or getattr(args, "rebuild", False))
            result = {"layerId": built.layer_id, "moc": str(built.moc_path), "sha256": built.sha256, "cells": len(built.cells)}
        elif args.command == "rebuild-public":
            plan = _json(args.plan)
            if plan.get("schemaVersion") != 1 or not isinstance(plan.get("builds"), list):
                raise ValueError("Unsupported public build plan")
            base = Path(args.base_dir)
            expected_epoch = str(plan.get("sourceDateEpoch"))
            if os.environ.get("SOURCE_DATE_EPOCH") != expected_epoch:
                raise ValueError(f"SOURCE_DATE_EPOCH must be {expected_epoch}")
            builds = []
            for entry in sorted(plan["builds"], key=lambda value: value["spec"]):
                built = build_layer(_json(base / entry["spec"]), base / entry["output"], base_dir=base, rebuild=True)
                expected_sha256 = entry.get("expectedSha256")
                if expected_sha256 is not None and built.sha256 != expected_sha256:
                    raise ValueError(f"Public layer hash mismatch for {built.layer_id}: expected {expected_sha256}, got {built.sha256}")
                builds.append({"layerId": built.layer_id, "sha256": built.sha256, "cells": len(built.cells)})
            result = {"builds": builds, "coreVersion": CORE_VERSION}
        elif args.command == "merge":
            cells = canonical_cells((cell for path in sorted(args.input) for cell in read_moc_fits(path)), max_order=args.max_order)
            digest = write_moc_fits(args.output, cells, max_order=args.max_order)
            result = {"moc": args.output, "sha256": digest, "cells": len(cells)}
        elif args.command == "project":
            pixels = project_cells(read_moc_fits(args.moc), args.order)
            _write_json(args.output, {"schemaVersion": 1, "order": args.order, "ordering": "NESTED", "pixels": pixels})
            result = {"output": args.output, "pixels": len(pixels)}
        elif args.package_command == "build":
            package = build_resource_package(_json(args.spec), args.output, base_dir=args.base_dir)
            result = {"archive": args.output, "sha256": package.archive_sha256, "entries": len(package.entries)}
        else:
            catalog = _json(args.public_catalog) if args.public_catalog else None
            package = validate_resource_package(args.archive, require_public_catalog=catalog)
            result = {"id": package.manifest["id"], "version": package.manifest["version"], "sha256": package.archive_sha256}
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
