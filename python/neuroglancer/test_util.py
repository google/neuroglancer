import os

def check_golden_contents(path, expected_contents, write=None):
    if write is None:
        write = os.getenv('NEUROGLANCER_GENERATE_GOLDEN') == '1'
    if write:
        with open(path, 'wb') as f:
            f.write(expected_contents)
    else:
        with open(path, 'rb') as f:
            contents = f.read()
        assert contents == expected_contents
