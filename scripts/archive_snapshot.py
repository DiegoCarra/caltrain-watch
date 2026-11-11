#!/usr/bin/env python3
"""Keep a weekly real snapshot in source so the scheduled site stays active."""
from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

SNAPSHOT = "public/data/caltrain.json"


def should_archive(previous: dict, current: dict) -> bool:
    if current.get("mode") != "live" or not current.get("trips"):
        return False
    try:
        age = datetime.fromisoformat(current["generatedAt"]) - datetime.fromisoformat(previous["generatedAt"])
        return age >= timedelta(days=7)
    except (KeyError, TypeError, ValueError):
        return True


def main() -> None:
    previous = json.loads(subprocess.check_output(["git", "show", f"HEAD:{SNAPSHOT}"], text=True))
    current = json.loads(Path(SNAPSHOT).read_text())
    if not should_archive(previous, current):
        print("The archived official snapshot is still recent; no commit needed.")
        return
    for command in (
        ["git", "config", "user.name", "github-actions[bot]"],
        ["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
        ["git", "add", "--", SNAPSHOT],
        ["git", "commit", "-m", "Archive weekly official Caltrain snapshot [skip ci]"],
        ["git", "push", "origin", "HEAD:main"],
    ):
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
