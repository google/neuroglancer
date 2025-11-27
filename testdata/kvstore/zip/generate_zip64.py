#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# ///

import os
import pathlib

SCRIPT_DIR = os.path.abspath(os.path.dirname(__file__))

# Based on example here: https://blog.yaakov.online/zip64-go-big-or-go-home/
CONTENT = (
    (
        # --- Local File Header ---
        b"\x50\x4b\x03\x04"  # Local File Header Signature
        b"\x2d\x00"  # Version (Viewer)
        b"\x00\x00"  # Flags
        b"\x00\x00"  # Mode
        b"\xf8\x79"  # Time
        b"\x3a\x4f"  # Date
        b"\xd0\xc3\x4a\xec"  # CRC32
        b"\xff\xff\xff\xff"  # Uncompressed Size
        b"\xff\xff\xff\xff"  # Compressed Size
        b"\x0a\x00"  # Filename Length
        b"\x14\x00"  # Extra Data Length
        b"README.txt"  # Filename
        # --- ZIP64 Local File Header Extra Field ---
        b"\x01\x00"  # ZIP64 Field Header
        b"\x10\x00"  # Field Length
        b"\x0d\x00\x00\x00\x00\x00\x00\x00"  # Uncompressed Size
        b"\x0d\x00\x00\x00\x00\x00\x00\x00"  # Compressed Size
        # --- Data ---
        b"Hello, World!"  # Data
        # --- Central Directory File Header ---
        b"\x50\x4b\x01\x02"  # CDFH Signature
        b"\x2d\x00"  # Version (Creator)
        b"\x2d\x00"  # Version (Viewer)
        b"\x00\x00"  # Flags
        b"\x00\x00"  # Mode
        b"\xf8\x79"  # Time
        b"\x3a\x4f"  # Date
        b"\xd0\xc3\x4a\xec"  # CRC32
        b"\xff\xff\xff\xff"  # Uncompressed Size
        b"\xff\xff\xff\xff"  # Compressed Size
        b"\x0a\x00"  # Filename Length
        b"\x1c\x00"  # Extra Data Length
        b"\x00\x00"  # Comment Length
        b"\x00\x00"  # Disk Number
        b"\x00\x00"  # Internal Attributes
        b"\x00\x00\x00\x00"  # External Attributes
        b"\xff\xff\xff\xff"  # LFH Offset
        b"README.txt"  # Filename
        # --- ZIP64 Central Directory File Header Extra Field ---
        b"\x01\x00"  # ZIP64 Field ID
        b"\x18\x00"  # Field Size
        b"\x0d\x00\x00\x00\x00\x00\x00\x00"  # Uncompressed Size
        b"\x0d\x00\x00\x00\x00\x00\x00\x00"  # Compressed Size
        b"\x00\x00\x00\x00\x00\x00\x00\x00"  # LFH Offset
        # --- ZIP64 End of Central Directory Record ---
        b"\x50\x4b\x06\x06"  # ZIP64 EOCDR Signature
        b"\x2c\x00\x00\x00\x00\x00\x00\x00"  # Size of End of Central Directory Record
        b"\x2d\x00"  # Version (Creator)
        b"\x2d\x00"  # Version (Viewer)
        b"\x00\x00\x00\x00"  # Disk Number
        b"\x00\x00\x00\x00"  # Disk with Central Directory
        b"\x01\x00\x00\x00\x00\x00\x00\x00"  # Number of CDR Records on this Disk
        b"\x01\x00\x00\x00\x00\x00\x00\x00"  # Total # of CDR Records
        b"\x54\x00\x00\x00\x00\x00\x00\x00"  # Size of Central Directory
        b"\x49\x00\x00\x00\x00\x00\x00\x00"  # Offset of Central Directory
        # --- ZIP64 End of Central Directory Locator ---
        b"\x50\x4b\x06\x07"  # ZIP64 EOCD Locator Signature
        b"\x00\x00\x00\x00"  # Disk with EOCD Record
        b"\x9d\x00\x00\x00\x00\x00\x00\x00"  # Offset of EOCD
        b"\x01\x00\x00\x00"  # Total Number of Disks
        # --- End of Central Directory Record ---
        b"\x50\x4b\x05\x06"  # EOCDR Signature
        b"\x00\x00"  # Disk Number
        b"\x00\x00"  # Disk w/ CDR
        b"\xff\xff"  # # Entries on Disk
        b"\xff\xff"  # Total # of Entries
        b"\xff\xff\xff\xff"  # Size of Central Directory
        b"\xff\xff\xff\xff"  # Offset of Central Directory
        b"\xff\xff"  # Comment Length (65535 bytes)
    )
    + (b"\x00" * 65535)
)  # Zip Comment Data (65535 NUL bytes)


def create_zip(zip_path: str) -> None:
    pathlib.Path(zip_path).write_bytes(CONTENT)


if __name__ == "__main__":
    create_zip(os.path.join(SCRIPT_DIR, "zip64_larger_than_65557.zip"))
