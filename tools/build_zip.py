#!/usr/bin/env python3
"""
ექსთენშენის ZIP-ის აწყობა src/ საქაღალდიდან.

    python tools/build_zip.py            -> dist/napr_lookup_DEMO.zip  (სატესტო: სახელი "NAPR Lookup DEMO")
    python tools/build_zip.py --release  -> dist/napr_lookup.zip       (გამოსაშვები: სახელიდან "DEMO" იშლება)

გამოსაშვები ZIP იტვირთება GitHub-ის ახალ Release-ად ზუსტად სახელით napr_lookup.zip:
install.bat და ავტოგანახლება კითხულობენ releases/latest/download/napr_lookup.zip-ს.
"""
import json
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "src"
OUTPUT_FOLDER = REPO / "dist"


def main():
    is_release = "--release" in sys.argv[1:]
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    name = manifest["name"].replace(" DEMO", "") if is_release else manifest["name"]
    if not is_release and "DEMO" not in name:
        name += " DEMO"
    manifest["name"] = name

    OUTPUT_FOLDER.mkdir(exist_ok=True)
    zip_path = OUTPUT_FOLDER / ("napr_lookup.zip" if is_release else "napr_lookup_DEMO.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(SOURCE.rglob("*")):
            if file.is_dir() or file.name.startswith("."):
                continue
            relative = file.relative_to(SOURCE).as_posix()
            if relative == "manifest.json":
                archive.writestr(relative, json.dumps(manifest, ensure_ascii=False, indent=2))
            else:
                archive.write(file, relative)
    print(f"{zip_path.relative_to(REPO)}  ·  {name} {manifest['version']}  ·  {zip_path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
