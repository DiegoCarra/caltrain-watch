import unittest
from datetime import datetime, timezone

from scripts.build_reports import MARKER, build_snapshot


class BuildReportsTests(unittest.TestCase):
    def test_dedupes_same_reporter_and_surfaces_feed_disagreement(self):
        now = datetime(2026, 8, 31, 16, 0, tzinfo=timezone.utc)
        caltrain = {
            "trips": [{
                "id": "trip-503",
                "trainNumber": "503",
                "routeId": "CT",
                "stops": [
                    {"name": "Millbrae", "departureEpoch": 1000, "arrivalEpoch": 1000, "realtimeDepartureEpoch": 1600},
                    {"name": "San Jose Diridon", "departureEpoch": 2000, "arrivalEpoch": 2000, "realtimeDepartureEpoch": 2600},
                ],
            }],
            "alerts": [],
        }

        def issue(number, user, minute, category="held", delay=25):
            return {
                "number": number,
                "html_url": f"https://example.test/{number}",
                "created_at": f"2026-08-31T15:{minute:02d}:00Z",
                "user": {"login": user},
                "reactions": {"+1": 0},
                "body": f"""{MARKER}\nTrain: 503\nStation: Millbrae\nCategory: {category}\nSource: station-board\nDelay minutes: {delay}\nObserved at: 2026-08-31T15:{minute:02d}:00Z\n\nDetails:\nBoard says {delay} minutes.\n""",
            }

        snapshot = build_snapshot([
            issue(1, "alice", 10, delay=20),
            issue(2, "alice", 20, delay=25),
            issue(3, "bob", 21, delay=25),
        ], caltrain, now)

        self.assertEqual(snapshot["reportCount"], 2)
        incident = snapshot["incidents"][0]
        self.assertEqual(incident["crowdDelayMinutes"], 25)
        self.assertEqual(incident["officialDelayMinutes"], 10)
        self.assertIn("may be lagging", incident["summary"])
        self.assertEqual(incident["consensusCount"], 2)

    def test_conflicting_causes_are_not_presented_as_consensus(self):
        now = datetime(2026, 8, 31, 16, 0, tzinfo=timezone.utc)
        caltrain = {"trips": [], "alerts": []}
        issues = []
        for number, user, category in [(1, "a", "signal"), (2, "b", "mechanical")]:
            issues.append({
                "number": number,
                "created_at": "2026-08-31T15:30:00Z",
                "user": {"login": user},
                "reactions": {"+1": 0},
                "body": f"""{MARKER}\nTrain: 123\nStation: San Mateo\nCategory: {category}\nSource: visual\nDelay minutes: 15\nObserved at: 2026-08-31T15:30:00Z\n\nDetails:\nObserved.\n""",
            })
        snapshot = build_snapshot(issues, caltrain, now)
        self.assertTrue(snapshot["incidents"][0]["reason"].startswith("Conflicting rider reports"))


if __name__ == "__main__":
    unittest.main()
