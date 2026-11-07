#!/usr/bin/env python3
"""Read or update the GitHub repository description, topics and homepage.

    python3 scripts/github-metadata.py --show
    python3 scripts/github-metadata.py --description "..." --topics astronomy,healpix

The repository is fixed to Astro-Survey-Atlas/Assets and only the three
metadata fields below can be written, so this helper cannot be pointed at
another repository or used to change code, releases or secrets. The token is
read from the git credential helper inside this process and never printed.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "Astro-Survey-Atlas/Assets"
API = f"https://api.github.com/repos/{REPO}"
TOPIC = re.compile(r"^[a-z0-9][a-z0-9-]{0,49}$")
MAX_TOPICS = 20


def token() -> str:
    filled = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
    )
    if filled.returncode != 0:
        sys.exit("git credential fill failed")
    for line in filled.stdout.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    sys.exit("the git credential helper returned no token for github.com")


def call(method: str, payload: dict | None = None, path: str = "") -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "assets-repo-metadata"}
    data = None
    if payload is not None:
        headers["Authorization"] = f"Bearer {token()}"
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    request = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:400]
        sys.exit(f"GitHub returned HTTP {error.code}: {detail}")


def report(body: dict) -> None:
    print(f"repository:  {body.get('full_name') or REPO}")
    print(f"description: {body.get('description')}")
    print(f"homepage:    {body.get('homepage')}")
    print(f"topics:      {', '.join(body.get('topics') or body.get('names') or []) or '(none)'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--show", action="store_true", help="print the current metadata")
    parser.add_argument("--description", help="one-sentence repository description")
    parser.add_argument("--topics", help="comma-separated topics, e.g. astronomy,healpix")
    parser.add_argument("--homepage", help="project URL")
    args = parser.parse_args()

    if args.show and not any((args.description, args.topics, args.homepage)):
        report(call("GET"))
        return 0

    payload: dict[str, object] = {}
    if args.description is not None:
        if not args.description.strip() or len(args.description) > 350:
            sys.exit("description must be 1-350 characters")
        payload["description"] = args.description.strip()
    if args.homepage is not None and args.homepage and not args.homepage.startswith("https://"):
        sys.exit("homepage must be an https:// URL")
    if args.homepage is not None:
        payload["homepage"] = args.homepage
    topics: list[str] | None = None
    if args.topics is not None:
        topics = [topic.strip() for topic in args.topics.split(",") if topic.strip()]
        bad = [topic for topic in topics if not TOPIC.match(topic)]
        if bad:
            sys.exit(f"invalid topics (lowercase letters, digits, hyphens only): {', '.join(bad)}")
        if len(topics) > MAX_TOPICS:
            sys.exit(f"GitHub allows at most {MAX_TOPICS} topics")
    if not payload and topics is None:
        sys.exit("nothing to update; pass --description, --topics or --homepage")

    # Topics live on their own endpoint; PATCH /repos silently ignores `topics`.
    if topics is not None:
        call("PUT", {"names": topics}, "/topics")
    body = call("PATCH", payload) if payload else call("GET")
    if topics is not None:
        body["topics"] = topics
    report(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
