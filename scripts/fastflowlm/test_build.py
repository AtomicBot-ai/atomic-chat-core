"""Regression checks for the source gate that runs before CMake."""

import subprocess
import tempfile
import unittest
from pathlib import Path

from build import verify_checkout


class SourceGateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "--quiet")
        (self.repo / "engine.dll").write_bytes(b"upstream-engine")
        self.git("add", "engine.dll")
        self.git("-c", "user.name=test", "-c", "user.email=test@localhost",
                 "commit", "--quiet", "-m", "fixture")
        self.lock = {"commit": self.git("rev-parse", "HEAD"), "objects": {
            "engine.dll": self.git("rev-parse", "HEAD:engine.dll")}, "submodules": {}}

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def test_accepts_pinned_source(self):
        verify_checkout(self.repo, self.lock)

    def test_rejects_substituted_engine_even_at_pinned_commit(self):
        (self.repo / "engine.dll").write_bytes(b"substituted-engine")
        with self.assertRaisesRegex(ValueError, "dirty"):
            verify_checkout(self.repo, self.lock)

    def test_rejects_untracked_source_in_upstream_cmake_glob(self):
        (self.repo / "extra.cpp").touch()
        with self.assertRaisesRegex(ValueError, "dirty"):
            verify_checkout(self.repo, self.lock)

    def test_rejects_mismatched_source_commit(self):
        self.lock["commit"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "commit"):
            verify_checkout(self.repo, self.lock)

    def test_rejects_hidden_engine_edits(self):
        self.git("update-index", "--assume-unchanged", "engine.dll")
        (self.repo / "engine.dll").write_bytes(b"substitution hidden from git status")
        with self.assertRaisesRegex(ValueError, "index"):
            verify_checkout(self.repo, self.lock)

    def test_rejects_skipped_engine_file(self):
        self.git("update-index", "--skip-worktree", "engine.dll")
        (self.repo / "engine.dll").unlink()
        with self.assertRaisesRegex(ValueError, "index"):
            verify_checkout(self.repo, self.lock)

    def test_rejects_wrong_engine_object(self):
        self.lock["objects"]["engine.dll"] = "0" * 40
        with self.assertRaisesRegex(ValueError, "engine.dll"):
            verify_checkout(self.repo, self.lock)

    def test_rejects_missing_submodule(self):
        self.lock["submodules"]["third_party/tokenizers-cpp"] = "1" * 40
        with self.assertRaisesRegex(ValueError, "submodule"):
            verify_checkout(self.repo, self.lock)


class WindowsBuilderTest(unittest.TestCase):
    def test_physical_gate_checks_visual_studio_and_keeps_release_image_requirement(self):
        from build import verify_windows_builder

        pins = {"image": "pinned-image", "vs_version": "18.11.12315.225"}
        verify_windows_builder(pins, "pinned-image", None)
        verify_windows_builder(pins, None, pins["vs_version"])
        for image, version in [(None, None), ("other", None), (None, "18.11.0")]:
            with self.assertRaises(ValueError):
                verify_windows_builder(pins, image, version)
