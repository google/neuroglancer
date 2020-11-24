This package is maintained at [PyPI](https://pypi.python.org/pypi/neuroglancer/).

The published package consists of the source distribution (sdist) along with binary wheels for each
supported Python version and platform.

1. The version number is determined automatically from a git tag:

   ```shell
   git tag vX.Y.Z
   ```

2. To build the source distribution (sdist):

   ```shell
   python setup.py sdist --format=gztar
   ```

   The source distribution is written to the `dist/` directory.

3. On Linux, Windows, and macOS, run:

   ```shell
   ./python/build_tools/cibuildwheel.sh
   ```

   The binary wheels are written to the `dist/` directory.  This command must be run in a CI
   environment such as Github Actions.  On Linux, it is also possible to run locally, via:

   ```shell
   ./python/build_tools/cibuildwheel.sh --platform linux
   ```

   On macOS, this command makes system-wide changes to the Python configuration and should not be
   attempted locally.

6. The source distribution and binary wheels should be copied to a single machine, and then uploaded
   using twine:

   ```shell
   pip install twine
   twine upload dist/*
   ```
