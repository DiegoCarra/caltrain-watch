#!/usr/bin/env python3
"""Build the static JSON snapshot used by Caltrain Watch."""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import zipfile
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests
from google.transit import gtfs_realtime_pb2

PACIFIC = ZoneInfo("America/Los_Angeles")
BASE_URL = "https://api.511.org/transit"
DEFAULT_OPERATOR_ID = "CT"


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y%m%d").date()


def gtfs_epoch(service_date: date, value: str) -> int:
    hours, minutes, seconds = (int(part) for part in value.split(":"))
    day_offset, hours = divmod(hours, 24)
    moment = datetime.combine(service_date + timedelta(days=day_offset), time(hours, minutes, seconds), PACIFIC)
    return int(moment.timestamp())


def csv_rows(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    try:
        content = archive.read(name).decode("utf-8-sig")
    except KeyError:
        return []
    return list(csv.DictReader(io.StringIO(content)))


def parse_gtfs(payload: bytes) -> dict[str, list[dict[str, str]]]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {name.removesuffix(".txt"): csv_rows(archive, name) for name in (
            "stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"
        )}


def active_services(feed: dict[str, list[dict[str, str]]], service_date: date) -> set[str]:
    weekday = service_date.strftime("%A").lower()
    active: set[str] = set()
    for row in feed["calendar"]:
        if parse_date(row["start_date"]) <= service_date <= parse_date(row["end_date"]) and row.get(weekday) == "1":
            active.add(row["service_id"])
    for row in feed["calendar_dates"]:
        if parse_date(row["date"]) != service_date:
            continue
        if row["exception_type"] == "1":
            active.add(row["service_id"])
        elif row["exception_type"] == "2":
            active.discard(row["service_id"])
    return active


def translated(field: Any) -> str:
    translations = list(getattr(field, "translation", []))
    if not translations:
        return ""
    english = next((item.text for item in translations if getattr(item, "language", "") == "en"), None)
    return english or translations[0].text


def parse_updates(payload: bytes) -> dict[str, dict[str, Any]]:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)
    result: dict[str, dict[str, Any]] = {}
    for entity in feed.entity:
        if not entity.HasField("trip_update"):
            continue
        update = entity.trip_update
        trip_id = update.trip.trip_id
        if not trip_id:
            continue
        stops: dict[str, dict[str, Any]] = {}
        for stop in update.stop_time_update:
            if not stop.stop_id:
                continue
            item: dict[str, Any] = {"skipped": int(stop.schedule_relationship) == 1}
            if stop.HasField("arrival"):
                if stop.arrival.time:
                    item["arrival"] = int(stop.arrival.time)
                if stop.arrival.delay:
                    item["arrivalDelay"] = int(stop.arrival.delay)
            if stop.HasField("departure"):
                if stop.departure.time:
                    item["departure"] = int(stop.departure.time)
                if stop.departure.delay:
                    item["departureDelay"] = int(stop.departure.delay)
            stops[stop.stop_id] = item
        result[trip_id] = {
            "cancelled": int(update.trip.schedule_relationship) == 3,
            "stops": stops,
        }
    return result


def parse_alerts(payload: bytes, parent: dict[str, str]) -> list[dict[str, Any]]:
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(payload)
    alerts: list[dict[str, Any]] = []
    for entity in feed.entity:
        if not entity.HasField("alert"):
            continue
        alert = entity.alert
        stop_ids: set[str] = set()
        route_ids: set[str] = set()
        trip_ids: set[str] = set()
        for target in alert.informed_entity:
            if target.stop_id:
                stop_ids.add(parent.get(target.stop_id, target.stop_id))
            if target.route_id:
                route_ids.add(target.route_id)
            if target.HasField("trip") and target.trip.trip_id:
                trip_ids.add(target.trip.trip_id)
        try:
            effect = gtfs_realtime_pb2.Alert.Effect.Name(int(alert.effect))
        except ValueError:
            effect = "UNKNOWN_EFFECT"
        alerts.append({
            "id": entity.id or f"alert-{len(alerts) + 1}",
            "header": translated(alert.header_text),
            "description": translated(alert.description_text),
            "url": translated(alert.url),
            "effect": effect,
            "stopIds": sorted(stop_ids),
            "routeIds": sorted(route_ids),
            "tripIds": sorted(trip_ids),
        })
    return alerts


