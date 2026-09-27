#!/usr/bin/env python3
"""Assemble Hive's Windows GStreamer runtime from MSYS2 ucrt64 packages.

usage: windows-gstreamer-runtime.py <work-dir> <out-dir> <plugin.dll | tool.exe>...

Downloads the MSYS2 ucrt64 package index into <work-dir>, then starts from the
requested plugin DLLs and tools (ffmpeg.exe, metaflac.exe) and follows their real PE imports (objdump -p) until the
set is closed, fetching only the packages that own those DLLs. Everything is
extracted under <work-dir>/root (which also provides the headers and import
libraries used to compile the helper), and the minimal runtime is copied to:

  <out-dir>/bin                      core DLLs, codec libraries and tools
  <out-dir>/lib/gstreamer-1.0        plugins
  <out-dir>/libexec/gstreamer-1.0    gst-plugin-scanner.exe

Imports no MSYS2 package provides (kernel32, the api-ms-win-crt UCRT set, ...)
are Windows system DLLs and are printed for review.
"""
import re, shutil, subprocess, sys, urllib.request
from pathlib import Path

REPO = 'https://repo.msys2.org/mingw/ucrt64/'
# Needed to compile the helper even though nothing imports them at runtime.
HEADER_PACKAGES = ['mingw-w64-ucrt-x86_64-gstreamer', 'mingw-w64-ucrt-x86_64-gst-plugins-base', 'mingw-w64-ucrt-x86_64-glib2']


def parse_desc(path):
    fields, key = {}, None
    for line in path.read_text().splitlines():
        if line.startswith('%') and line.endswith('%'):
            key = line[1:-1]; fields[key] = []
        elif line and key:
            fields[key].append(line)
    return fields


def main():
    work, out, wanted = Path(sys.argv[1]), Path(sys.argv[2]), [a.lower() for a in sys.argv[3:]]
    work.mkdir(parents=True, exist_ok=True)
    pkgs, root = work / 'pkgs', work / 'root'
    pkgs.mkdir(exist_ok=True); root.mkdir(exist_ok=True)
    for index in ('ucrt64.db', 'ucrt64.files'):
        urllib.request.urlretrieve(REPO + index, work / index)
        dest = work / index.replace('ucrt64.', '')
        shutil.rmtree(dest, ignore_errors=True); dest.mkdir()
        subprocess.run(['bsdtar', '-xf', str(work / index), '-C', str(dest)], check=True)

    owner, filename = {}, {}  # dll (lower) -> (package, path); package -> file name
    for entry in (work / 'files').iterdir():
        desc = parse_desc(work / 'db' / entry.name / 'desc')
        name = desc['NAME'][0]; filename[name] = desc['FILENAME'][0]
        if not (entry / 'files').exists(): continue
        for rel in parse_desc(entry / 'files').get('FILES', []):
            if rel.lower().endswith(('.dll', '.exe')) and rel.startswith(('ucrt64/bin/', 'ucrt64/lib/gstreamer-1.0/')):
                owner.setdefault(Path(rel).name.lower(), (name, rel))

    extracted = set()
    def ensure(package):
        if package in extracted: return
        archive = pkgs / filename[package]
        if not archive.exists():
            print('download', archive.name, file=sys.stderr)
            urllib.request.urlretrieve(REPO + archive.name, archive)
        subprocess.run(['bsdtar', '-xf', str(archive), '-C', str(root)], check=True)
        extracted.add(package)

    for package in HEADER_PACKAGES: ensure(package)
    queue, seen, system = list(wanted), set(), set()
    while queue:
        dll = queue.pop()
        if dll in seen: continue
        seen.add(dll)
        if dll not in owner: system.add(dll); continue
        ensure(owner[dll][0])
        dump = subprocess.run(['objdump', '-p', str(root / owner[dll][1])], capture_output=True, text=True, check=True).stdout
        queue.extend(m.lower() for m in re.findall(r'DLL Name: (\S+)', dump))
    missing = [d for d in wanted if d not in owner]
    if missing: sys.exit(f'not provided by any MSYS2 package: {missing}')

    shutil.rmtree(out, ignore_errors=True)
    for sub in ('bin', 'lib/gstreamer-1.0', 'libexec/gstreamer-1.0'): (out / sub).mkdir(parents=True)
    for dll in sorted(seen - system):
        rel = owner[dll][1]
        shutil.copy2(root / rel, out / ('lib/gstreamer-1.0' if '/lib/gstreamer-1.0/' in rel else 'bin') / Path(rel).name)
    shutil.copy2(root / 'ucrt64/libexec/gstreamer-1.0/gst-plugin-scanner.exe', out / 'libexec/gstreamer-1.0')
    print(f'runtime: {len(seen - system)} DLLs')
    print('system DLLs:', ' '.join(sorted(system)))


if __name__ == '__main__':
    main()
