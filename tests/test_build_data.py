from __future__ import annotations

import importlib.util
import io
import sys
import unittest
import zipfile
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT = Path(__file__).parents[1] / "scripts" / "build_data.py"
spec = importlib.util.spec_from_file_location("build_data", SCRIPT)
build_data = importlib.util.module_from_spec(spec)
assert spec.loader
sys.modules[spec.name] = build_data
spec.loader.exec_module(build_data)


class BuildDataTests(unittest.TestCase):
    def test_gtfs_time_after_midnight(self):
        epoch = build_data.gtfs_epoch(date(2026, 7, 14), "25:12:30")
        moment = datetime.fromtimestamp(epoch, ZoneInfo("America/Los_Angeles"))
        self.assertEqual((moment.day, moment.hour, moment.minute, moment.second), (15, 1, 12, 30))

    def test_calendar_exceptions_override_weekday(self):
        feed = {
            "calendar": [{
                "service_id": "weekday", "monday": "1", "tuesday": "1", "wednesday": "1",
                "thursday": "1", "friday": "1", "saturday": "0", "sunday": "0",
                "start_date": "20260101", "end_date": "20261231",
            }],
            "calendar_dates": [
                {"service_id": "weekday", "date": "20260714", "exception_type": "2"},
                {"service_id": "special", "date": "20260714", "exception_type": "1"},
            ],
        }
        self.assertEqual(build_data.active_services(feed, date(2026, 7, 14)), {"special"})

    def test_demo_snapshot_is_usable(self):
        now = datetime(2026, 7, 14, 8, 0, tzinfo=ZoneInfo("America/Los_Angeles"))
        snapshot = build_data.build_demo(now)
        self.assertEqual(snapshot["mode"], "demo")
        self.assertGreaterEqual(len(snapshot["stops"]), 5)
        self.assertTrue(any(trip["cancelled"] for trip in snapshot["trips"]))

    def test_parse_minimal_gtfs_zip(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("stops.txt", "stop_id,stop_name\nA,Alpha\n")
            archive.writestr("routes.txt", "route_id,route_short_name\nR,Rail\n")
            archive.writestr("trips.txt", "route_id,service_id,trip_id\nR,S,T\n")
            archive.writestr("stop_times.txt", "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,08:00:00,08:00:00,A,1\n")
        self.assertEqual(build_data.parse_gtfs(buffer.getvalue())["stops"][0]["stop_name"], "Alpha")


if __name__ == "__main__":
    unittest.main()
