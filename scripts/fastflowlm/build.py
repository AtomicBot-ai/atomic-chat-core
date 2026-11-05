"""Build the pinned FLM source on a clean x64 Windows or Ubuntu builder."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent


def output(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def verify_checkout(repo, lock):
    if output("git", "rev-parse", "HEAD", cwd=repo) != lock["commit"]:
        raise ValueError("unexpected FLM commit")
    for path, expected in lock["objects"].items():
        if output("git", "rev-parse", "HEAD:" + path, cwd=repo) != expected:
            raise ValueError(f"unexpected Git object for {path}")

    submodules = {}
    for line in subprocess.check_output(
        ["git", "submodule", "status", "--recursive"], cwd=repo, text=True
    ).splitlines():
        entry = re.fullmatch(r" ([0-9a-f]{40}) ([^ ]+)(?: \(.*\))?", line)
        if not entry:
            raise ValueError(f"uninitialized or mismatched submodule: {line}")
        submodules[entry[2]] = entry[1]
    if submodules != lock["submodules"]:
        raise ValueError("unexpected submodule inventory")

    # Upstream globs source files and reuses local build caches. Reject both
    # untracked sources and ignored build output, including in dependencies.
    for directory in [repo, *(repo / name for name in submodules)]:
        flags = output("git", "ls-files", "-v", "-z", cwd=directory)
        if any(entry and not entry.startswith("H ") for entry in flags.split("\0")):
            raise ValueError(f"unexpected index flags in build checkout: {directory}")
        if output("git", "status", "--porcelain", "--ignored",
                  "--untracked-files=all", "--ignore-submodules=none", cwd=directory):
            raise ValueError(f"dirty build checkout: {directory}")


def verify_windows_builder(pins, image, physical_vs_version):
    if physical_vs_version is not None:
        if physical_vs_version != pins["vs_version"]:
            raise ValueError("unexpected Visual Studio version on the feasibility host")
    elif image != pins["image"]:
        raise ValueError("unexpected Windows build image")


def build(repo, lock, *, installed_windows_toolchain=False):
    if platform.machine().lower() not in {"x86_64", "amd64"}:
        raise ValueError("use a native x64 builder or the pinned linux/amd64 image")
    if output("rustc", "--version").split()[1] != lock["rust"]:
        raise ValueError("unexpected Rust toolchain")
    system = platform.system()
    if system == "Windows":
        pins = lock["windows"]
        vs_version = None
        if installed_windows_toolchain:
            vswhere = Path(os.environ["ProgramFiles(x86)"]) / "Microsoft Visual Studio/Installer/vswhere.exe"
            vs_version = output(str(vswhere), "-latest", "-products", "*", "-requires",
                                "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                                "-property", "installationVersion")
        verify_windows_builder(pins, os.environ.get("ImageVersion"), vs_version)
        if output("cmake", "--version").splitlines()[0] != "cmake version " + pins["cmake"]:
            raise ValueError("unexpected Windows CMake version")
        if output("git", "rev-parse", "HEAD", cwd=os.environ["VCPKG_INSTALLATION_ROOT"]) != pins["vcpkg"]:
            raise ValueError("unexpected vcpkg revision")
        if Path("C:/dev").exists():
            raise ValueError("use a clean builder without an existing C:/dev dependency cache")
        subprocess.run(["powershell", "-NoProfile", "-File",
                        str(repo / ".github/script/setup_windows_deps.ps1")], cwd=repo, check=True)
        preset = "windows-vs18"
        extra = ["-A", "x64,version=" + pins["sdk"], "-DCMAKE_SYSTEM_VERSION=" + pins["sdk"]]
    elif system == "Linux":
        if output("g++", "-dumpfullversion") != lock["linux"]["gcc"]:
            raise ValueError("unexpected Linux compiler")
        subprocess.run(["pkg-config", "--exists", "xrt"], check=True)
        preset, extra = "linux-portable", []
    else:
        raise ValueError(f"unsupported FLM build platform: {system}")

    patch = HERE / "local-only.patch"
    if hashlib.sha256(patch.read_bytes()).hexdigest() != lock["patch_sha256"]:
        raise ValueError("unexpected Atomic patch for this revision")
    subprocess.run(["git", "apply", "--whitespace=nowarn", str(patch)], cwd=repo, check=True)
    cargo_lock = HERE / "Cargo.lock"
    if hashlib.sha256(cargo_lock.read_bytes()).hexdigest() != lock["cargo_lock_sha256"]:
        raise ValueError("unexpected tokenizer Cargo.lock")
    rust_dir = repo / "third_party/tokenizers-cpp/rust"
    shutil.copyfile(cargo_lock, rust_dir / "Cargo.lock")
    subprocess.run(["cargo", "fetch", "--locked"], cwd=rust_dir, check=True)
    env = {**os.environ, "CARGO_NET_OFFLINE": "true"}
    source = repo / "src"
    subprocess.run(["cmake", "--preset", preset, "-DFLM_USE_HRX=OFF",
                    "-DFLM_BUILD_GEMMA4E=OFF", "-DFLM_ENABLE_CORE=OFF",
                    "-DFLM_VIDEO_FFMPEG=OFF", "-DATOMIC_FLM_COMMIT=" + lock["commit"],
                    "-DATOMIC_FLM_REVISION=" + str(lock["atomic_revision"]), *extra], cwd=source, env=env, check=True)
    if system == "Windows":
        compilers = list((source / "build/CMakeFiles").glob("*/CMakeCXXCompiler.cmake"))
        if len(compilers) != 1 or f'"{pins["msvc"]}"' not in compilers[0].read_text():
            raise ValueError("unexpected Windows C++ compiler")
    subprocess.run(["cmake", "--build", "build", "--config", "Release", "--parallel", "4"],
                   cwd=source, env=env, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="fresh recursive checkout of FLM")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--installed-windows-toolchain", "--windows-feasibility",
                        dest="installed_windows_toolchain", action="store_true",
                        help="use the pinned Visual Studio installation on a provisioned Windows builder")
    args = parser.parse_args()
    pins = json.loads((HERE / "provenance.json").read_text())
    checkout = args.source.resolve()
    verify_checkout(checkout, pins)
    if not args.verify_only:
        build(checkout, pins, installed_windows_toolchain=args.installed_windows_toolchain)
