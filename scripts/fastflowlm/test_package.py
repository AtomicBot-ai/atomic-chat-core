"""Regression checks for portable engine archives."""

import hashlib
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from package_engine import create_archive, verify_archive


class EngineArchiveTest(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        root = Path(workspace.name)
        self.stage, self.output = root / 'stage', root / 'artifacts'
        self.stage.mkdir()
        self.output.mkdir()
        for name in ['LICENSE_RUNTIME.txt', 'LICENSE_BINARY.txt', 'THIRD_PARTY_NOTICES.txt', 'COPYING.webp', 'PATENTS.webp']:
            (self.stage / name).write_text(name)

    def test_zip_hash_binds_the_archive_before_probe(self):
        for name in ('flm.exe', 'qwen3_npu.dll', 'libcurl.dll'):
            (self.stage / name).write_bytes(b'fixture')
        archive, record = create_archive(self.stage, self.output, 'win-x64-npu')
        self.assertEqual(json.loads(record.read_text())['sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(verify_archive(self.output, 'win-x64-npu'), archive)
        with archive.open('ab') as stream:
            stream.write(b'x')
        with self.assertRaisesRegex(ValueError, 'digest|size'):
            verify_archive(self.output, 'win-x64-npu')

    def test_windows_rejects_bundled_driver(self):
        for name in ('flm.exe', 'qwen3_npu.dll', 'libcurl.dll', 'xrt_coreutil.dll'):
            (self.stage / name).touch()
        with self.assertRaisesRegex(ValueError, 'driver'):
            create_archive(self.stage, self.output, 'win-x64-npu')

    def test_linux_requires_xdna_in_both_loader_locations(self):
        (self.stage / 'flm').touch()
        (self.stage / 'flm-real').touch()
        lib = self.stage / 'lib'
        lib.mkdir()
        for name in ('libxrt_core.so.2', 'libxrt_coreutil.so.2', 'libxrt_driver_xdna.so.2'):
            (lib / name).touch()
        with self.assertRaisesRegex(ValueError, 'x86_64-linux-gnu'):
            create_archive(self.stage, self.output, 'linux-x64-npu')

    def test_linux_tar_keeps_executable_and_reports_xrt_inventory(self):
        for name in ('flm', 'flm-real'):
            exe = self.stage / name
            exe.touch()
            exe.chmod(0o755)
        lib = self.stage / 'lib'
        mirror = lib / 'x86_64-linux-gnu'
        mirror.mkdir(parents=True)
        (lib / 'libqwen3_npu.so').touch()
        for directory in (lib, mirror):
            for name in ('libxrt_core.so.2', 'libxrt_coreutil.so.2', 'libxrt_driver_xdna.so.2'):
                (directory / name).touch()
        archive, record = create_archive(self.stage, self.output, 'linux-x64-npu')
        self.assertEqual(verify_archive(self.output, 'linux-x64-npu'), archive)
        with tarfile.open(archive) as packed:
            self.assertTrue(packed.getmember('flm').isfile())
            if os.name != 'nt':
                self.assertTrue(packed.getmember('flm').mode & 0o111)
        self.assertIn('lib/x86_64-linux-gnu/libxrt_driver_xdna.so.2', json.loads(record.read_text())['xrt_libraries'])
