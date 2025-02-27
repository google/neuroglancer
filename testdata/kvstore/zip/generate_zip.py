#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# ///

import os
import zipfile

SCRIPT_DIR = os.path.abspath(os.path.dirname(__file__))


def create_zip(directory_path: str, zip_path: str):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zipf:
        for root, dirs, files in os.walk(directory_path):
            for filename in files:
                entry_path = os.path.join(root, filename)
                zipf.write(entry_path, os.path.relpath(entry_path, directory_path))


create_zip(
    os.path.join(SCRIPT_DIR, "..", "files"), os.path.join(SCRIPT_DIR, "files.zip")
)
