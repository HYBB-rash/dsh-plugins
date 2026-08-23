#!/usr/bin/env python3
"""TODO02 RED contract for the X current-collection artifact.

These tests deliberately describe the source-side boundary, not Feed's C36
decision.  ``recent_items`` remains the capped planner input; the new artifact
must preserve the complete mechanically eligible collection from this run.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import x_insight_pipeline as pipeline


def an_x_item(identifier, text=None, **extra):
    """Build one collector-shaped item with stable source-side fields."""
    return {
        "id": str(identifier),
        "url": f"https://x.com/example/status/{identifier}",
        "text": text or f"candidate {identifier}",
        "time": "2026-08-23T00:00:00.000Z",
        "user": "example",
        "media": [],
        **extra,
    }


def write_jsonl(path, items):
    with open(path, "w", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")


class TestTodo02CurrentCollectionArtifact(unittest.TestCase):
    def build_package(self, temporary_directory, current_items, history_items=None,
                      cap_items=20, shown=None):
        timeline_path = os.path.join(temporary_directory, "timeline.jsonl")
        write_jsonl(timeline_path, history_items or [])
        shown_path = os.path.join(temporary_directory, "shown.json")
        if shown is not None:
            with open(shown_path, "w", encoding="utf-8") as handle:
                json.dump(shown, handle)
        return pipeline.build_package(
            items_path=timeline_path,
            last_path=os.path.join(temporary_directory, "last.json"),
            current_items=current_items,
            cap_items=cap_items,
            shown_path=shown_path,
        )

    def test_artifact_separates_complete_current_collection_from_capped_recent_items(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            current_items = [an_x_item("current-1"), an_x_item("current-2")]
            package = self.build_package(
                temporary_directory,
                current_items,
                history_items=[an_x_item("history-1")],
                cap_items=1,
            )

        self.assertIn("current_collection", package)
        self.assertEqual(
            [item["id"] for item in package["current_collection"]],
            ["current-1", "current-2"],
        )
        self.assertEqual([item["id"] for item in package["recent_items"]], ["current-1"])
        self.assertNotIn("history-1", {item["id"] for item in package["current_collection"]})

    def test_artifact_preserves_all_current_items_when_recent_items_hit_cap(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            current_items = [an_x_item(str(index)) for index in range(25)]
            package = self.build_package(temporary_directory, current_items, cap_items=20)

        self.assertIn("current_collection", package)
        self.assertEqual(len(package["recent_items"]), 20)
        self.assertEqual(len(package["current_collection"]), 25)
        self.assertEqual(
            [item["id"] for item in package["current_collection"]],
            [str(index) for index in range(25)],
        )

    def test_artifact_contains_only_current_items_after_mechanical_dedup_and_shown_filter(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            duplicate = an_x_item("1", text="short")
            richer_duplicate = an_x_item("1", text="the complete current text")
            current_items = [duplicate, richer_duplicate, an_x_item("2")]
            package = self.build_package(
                temporary_directory,
                current_items,
                history_items=[an_x_item("history-1")],
                shown={"ids": ["2"], "urls": []},
            )

        self.assertIn("current_collection", package)
        self.assertEqual([item["id"] for item in package["current_collection"]], ["1"])
        self.assertEqual(
            package["current_collection"][0]["text"],
            "the complete current text",
        )
        self.assertNotIn("2", {item["id"] for item in package["current_collection"]})
        self.assertNotIn("history-1", {item["id"] for item in package["current_collection"]})

    def test_empty_collection_is_explicit_and_does_not_fallback_to_history(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = self.build_package(
                temporary_directory,
                current_items=[],
                history_items=[an_x_item("history-1")],
            )

        self.assertIn("current_collection", package)
        self.assertEqual(package["current_collection"], [])
        self.assertEqual(package["recent_items"], [])

    def test_current_collection_retains_stable_source_fields_for_ts_projection(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            package = self.build_package(
                temporary_directory,
                current_items=[an_x_item("1")],
            )

        self.assertIn("current_collection", package)
        candidate = package["current_collection"][0]
        self.assertTrue({"id", "url", "text", "time"}.issubset(candidate))


if __name__ == "__main__":
    unittest.main()
