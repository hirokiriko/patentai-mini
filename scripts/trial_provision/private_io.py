"""Current-user-only files, using the existing reviewed Local state writer."""
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import errno as errno_module
import os
from pathlib import Path
import stat

@contextmanager
def _owner_security_attributes(*, directory=False):
    """Yield current-user-only Windows SECURITY_ATTRIBUTES; no credential I/O.

    The TokenUser SID is operating-system identity metadata, never emitted.
    This internal helper also lets an offline fixture create its own private
    directory through CreateDirectoryW before running real Windows I/O checks.
    """
    if os.name != "nt":
        raise OSError(errno_module.ENOSYS, "windows_security_attributes_required")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", wintypes.LPVOID),
                    ("bInheritHandle", wintypes.BOOL)]

    class SidAndAttributes(ctypes.Structure):
        _fields_ = [("Sid", wintypes.LPVOID), ("Attributes", wintypes.DWORD)]

    kernel.GetCurrentProcess.argtypes = []
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel.LocalFree.restype = wintypes.HLOCAL
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD)]
    advapi.GetTokenInformation.restype = wintypes.BOOL
    advapi.ConvertSidToStringSidW.argtypes = [wintypes.LPVOID, ctypes.POINTER(wintypes.LPWSTR)]
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    token = wintypes.HANDLE()
    sid_string = wintypes.LPWSTR()
    descriptor = wintypes.LPVOID()
    try:
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        needed = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if needed.value == 0:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi.GetTokenInformation(token, 1, buffer, needed.value, ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(SidAndAttributes)).contents.Sid
        if not advapi.ConvertSidToStringSidW(sid, ctypes.byref(sid_string)):
            raise ctypes.WinError(ctypes.get_last_error())
        # No inherited Users/Everyone/Administrators ACE is carried into the file.
        flags = "OICI" if directory else ""
        sddl = "O:" + sid_string.value + "D:P(A;" + flags + ";FA;;;" + sid_string.value + ")"
        if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        yield attributes
    finally:
        if descriptor:
            kernel.LocalFree(descriptor)
        if sid_string:
            kernel.LocalFree(ctypes.cast(sid_string, wintypes.HLOCAL))
        if token:
            kernel.CloseHandle(token)

def _create_owner_file(path):
    """Exclusively create one private file, returning a writable Python fd."""
    if os.name != "nt":
        return os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    import msvcrt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    with _owner_security_attributes() as attributes:
        handle = kernel.CreateFileW(str(path), 0x40000000, 0, ctypes.byref(attributes), 1, 0x80, None)
        creation_error = ctypes.get_last_error()
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(creation_error)
    try:
        return msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
    except BaseException:
        kernel.CloseHandle(handle)
        # This exact path was created successfully above; no recursive cleanup.
        try:
            path.unlink()
        except OSError:
            pass
        raise

create_owner_file = _create_owner_file


def _private_path(path, *, directory):
    path = Path(path)
    value = path.lstat()
    if (not path.is_absolute() or path.resolve(strict=True) != path or path.is_symlink()
        or getattr(value, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 1024)
        or not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode))):
        raise OSError('private_directory_type' if directory else 'private_file_type')
    return path, value


