import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("archive_snapshot", Path(__file__).parents[1] / "scripts/archive_snapshot.py")
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class ArchiveTests(unittest.TestCase):
    def test_archives_real_data_only_once_per_week(self):
        previous = {"generatedAt": "2026-11-01T08:00:00-08:00"}
        current = {"mode": "live", "trips": [{"id": "T"}], "generatedAt": "2026-11-07T08:00:00-08:00"}
        self.assertFalse(archive.should_archive(previous, current))
        current["generatedAt"] = "2026-11-08T08:00:00-08:00"
        self.assertTrue(archive.should_archive(previous, current))
        current["mode"] = "demo"
        self.assertFalse(archive.should_archive(previous, current))
        current["mode"] = "schedule"
        self.assertFalse(archive.should_archive(previous, current))

    def test_missing_archive_date_can_recover(self):
        self.assertTrue(archive.should_archive({}, {"mode": "live", "trips": [{}], "generatedAt": "2026-11-08T08:00:00-08:00"}))


if __name__ == "__main__":
    unittest.main()
