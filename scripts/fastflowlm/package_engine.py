"""Stage FLM from the pinned native build and verify the exact archive passed to CI."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / 'provenance.json').read_text())
VERSION = f"flm-{LOCK['tag'].removeprefix('v')}-r{LOCK['atomic_revision']}"
FORMATS = {'win-x64-npu': '.zip', 'linux-x64-npu': '.tar.gz'}
NOTICES = ('LICENSE_RUNTIME.txt', 'LICENSE_BINARY.txt', 'THIRD_PARTY_NOTICES.txt')


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def stage_engine(source, target, platform, installed):
    target.mkdir()
    for name in NOTICES:
        shutil.copy2(source / name, target / name)
    for name in ('COPYING', 'PATENTS'):
        shutil.copy2(source / 'src/build/wbp/s' / name, target / (name + '.webp'))
    if platform == 'win-x64-npu':
        shutil.copy2(source / 'src/build/flm.exe', target)
        for lib in (source / 'src/lib', source / 'src/lib/xrt'):
            for dll in lib.glob('*.dll'):
                shutil.copy2(dll, target)
    else:
        shutil.copy2(installed / 'flm', target / 'flm-real')
        shutil.copy2(installed / 'flm-wrapper.sh', target / 'flm')
        # The core extractor only needs regular files. Resolve upstream's XRT
        # aliases while staging and keep both library lookup locations intact.
        lib = (installed / 'lib').resolve(strict=True)
        for member in lib.rglob('*'):
            if member.is_symlink() and not member.resolve(strict=True).is_relative_to(lib):
                raise ValueError(f'library link outside installed tree: {member}')
        shutil.copytree(lib, target / 'lib')


def check_tree(tree, platform):
    required = [*NOTICES, 'COPYING.webp', 'PATENTS.webp']
    if platform == 'win-x64-npu':
        required.extend(['flm.exe', 'qwen3_npu.dll', 'libcurl.dll'])
        if any(p.name.lower() == 'xrt_coreutil.dll' for p in tree.rglob('*')):
            raise ValueError('Windows driver DLL in engine bundle')
    else:
        required.extend(['flm', 'flm-real'])
        for directory in ('lib', 'lib/x86_64-linux-gnu'):
            for name in ('libxrt_core.so.2', 'libxrt_coreutil.so.2', 'libxrt_driver_xdna.so.2'):
                required.append(f'{directory}/{name}')
        required.append('lib/libqwen3_npu.so')
    for path in required:
        if not (tree / path).is_file():
            raise ValueError(f'missing archive member: {path}')


def asset_paths(output, platform):
    stem = VERSION + '-' + platform
    return output / (stem + FORMATS[platform]), output / (stem + '.json')


def create_archive(tree, output, platform):
    check_tree(tree, platform)
    output.mkdir(exist_ok=True)
    archive, record = asset_paths(output, platform)
    members = sorted(p for p in tree.rglob('*') if p.is_file())
    if platform == 'win-x64-npu':
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as packed:
            for member in members:
                packed.write(member, member.relative_to(tree))
    else:
        with tarfile.open(archive, 'w:gz') as packed:
            for member in members:
                packed.add(member, arcname=member.relative_to(tree), recursive=False)
    metadata = {'platform': platform, 'file': archive.name, 'size': archive.stat().st_size,
                'sha256': digest(archive), 'runner_image': os.environ.get('ImageVersion'),
                'xrt_libraries': [p.relative_to(tree).as_posix() for p in members if p.name.startswith('libxrt')]}
    record.write_text(json.dumps(metadata, indent=2) + '\n')
    return archive, record


def verify_archive(output, platform):
    archive, record = asset_paths(output, platform)
    metadata = json.loads(record.read_text())
    if (metadata['platform'] != platform or metadata['file'] != archive.name or
            metadata['size'] != archive.stat().st_size or metadata['sha256'] != digest(archive)):
        raise ValueError(f'archive identity, size or digest mismatch: {archive}')
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('pack', 'probe', 'manifest'))
    parser.add_argument('output', type=Path)
    parser.add_argument('--platform', choices=FORMATS)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--installed', type=Path)
    args = parser.parse_args()
    if args.operation == 'manifest':
        assets = []
        for platform in FORMATS:
            verify_archive(args.output, platform)
            assets.append(json.loads(asset_paths(args.output, platform)[1].read_text()))
        record = {'version': VERSION, 'core_commit': os.environ['GITHUB_SHA'], 'local_only_protocol': 1,
                  'dependencies_sha256': digest(HERE / 'provenance.json'), 'inputs': LOCK, 'assets': assets}
        (args.output / (VERSION + '-provenance.json')).write_text(json.dumps(record, indent=2) + '\n')
        return
    if not args.platform:
        parser.error('--platform is required')
    with tempfile.TemporaryDirectory() as temp:
        tree = Path(temp) / 'engine archive'
        if args.operation == 'pack':
            if not args.source or (args.platform == 'linux-x64-npu' and not args.installed):
                parser.error('supply the source checkout and, on Linux, the CMake install tree')
            stage_engine(args.source, tree, args.platform, args.installed)
            create_archive(tree, args.output, args.platform)
        else:
            archive = verify_archive(args.output, args.platform)
            if args.platform == 'win-x64-npu':
                with zipfile.ZipFile(archive) as packed:
                    packed.extractall(tree)
                exe = 'flm.exe'
            else:
                with tarfile.open(archive) as packed:
                    packed.extractall(tree, filter='data')
                exe = 'flm'
                lib = tree / 'lib'
                mirror = lib / 'x86_64-linux-gnu'
                # The capability query does not load the device plugin. Resolve
                # its dependencies separately on the clean VM, using the same
                # library precedence as the packaged launcher.
                linker_env = {**os.environ, 'LD_LIBRARY_PATH': os.pathsep.join(map(str, (mirror, lib)))}
                for obj in (tree / 'flm-real', mirror / 'libxrt_driver_xdna.so.2'):
                    closure = subprocess.check_output(['ldd', str(obj)], env=linker_env, text=True)
                    print(closure, flush=True)
                    if 'not found' in closure:
                        raise ValueError(f'unresolved shared library for {obj}')
            check_tree(tree, args.platform)
            subprocess.run([sys.executable, str(HERE / 'probe.py'), str(tree / exe)], check=True, cwd=temp)


if __name__ == '__main__':
    main()