def _windows_owner_ace(path):
    """Read owner/DACL using WinAPI; accept exactly one current-user full ACE.

    Returns only inheritance flags and DACL-protected status. No SID or SDDL
    escapes this function. A null/empty DACL, deny/object ACE, other principal,
    additional ACE or different access mask is never normalized into acceptance.
    """
    advapi=ctypes.WinDLL('advapi32',use_last_error=True)
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    advapi.GetNamedSecurityInfoW.argtypes=[wintypes.LPWSTR,ctypes.c_int,wintypes.DWORD,
        ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetNamedSecurityInfoW.restype=wintypes.DWORD
    advapi.GetSecurityDescriptorOwner.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(wintypes.BOOL)]
    advapi.GetSecurityDescriptorOwner.restype=wintypes.BOOL
    advapi.IsValidSecurityDescriptor.argtypes=[ctypes.c_void_p]
    advapi.IsValidSecurityDescriptor.restype=wintypes.BOOL
    advapi.GetSecurityDescriptorDacl.argtypes=[ctypes.c_void_p,ctypes.POINTER(wintypes.BOOL),
        ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(wintypes.BOOL)]
    advapi.GetSecurityDescriptorDacl.restype=wintypes.BOOL
    advapi.GetSecurityDescriptorControl.argtypes=[ctypes.c_void_p,ctypes.POINTER(wintypes.WORD),ctypes.POINTER(wintypes.DWORD)]
    advapi.GetSecurityDescriptorControl.restype=wintypes.BOOL
    advapi.EqualSid.argtypes=[ctypes.c_void_p,ctypes.c_void_p];advapi.EqualSid.restype=wintypes.BOOL
    advapi.IsValidSid.argtypes=[ctypes.c_void_p];advapi.IsValidSid.restype=wintypes.BOOL
    advapi.GetLengthSid.argtypes=[ctypes.c_void_p];advapi.GetLengthSid.restype=wintypes.DWORD
    advapi.IsValidAcl.argtypes=[ctypes.c_void_p];advapi.IsValidAcl.restype=wintypes.BOOL
    advapi.GetAce.argtypes=[ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(ctypes.c_void_p)]
    advapi.GetAce.restype=wintypes.BOOL
    kernel.LocalFree.argtypes=[ctypes.c_void_p];kernel.LocalFree.restype=ctypes.c_void_p
    class ACL(ctypes.Structure):
        _fields_=[('revision',ctypes.c_ubyte),('reserved',ctypes.c_ubyte),('size',wintypes.WORD),
                  ('count',wintypes.WORD),('reserved2',wintypes.WORD)]
    class AllowedACE(ctypes.Structure):
        _fields_=[('kind',ctypes.c_ubyte),('flags',ctypes.c_ubyte),('size',wintypes.WORD),
                  ('mask',wintypes.DWORD),('sid_start',wintypes.DWORD)]
    descriptor=ctypes.c_void_p()
    def owner(value):
        result=ctypes.c_void_p();defaulted=wintypes.BOOL()
        if not advapi.GetSecurityDescriptorOwner(value,ctypes.byref(result),ctypes.byref(defaulted)) or not result:
            raise OSError('private_owner_unconfirmed')
        return result
    try:
        code=advapi.GetNamedSecurityInfoW(str(path),1,5,None,None,None,None,ctypes.byref(descriptor))
        if code:raise ctypes.WinError(code)
        if not advapi.IsValidSecurityDescriptor(descriptor):raise OSError('private_descriptor_invalid')
        with _owner_security_attributes() as attrs:
            current_owner=owner(attrs.lpSecurityDescriptor)
            if not advapi.EqualSid(owner(descriptor),current_owner):raise OSError('private_owner_mismatch')
            dacl=ctypes.c_void_p();present=wintypes.BOOL();defaulted=wintypes.BOOL()
            if (not advapi.GetSecurityDescriptorDacl(descriptor,ctypes.byref(present),ctypes.byref(dacl),ctypes.byref(defaulted))
                or not present or not dacl or not advapi.IsValidAcl(dacl)):
                raise OSError('private_dacl_unconfirmed')
            if ctypes.cast(dacl,ctypes.POINTER(ACL)).contents.count != 1:raise OSError('private_dacl_extra_ace')
            ace_ptr=ctypes.c_void_p()
            if not advapi.GetAce(dacl,0,ctypes.byref(ace_ptr)):raise OSError('private_ace_unconfirmed')
            ace=ctypes.cast(ace_ptr,ctypes.POINTER(AllowedACE)).contents
            if ace.kind != 0 or ace.mask != 0x001F01FF or ace.size < 16:
                raise OSError('private_ace_permissions')
            sid=ctypes.c_void_p(ace_ptr.value+AllowedACE.sid_start.offset)
            if (not advapi.IsValidSid(sid) or AllowedACE.sid_start.offset+advapi.GetLengthSid(sid)!=ace.size
                or not advapi.EqualSid(sid,current_owner)):
                raise OSError('private_ace_owner')
            control=wintypes.WORD();revision=wintypes.DWORD()
            if not advapi.GetSecurityDescriptorControl(descriptor,ctypes.byref(control),ctypes.byref(revision)):
                raise OSError('private_dacl_control')
            return ace.flags, bool(control.value & 0x1000)
    finally:
        if descriptor:kernel.LocalFree(descriptor)


def verify_owner_directory(path):
    """Read-only verification of an OWNER-only directory safe for new children.

    Windows requires one current-owner full-control ACE with both object and
    container inheritance and a protected DACL. Existing ACLs are never rewritten. POSIX keeps
    current-user ownership and no group/other permissions.
    """
    path, value = _private_path(path, directory=True)
    if os.name != 'nt':
        if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode)&0o077:
            raise OSError('private_directory_permissions')
        return
    flags, protected = _windows_owner_ace(path)
    if flags != 0x03 or not protected:  # OBJECT_INHERIT | CONTAINER_INHERIT
        raise OSError('private_directory_permissions')


def verify_owner_file(path):
    """Accept a protected OWNER-only file or exact safe OWNER inheritance.

    Node open(wx, 0600) on Windows inherits its parent's DACL. Such a file is
    accepted only after checking both its actual ACE and its protected safe
    parent directory; the Unix mode argument alone is never evidence.
    """
    path, value = _private_path(path, directory=False)
    if os.name != 'nt':
        if value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode)&0o077:
            raise OSError('private_file_permissions')
        return
    flags, protected = _windows_owner_ace(path)
    if flags == 0 and protected:
        return
    if flags != 0x10 or protected:
        raise OSError('private_file_permissions')
    verify_owner_directory(path.parent)
