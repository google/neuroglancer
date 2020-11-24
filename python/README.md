# Neuroglancer Python Integration

This package provides a Python interface for controlling
[Neuroglancer](https://github.com/google/neuroglancer), a web-based 3-d
volumetric data viewer.

The following features are supported:
 - Viewing in-memory NumPy arrays (or any other array type with a similar
   interface, including HDF5 arrays loaded through h5py)
 - Reading and writing the Neuroglancer viewer state from Python
 - Changing Neuroglancer key and mouse bindings
 - Defining actions (to be triggered by key or mouse bindings) that cause a
   Python callback to be invoked.

It starts a local web server for communicating state changes using sockjs,
serving a copy of the Neuroglancer client code, and for serving data to the
Neuroglancer client if Python data sources are used.

## Installation

It is recommended that you activate a suitable Python virtual environment before installing.

Python 3.5 or later is required.

You can install the latest published package from [PyPI](https://pypi.org/project/neuroglancer)
with:

```shell
pip install neuroglancer
```

In most cases, this will use a prebuilt binary wheel, which requires neither node.js (to build the
Neuroglancer client) nor a C++ compiler.  If no binary wheel is available for your platform, a
source distribution (sdist) will be used instead, which requires a C++ compiler to build but does
not require node.js (the source distribution includes a prebuilt copy of the Neuroglancer client).

### Direct installation from remote git repository

To install the latest version from the Neuroglancer git repository, you can use:

```shell
pip install git+https://github.com/google/neuroglancer
```

Note that installing from a git repository requires Node.js and a C++ compiler.

To install a specific commit `XXXXXXXXX`:

```shell
pip install git+https://github.com/google/neuroglancer@XXXXXXXXX
```

In another Python package, you can declare a dependency on a git version using the syntax:

```python
setup(
    name='<package>',
    ...,
    install_requires=[
        ...,
        'neuroglancer @ git+https://github.com/google/neuroglancer@XXXXXXXXX',
    ],
)
```

### Installation from local checkout of git repository

You can also install from a local checkout of the git repository.  Two forms of installation are
supported: normal installation, and an editable installation for development purposes.

As with installation from a remote git repository, installation from a local checkout requires
Node.js to build the Neuroglancer client and a C++ compiler to build the C++ mesh generation
extension module.

#### Normal installation

For normal installation, run the following from the root of the repository:

```shell
python setup.py install
```

That will automatically build the Neuroglancer client using Node.js if it has not already been built
(i.e. if `neuroglancer/static/index.html` does not exist).  To rebuild the Neuroglancer client
explicitly, you can use:

```shell
python setup.py bundle_client
```

or

```shell
npm run build-python
```

Note: Installing from a local checkout using `pip install .` also works, but it may be slower
because it makes a full copy of the local directory (https://github.com/pypa/pip/pull/7882),
including the possibly-large `.git` and `node_modules` directories.

#### Editable installation (for development purposes)

During development, an *editable* installation allows the package to be imported directly from the
local checkout directory:

```shell
pip install -e .
```

Any changes you make to the .py source files take effect the next time the package is imported,
without the need to reinstall.  If you make changes to the Neuroglancer client, you still need to
rebuild it with `npm run build-python`.  You can also keep the Neuroglancer client continuously
up-to-date by running `npm run dev-server-python`.

## Examples

See the example programs in the [examples/](examples/) directory.  Run them
using the Python interpreter in interactive mode, e.g.

```shell
python -i example.py
```

or using the IPython magic command

```
%run -i python.py
```

Do not run an example non-interactively as

```shell
python example.py
```
because then the server will exit immediately.

## Mesh generation

For in-memory segmentation volumes, mesh representations of the surface of each
object can be generated on-demand as they are requested by the client (e.g. due
to the user selecting a segment)

## Security

By default the server binds only to the `127.0.0.1` address, and for protection
against cross-site scripting attacks only accepts requests that include a valid
randomly-generated 160-bit secret key.

## Test suite

The test suite can be run using the `tox` command.  Some of the tests require a WebGL2-enabled web
browser in order to test interaction with the Neuroglancer client.  Both Chrome and Firefox are
supported, but currently due to bugs in Swiftshader, Chrome Headless does not work.  Firefox
Headless also currently does not support WebGL at all.  On Linux, you can successfully run the tests
headlessly on Firefox using `xvfb-run`.  On other platforms, tests can't be run headlessly.

```shell
# For headless using Firefox on xvfb (Linux only)
sudo apt-get instrall xvfb # On Debian-based systems
tox -e firefox-xvfb  # Run tests using non-headless Firefox

# For non-headless using Chrome
tox -e chrome

# For non-headless using Firefox
tox -e firefox

# To run only tests that do not require a browser
tox -e skip-browser-tests
```

Refer to [tox.ini](../tox.ini) for details of the test procedure.