def build_live(gtfs_bytes: bytes, updates_bytes: bytes, alerts_bytes: bytes, now: datetime | None = None) -> dict[str, Any]:
    now = (now or datetime.now(PACIFIC)).astimezone(PACIFIC)
    service_date = now.date()
    feed = parse_gtfs(gtfs_bytes)
    active = active_services(feed, service_date)
    has_calendar = bool(feed["calendar"] or feed["calendar_dates"])
    routes = {row["route_id"]: row for row in feed["routes"]}
    stops_by_id = {row["stop_id"]: row for row in feed["stops"]}
    parent = {row["stop_id"]: row.get("parent_station") or row["stop_id"] for row in feed["stops"]}
    updates = parse_updates(updates_bytes)

    times: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in feed["stop_times"]:
        times[row["trip_id"]].append(row)
    for rows in times.values():
        rows.sort(key=lambda row: int(row["stop_sequence"]))

    output_trips: list[dict[str, Any]] = []
    used_stations: set[str] = set()
    for trip in feed["trips"]:
        if has_calendar and trip["service_id"] not in active:
            continue
        realtime = updates.get(trip["trip_id"], {"cancelled": False, "stops": {}})
        trip_stops: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in times.get(trip["trip_id"], []):
            platform_id = row["stop_id"]
            station_id = parent.get(platform_id, platform_id)
            if station_id in seen:
                continue
            seen.add(station_id)
            used_stations.add(station_id)
            station = stops_by_id.get(station_id) or stops_by_id.get(platform_id, {})
            scheduled_arrival = gtfs_epoch(service_date, row["arrival_time"])
            scheduled_departure = gtfs_epoch(service_date, row["departure_time"])
            live = realtime["stops"].get(platform_id) or realtime["stops"].get(station_id) or {}
            live_arrival = live.get("arrival")
            live_departure = live.get("departure")
            if live_arrival is None and live.get("arrivalDelay") is not None:
                live_arrival = scheduled_arrival + live["arrivalDelay"]
            if live_departure is None and live.get("departureDelay") is not None:
                live_departure = scheduled_departure + live["departureDelay"]
            trip_stops.append({
                "id": station_id,
                "name": station.get("stop_name") or station_id,
                "sequence": int(row["stop_sequence"]),
                "arrivalEpoch": scheduled_arrival,
                "departureEpoch": scheduled_departure,
                "realtimeArrivalEpoch": live_arrival,
                "realtimeDepartureEpoch": live_departure,
                "skipped": bool(live.get("skipped")),
            })
        if len(trip_stops) < 2:
            continue
        route = routes.get(trip["route_id"], {})
        output_trips.append({
            "id": trip["trip_id"],
            "routeId": trip["route_id"],
            "routeShortName": route.get("route_short_name") or "Caltrain",
            "routeLongName": route.get("route_long_name") or "",
            "trainNumber": trip.get("trip_short_name") or trip.get("trip_headsign") or trip["trip_id"],
            "headsign": trip.get("trip_headsign") or trip_stops[-1]["name"],
            "directionId": int(trip.get("direction_id") or 0),
            "cancelled": bool(realtime["cancelled"]),
            "stops": trip_stops,
        })

    longest = max(output_trips, key=lambda trip: len(trip["stops"]), default=None)
    ordering = {stop["id"]: index for index, stop in enumerate(longest["stops"] if longest else [])}
    output_stops = []
    for station_id in used_stations:
        row = stops_by_id.get(station_id, {})
        output_stops.append({
            "id": station_id,
            "name": row.get("stop_name") or station_id,
            "lat": float(row["stop_lat"]) if row.get("stop_lat") else None,
            "lon": float(row["stop_lon"]) if row.get("stop_lon") else None,
            "order": ordering.get(station_id, 9999),
        })
    output_stops.sort(key=lambda stop: (stop["order"], stop["name"]))
    output_trips.sort(key=lambda trip: trip["stops"][0]["departureEpoch"])
    return {
        "schemaVersion": 1,
        "mode": "live",
        "generatedAt": now.isoformat(),
        "serviceDate": service_date.isoformat(),
        "operatorId": os.getenv("TRANSIT_511_OPERATOR_ID", DEFAULT_OPERATOR_ID),
        "notice": "",
        "stops": output_stops,
        "trips": output_trips,
        "alerts": parse_alerts(alerts_bytes, parent),
    }


