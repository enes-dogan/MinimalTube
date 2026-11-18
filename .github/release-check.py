#!/usr/bin/env python3
"""Checks a MinimalTube release before it is published. The release workflow runs it for every
pushed v* tag; run it by hand before tagging:

    python3 .github/release-check.py v1.3.0

Installed copies of MinimalTube update themselves from GitHub's releases (minimaltube/updater.py),
and one that gets a broken manifest can't repair itself afterwards. So this refuses:
- a tag that isn't "v" plus extension/manifest.json's version;
- a manifest whose key gives another extension ID (the browser would see another extension);
- JSON that doesn't parse, JavaScript that doesn't (node --check), Python that doesn't compile;
- a top-level name starting with "_" in extension/ (Chromium won't load the folder);
- PowerShell that isn't pure ASCII, an install-windows.cmd without CRLF line endings;
- a .gitattributes that changes files on their way into the zip (the updater compares every file
  of the zip with git's own copy).
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from minimaltube.system import extension_id  # noqa: E402

EXTENSION_ID = "bnenkakahnieeabjicmgndndommgehje"
problems = []


def tracked_files() -> list:
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
        return [ROOT / name for name in out.decode("utf-8").split("\0") if name]
    except (OSError, subprocess.CalledProcessError):
        skip = {".git", ".claude", "__pycache__"}
        return [p for p in ROOT.rglob("*") if p.is_file() and not skip & set(p.relative_to(ROOT).parts)]


def main(argv: list) -> int:
    if len(argv) != 1:
        print(__doc__)
        return 2
    tag = argv[0]
    manifest_path = ROOT / "extension" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"extension/manifest.json: {e}")
        return 1
    version = str(manifest.get("version") or "")
    if not re.fullmatch(r"\d{1,5}(\.\d{1,5}){0,3}", version):
        problems.append(f"manifest.json's version {version!r} isn't one Chromium takes (1 to 4 numbers)")
    if tag != f"v{version}":
        problems.append(f"the tag is {tag}, manifest.json says {version}: tag v{version}, or raise the version")
    if extension_id(manifest_path) != EXTENSION_ID:
        problems.append("manifest.json's key gives another extension ID: the browser would take it for another extension")

    files = tracked_files()
    node = shutil.which("node")
    if node and subprocess.run([node, "--version"], capture_output=True).returncode:
        node = None  # there, but it doesn't start
    if not node:
        print("Note: node isn't installed, so the JavaScript isn't checked here (the release workflow checks it).")
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if path.suffix == ".json":
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                problems.append(f"{rel}: {e}")
        elif path.suffix == ".py":
            try:
                compile(path.read_bytes(), rel, "exec", dont_inherit=True)
            except (SyntaxError, ValueError) as e:
                problems.append(f"{rel}: {e}")
        elif path.suffix == ".js" and node:
            check = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
            if check.returncode:
                problems.append(f"{rel}: {(check.stderr or check.stdout).strip()[:400]}")
        elif path.suffix == ".ps1":
            if any(b > 127 for b in path.read_bytes()):
                problems.append(f"{rel}: not pure ASCII (Windows PowerShell 5.1 reads it as ANSI)")
    for entry in (ROOT / "extension").iterdir():
        if entry.name.startswith("_"):
            problems.append(f"extension/{entry.name}: Chromium won't load an extension folder with a top-level name starting with _")
    cmd = ROOT / "install-windows.cmd"
    if cmd.is_file() and re.search(rb"(?<!\r)\n", cmd.read_bytes()):
        problems.append("install-windows.cmd: every line must end in CRLF (cmd.exe misreads it otherwise)")
    attributes = ROOT / ".gitattributes"
    if attributes.is_file():
        for line in attributes.read_text(encoding="utf-8").splitlines():
            words = line.split("#", 1)[0].split()
            if words and any(word != "export-ignore" for word in words[1:]):
                problems.append(f".gitattributes: {line.strip()!r}: only export-ignore may be set (other attributes change files in the zip)")

    if problems:
        print(f"{tag} can't be released:")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"{tag}: {len(files)} files checked, ready to release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
