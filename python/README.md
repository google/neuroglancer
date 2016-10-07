# Neuroglancer Python Integration

This package provides a Python interface for viewing in-memory arrays with
[Neuroglancer](https://github.com/google/neuroglancer), a web-based 3-d
volumetric data viewer.

It uses the builtin `BaseHTTPServer` Python package to start a local HTTP server
for both serving data to the Neuroglancer client and serving a copy of the
Neuroglancer client code.

## Usage

Using the `neuroglancer.Viewer` class, you can specify one or more array to
display as separate layers.  Both 3-d `(z, y, x)` and 4-d `(channel, z, y, x)`
formats are supported.  In addition to NumPy arrays, compatible types like
[h5py](http://www.h5py.org) arrays are also supported.  After specifying the
arrays, you can obtain a URL for accessing the viewer.

If the contents of an array changes after the viewer is opened, you can refresh
the browser to see the latest version.

The running Python server will hold a reference to any array specified to the
viewer, which will prevent the array from being garbage collected.  While in
many cases this is desirable, in long-running Python instances this can lead to
a memory leak.  To release all references to previously-specified arrays and
shutdown the running server, call

```python
neuroglancer.stop()
```

This will invalidate any existing URLs.

## Example

See the [example.py](example.py) script.  You can run it as:

```shell
python -i example.py
```

or using the IPython magic command

```
%run -i python.py
```

Do not run the example non-interactively as

```shell
python example.py
```
because then the server will exit immediately.

## Mesh generation

For segmentation volumes, mesh representations of the surface of each object can
be generated on-demand as they are requested by the client (e.g. due to the user
selecting a segment).  This requires that the C++ extension module be built.  If
you install this Python package normally, that will happen automatically.  For
development, see the instructions below.

## Security

By default the server binds only to the `127.0.0.1` address, and for protection
against cross-site scripting attacks only accepts requests that include a valid
randomly-generated 160-bit secret key.

## Development

## Building the C++ extension module

Mesh generation for segmentation volumes depends on a C++ extension module.  To
build it, activate a suitable Python virtual environment and run:

```shell
python setup.py develop
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
npm run dev-server
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
  pypitest

[pypi]
repository=https://pypi.python.org/pypi
username=neuroglancer
password=xxxx

[pypitest]
repository=https://testpypi.python.org/pypi
username=neuroglancer
password=xxxx
```

You have to register once with the PyPI server:
```shell
python setup.py register -r pypi
```

To publish a new version, run the following command:

```shell
python setup.py bundle_client sdist upload -r pypi
```
