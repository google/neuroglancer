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

## Example

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
to the user selecting a segment).  This requires that the C++ extension module
be built.  If you install this Python package normally, that will happen
automatically.  For development, see the instructions below.

## Security

By default the server binds only to the `127.0.0.1` address, and for protection
against cross-site scripting attacks only accepts requests that include a valid
randomly-generated 160-bit secret key.

## Development

## Building the C++ extension module

Mesh generation for segmentation volumes depends on a C++ extension module.  To
build it, activate a suitable Python virtual environment and run:

```shell
pip install -e .
```

### Serving the Neuroglancer client code

By default, a bundled copy of the Neuroglancer client code (HTML, CSS,
JavaScript) is served from the [neuroglancer/static](neuroglancer/static)
directory.  You can build this bundled copy by running

``` shell
python setup.py bundle_client
```

This requires a suitable version of [Node.js](https://nodejs.org/), as dsecribed
in the [top level README](../README.md).  The
[PyPI package](https://pypi.python.org/pypi/neuroglancer/) includes a prebuilt
copy of these files.

The Neuroglancer client code can also be served from several other locations,
for convenience during development.

For example, while developing the Neuroglancer client, you can run the shell command

```shell
npm run dev-server-python
```
to start the `webpack-dev-server` on <http://localhost:8080> and then call

```python
neuroglancer.set_static_content_source(url='http://localhost:8080')
```
from Python.  With this setup, refreshing the browser will automatically reflect any changes to
the client source code.

### Publishing to PyPI

This package is maintained at [PyPI](https://pypi.python.org/pypi/neuroglancer/).

To upload a new version, create a `~/.pypirc` file with the following content:
```
[distutils]
index-servers =
  pypi
  testpypi

[pypi]
username=neuroglancer
password=xxxx

[pypitest]
repository=https://test.pypi.org/legacy/
username=neuroglancer
password=xxxx
```

To publish a new version, run the following command:

```shell
python setup.py bundle_client sdist
twine upload dist/*
```
