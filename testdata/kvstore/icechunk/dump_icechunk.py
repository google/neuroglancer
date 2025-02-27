#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "msgpack",
#     "zstandard",
# ]
# ///

import argparse
import pathlib
import pprint
import struct

import msgpack
import zstandard


def dump(filename: str):
    content = pathlib.Path(filename).read_bytes()

    magic, implementation_name, spec_version, file_type, compression_type = (
        struct.unpack_from("12s24sBBB", content)
    )
    payload = content[39:]
    match compression_type:
        case 0:
            pass
        case 1:
            payload = zstandard.ZstdDecompressor().decompressobj().decompress(payload)
        case _:
            raise ValueError(f"Invalid {compression_type=}")

    return msgpack.unpackb(payload, strict_map_key=False, use_list=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")

    args = ap.parse_args()

    pprint.pp(dump(args.input))


if __name__ == "__main__":
    main()