def build_demo(now: datetime | None = None) -> dict[str, Any]:
    now = (now or datetime.now(PACIFIC)).replace(second=0, microsecond=0)
    stops = [
        {"id": "SF", "name": "San Francisco", "order": 0},
        {"id": "MILL", "name": "Millbrae", "order": 1},
        {"id": "SM", "name": "San Mateo", "order": 2},
        {"id": "HILLS", "name": "Hillsdale", "order": 3},
        {"id": "PA", "name": "Palo Alto", "order": 4},
        {"id": "SJ", "name": "San Jose Diridon", "order": 5},
    ]
    offsets = [0, 24, 34, 42, 58, 78]
    def trip(index: int, start: int, delay: int = 0, cancelled: bool = False) -> dict[str, Any]:
        departure = now + timedelta(minutes=start)
        trip_stops = []
        for stop, offset in zip(stops, offsets):
            scheduled = int((departure + timedelta(minutes=offset)).timestamp())
            realtime = scheduled + delay * 60 if delay else None
            trip_stops.append({"id": stop["id"], "name": stop["name"], "sequence": offset, "arrivalEpoch": scheduled, "departureEpoch": scheduled, "realtimeArrivalEpoch": realtime, "realtimeDepartureEpoch": realtime, "skipped": False})
        return {"id": f"demo-{index}", "routeId": "CALTRAIN", "routeShortName": "Caltrain", "routeLongName": "San Francisco – San Jose", "trainNumber": str(500 + index * 2), "headsign": "San Jose Diridon", "directionId": 0, "cancelled": cancelled, "stops": trip_stops}
    return {
        "schemaVersion": 1,
        "mode": "demo",
        "generatedAt": now.isoformat(),
        "serviceDate": now.date().isoformat(),
        "operatorId": DEFAULT_OPERATOR_ID,
        "notice": "Demo data is shown until the TRANSIT_511_API_KEY repository secret is configured.",
        "stops": stops,
        "trips": [trip(1, 12), trip(2, 37, 8), trip(3, 62, cancelled=True), trip(4, 92)],
        "alerts": [{"id": "demo-alert", "header": "Demo: Train 506 cancelled", "description": "This sample demonstrates route-specific cancellation alerts.", "url": "https://www.caltrain.com/status", "effect": "NO_SERVICE", "stopIds": ["SF", "HILLS"], "tripIds": ["demo-3"], "routeIds": ["CALTRAIN"]}],
    }


def fetch(session: requests.Session, endpoint: str, params: dict[str, str]) -> bytes:
    response = session.get(f"{BASE_URL}/{endpoint}", params=params, timeout=(10, 45))
    response.raise_for_status()
    if not response.content:
        raise RuntimeError(f"Empty response from {endpoint}")
    return response.content


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("public/data/caltrain.json"))
    parser.add_argument("--demo", action="store_true")
    args = parser.parse_args()
    api_key = os.getenv("TRANSIT_511_API_KEY", "").strip()
    operator = os.getenv("TRANSIT_511_OPERATOR_ID", DEFAULT_OPERATOR_ID).strip() or DEFAULT_OPERATOR_ID
    if args.demo or not api_key:
        snapshot = build_demo()
    else:
        session = requests.Session()
        session.headers["User-Agent"] = "caltrain-watch/1.0"
        common = {"api_key": api_key}
        snapshot = build_live(
            fetch(session, "datafeeds", {**common, "operator_id": operator}),
            fetch(session, "tripupdates", {**common, "agency": operator}),
            fetch(session, "servicealerts", {**common, "agency": operator}),
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output} ({snapshot['mode']}, {len(snapshot['trips'])} trips)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
