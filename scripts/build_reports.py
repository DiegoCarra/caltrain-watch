#!/usr/bin/env python3
"""Build the crowd-report explanation snapshot for Why is the Caltrain late?."""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

MARKER = "<!-- why-caltrain-late-report:v1 -->"
CATEGORY_LABELS = {
    "held": "held / not moving",
    "train-traffic": "train traffic or waiting for another train",
    "signal": "signal or dispatch issue",
    "crossing": "crossing or track obstruction",
    "police-fire": "police or fire activity",
    "medical": "medical emergency",
    "mechanical": "mechanical or equipment issue",
    "boarding": "long boarding or crowding",
    "unknown": "delay confirmed; cause unknown",
}
SOURCE_LABELS = {
    "crew-announcement": "Crew announcement",
    "station-board": "Station board",
    "visual": "Direct observation",
    "other-rider": "Other rider",
    "other": "Rider report",
}
FIELD_RE = re.compile(r"^(Train|Station|Category|Source|Delay minutes|Observed at):\s*(.*)$", re.MULTILINE)


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def clean(value: Any, limit: int = 500) -> str:
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value or "")).strip()[:limit]


def parse_report(issue: dict[str, Any], now: datetime) -> dict[str, Any] | None:
    body = issue.get("body") or ""
    if MARKER not in body:
        return None
    fields = {name: clean(value, 120) for name, value in FIELD_RE.findall(body)}
    train = fields.get("Train", "")
    station = fields.get("Station", "")
    category = fields.get("Category", "")
    source = fields.get("Source", "")
    if not re.fullmatch(r"\d{1,6}", train) or not station or category not in CATEGORY_LABELS or source not in SOURCE_LABELS:
        return None
    observed = parse_iso(fields.get("Observed at")) or parse_iso(issue.get("created_at")) or now
    if observed > now + timedelta(minutes=15) or observed < now - timedelta(hours=8):
        return None
    delay = None
    raw_delay = fields.get("Delay minutes", "")
    if raw_delay:
        try:
            delay = max(0, min(360, int(float(raw_delay))))
        except ValueError:
            delay = None
    details_match = re.search(r"\nDetails:\s*\n(.*?)(?:\n\n_|\Z)", body, flags=re.DOTALL)
    details = clean(details_match.group(1) if details_match else "", 500)
    if details == "(none)":
        details = ""
    reactions = issue.get("reactions") or {}
    return {
        "id": issue.get("number"),
        "url": issue.get("html_url"),
        "trainNumber": train,
        "station": station,
        "category": category,
        "categoryLabel": CATEGORY_LABELS[category],
        "source": source,
        "sourceLabel": SOURCE_LABELS[source],
        "delayMinutes": delay,
        "details": details,
        "observedAt": observed.isoformat().replace("+00:00", "Z"),
        "createdAt": clean(issue.get("created_at"), 40),
        "upvotes": int(reactions.get("+1", 0) or 0),
        "reporter": clean((issue.get("user") or {}).get("login"), 80),
    }


def fetch_issues(repository: str, token: str | None) -> list[dict[str, Any]]:
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    issues: list[dict[str, Any]] = []
    for page in range(1, 4):
        response = requests.get(
            f"https://api.github.com/repos/{repository}/issues",
            params={"state": "open", "per_page": 100, "page": page, "sort": "created", "direction": "desc"},
            headers=headers,
            timeout=20,
        )
        response.raise_for_status()
        batch = response.json()
        issues.extend(item for item in batch if "pull_request" not in item)
        if len(batch) < 100:
            break
    return issues


def official_delay(trip: dict[str, Any]) -> int:
    delays: list[int] = []
    for stop in trip.get("stops", []):
        live = stop.get("realtimeDepartureEpoch") or stop.get("realtimeArrivalEpoch")
        scheduled = stop.get("departureEpoch") if stop.get("realtimeDepartureEpoch") else stop.get("arrivalEpoch")
        if live and scheduled:
            delays.append(max(0, round((live - scheduled) / 60)))
    return max(delays, default=0)


def direction(trip: dict[str, Any] | None) -> str:
    if not trip or not trip.get("stops"):
        return "unknown direction"
    destination = clean(trip["stops"][-1].get("name"), 80).lower()
    if "san francisco" in destination:
        return "northbound"
    if any(name in destination for name in ("san jose", "tamien", "gilroy")):
        return "southbound"
    return f"toward {trip['stops'][-1].get('name', 'destination')}"


def matching_alerts(data: dict[str, Any], trip: dict[str, Any] | None) -> list[dict[str, str]]:
    if not trip:
        return []
    matches = []
    for alert in data.get("alerts", []):
        if trip.get("id") in alert.get("tripIds", []) or trip.get("routeId") in alert.get("routeIds", []):
            matches.append({"header": clean(alert.get("header"), 180), "description": clean(alert.get("description"), 300)})
    return matches[:3]


def build_reason(category: str, station: str, count: int, total: int) -> str:
    if category == "unknown":
        return f"Riders confirm the delay near {station}, but not the cause"
    label = CATEGORY_LABELS.get(category, "a service issue")
    if total > 1 and count / total < 0.6:
        return f"Conflicting rider reports near {station}"
    prefix = "Likely" if count < 3 else "Rider consensus:"
    return f"{prefix} {label} near {station}"


