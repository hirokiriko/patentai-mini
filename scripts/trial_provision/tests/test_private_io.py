"""Real newly-created OWNER fixtures; never change an existing file's ACL."""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts.trial_provision.private_io import (
    _owner_security_attributes, create_owner_file, verify_owner_directory,
    verify_owner_file,
)


def create_owner_directory(path, *, inheritable=True):
    """Create a fresh fixture with safe ACL from inception; not an ACL editor."""
    if os.name != 'nt':
        path.mkdir(mode=0o700)
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateDirectoryW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p]
    kernel.CreateDirectoryW.restype = wintypes.BOOL
    with _owner_security_attributes(directory=inheritable) as attributes:
        if not kernel.CreateDirectoryW(str(path), ctypes.byref(attributes)):
            raise ctypes.WinError(ctypes.get_last_error())


class PrivateIoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_protected_owner_file_remains_accepted(self):
        path = self.root / 'protected.json'
        fd = create_owner_file(path)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(b'{"fictional":true}\n')
        verify_owner_file(path)

    def test_owner_directory_is_verified_without_modifying_it(self):
        path = self.root / 'private'
        create_owner_directory(path)
        before = path.stat()
        verify_owner_directory(path)
        after = path.stat()
        self.assertEqual((before.st_ino, before.st_mode, before.st_mtime_ns),
                         (after.st_ino, after.st_mode, after.st_mtime_ns))

    @unittest.skipUnless(os.name == 'nt', 'Windows ACL inheritance integration')
    def test_directory_without_oi_ci_is_refused(self):
        path = self.root / 'non-inheritable'
        create_owner_directory(path, inheritable=False)
        with self.assertRaisesRegex(OSError, 'private_directory_permissions'):
            verify_owner_directory(path)

    def test_real_node_exclusive_file_passes_python_owner_verification(self):
        executable = shutil.which('node')
        if not executable:
            self.skipTest('Node is not installed; no installation or fallback performed')
        directory = self.root / 'private'
        create_owner_directory(directory)
        verify_owner_directory(directory)
        path = directory / 'node-policy.json'
        code = "const f=require('node:fs');const h=f.openSync(process.argv[1],'wx',0o600);try{f.writeFileSync(h,'{\"fictional\":true}\\n');f.fsyncSync(h)}finally{f.closeSync(h)}"
        result = subprocess.run([str(Path(executable).resolve()), '-e', code, str(path)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            shell=False, timeout=10, check=True,
            creationflags=0x08000000 if os.name == 'nt' else 0)
        self.assertEqual(result.stdout, b'')
        self.assertEqual(result.stderr, b'')
        self.assertEqual(path.read_bytes(), b'{"fictional":true}\n')
        verify_owner_file(path)

    @unittest.skipUnless(os.name == 'nt', 'Windows strict ACE flag checks')
    def test_inherited_file_requires_actual_safe_parent_each_time(self):
        path = self.root / 'fictional.json'
        path.write_bytes(b'{}')
        with patch('scripts.trial_provision.private_io._windows_owner_ace', return_value=(0x10, False)), \
             patch('scripts.trial_provision.private_io.verify_owner_directory', side_effect=OSError('unsafe_parent')) as parent:
            with self.assertRaisesRegex(OSError, 'unsafe_parent'):
                verify_owner_file(path)
            parent.assert_called_once_with(path.parent)

    @unittest.skipUnless(os.name == 'nt', 'Windows strict ACE flag checks')
    def test_extra_or_inherit_only_flags_never_pass(self):
        directory = self.root / 'private'
        create_owner_directory(directory)
        path = directory / 'fictional.json'
        fd = create_owner_file(path)
        os.close(fd)
        for flags, protected in ((0x18, False), (0x13, False), (0, False), (0x10, True), (0x80, True)):
            with self.subTest(flags=flags, protected=protected), patch(
                'scripts.trial_provision.private_io._windows_owner_ace', return_value=(flags, protected)):
                with self.assertRaises(OSError):
                    verify_owner_file(path)
        for flags, protected in ((0x0B, True), (0x07, True), (0x13, False), (0x03, False)):
            with self.subTest(directory_flags=flags), patch(
                'scripts.trial_provision.private_io._windows_owner_ace', return_value=(flags, protected)):
                with self.assertRaises(OSError):
                    verify_owner_directory(directory)

    def test_directory_and_file_cannot_be_interchanged(self):
        with self.assertRaisesRegex(OSError, 'private_file_type'):
            verify_owner_file(self.root)
        path = self.root / 'regular'
        path.write_bytes(b'{}')
        with self.assertRaisesRegex(OSError, 'private_directory_type'):
            verify_owner_directory(path)

    @unittest.skipIf(os.name == 'nt', 'POSIX ownership/mode compatibility')
    def test_posix_group_or_other_permissions_rejected(self):
        path = self.root / 'exposed'
        path.mkdir(mode=0o755)
        with self.assertRaises(OSError):
            verify_owner_directory(path)


if __name__ == '__main__':
    unittest.main()