def build_summary(count: int, category: str, station: str, crowd_delay: int | None, official: int, alerts: list[dict[str, str]]) -> str:
    parts = [f"{count} recent rider report{'s' if count != 1 else ''} cluster around {station} and point to {CATEGORY_LABELS.get(category, 'a delay')}." ]
    if crowd_delay is not None and official:
        gap = crowd_delay - official
        if gap >= 8:
            parts.append(f"Riders are observing about {crowd_delay} minutes late while the official feed shows {official}, so the public estimate may be lagging.")
        elif gap <= -8:
            parts.append(f"The official feed shows {official} minutes while rider reports average closer to {crowd_delay}; the train may be recovering time or reports may be stale.")
        else:
            parts.append(f"Rider timing and the official feed broadly agree at roughly {max(crowd_delay, official)} minutes late.")
    elif crowd_delay is not None:
        parts.append(f"Riders estimate the train is about {crowd_delay} minutes late.")
    elif official:
        parts.append(f"The official feed currently shows about {official} minutes late.")
    if alerts:
        parts.append("An official service alert also matches this train or route.")
    return " ".join(parts)


def confidence(reports: list[dict[str, Any]], category: str, alerts: list[dict[str, str]], official: int, crowd_delay: int | None) -> float:
    score = 0.22
    score += min(0.36, 0.14 * max(0, len(reports) - 1))
    independent_sources = len({report["source"] for report in reports})
    score += min(0.12, 0.04 * max(0, independent_sources - 1))
    station_votes = Counter(report["station"].lower() for report in reports)
    if station_votes and station_votes.most_common(1)[0][1] >= 2:
        score += 0.08
    category_votes = Counter(report["category"] for report in reports)
    if category != "unknown" and category_votes[category] >= 2:
        score += 0.08
    consensus_ratio = category_votes[category] / max(1, len(reports))
    if len(reports) > 1 and consensus_ratio < 0.6:
        score -= 0.14
    score += min(0.09, 0.03 * sum(report.get("upvotes", 0) for report in reports))
    if alerts:
        score += 0.20
    if official and crowd_delay is not None and abs(official - crowd_delay) <= 10:
        score += 0.08
    if category == "unknown":
        score -= 0.08
    return round(max(0.05, min(0.95, score)), 2)


def build_snapshot(issues: list[dict[str, Any]], caltrain: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    raw_parsed = [report for issue in issues if (report := parse_report(issue, now))]
    # A single GitHub account gets one active vote per train. Keep its newest observation.
    latest_by_reporter: dict[tuple[str, str], dict[str, Any]] = {}
    for report in raw_parsed:
        reporter = report.get("reporter") or f"issue-{report.get('id')}"
        key = (report["trainNumber"], reporter)
        prior = latest_by_reporter.get(key)
        if prior is None or report["observedAt"] > prior["observedAt"]:
            latest_by_reporter[key] = report
    parsed = list(latest_by_reporter.values())
    trips_by_number = {str(trip.get("trainNumber")): trip for trip in caltrain.get("trips", [])}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for report in parsed:
        grouped[report["trainNumber"]].append(report)

    incidents = []
    for train_number, train_reports in grouped.items():
        train_reports.sort(key=lambda report: report["observedAt"], reverse=True)
        trip = trips_by_number.get(train_number)
        alerts = matching_alerts(caltrain, trip)
        off_delay = official_delay(trip or {})
        delay_values = [report["delayMinutes"] for report in train_reports if report["delayMinutes"] is not None]
        crowd_delay = round(statistics.median(delay_values)) if delay_values else None
        categories = Counter(report["category"] for report in train_reports)
        category = categories.most_common(1)[0][0]
        stations = Counter(report["station"] for report in train_reports)
        station = stations.most_common(1)[0][0]
        consensus = categories[category]
        incidents.append({
            "trainNumber": train_number,
            "tripId": trip.get("id") if trip else None,
            "direction": direction(trip),
            "station": station,
            "category": category,
            "reason": build_reason(category, station, consensus, len(train_reports)),
            "summary": build_summary(len(train_reports), category, station, crowd_delay, off_delay, alerts),
            "confidence": confidence(train_reports, category, alerts, off_delay, crowd_delay),
            "consensusCount": consensus,
            "officialDelayMinutes": off_delay,
            "crowdDelayMinutes": crowd_delay,
            "officialAlerts": alerts,
            "reports": train_reports[:12],
        })
    incidents.sort(key=lambda item: (item["confidence"], item["crowdDelayMinutes"] or item["officialDelayMinutes"] or 0), reverse=True)
    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "reportCount": len(parsed),
        "incidents": incidents,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--caltrain", default="public/data/caltrain.json")
    parser.add_argument("--output", default="public/why/reports.json")
    parser.add_argument("--repository", default=os.getenv("GITHUB_REPOSITORY", "DiegoCarra/caltrain-watch"))
    args = parser.parse_args()
    caltrain = json.loads(Path(args.caltrain).read_text())
    token = os.getenv("GITHUB_TOKEN")
    issues = fetch_issues(args.repository, token)
    snapshot = build_snapshot(issues, caltrain)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(snapshot, indent=2) + "\n")
    print(f"Wrote {snapshot['reportCount']} recent rider reports across {len(snapshot['incidents'])} trains to {output}")


if __name__ == "__main__":
    main()
