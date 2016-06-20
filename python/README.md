Neuroglancer Python Package
===========================

This package provides a python interface to the [neuroglancer project](https://github.com/google/neuroglancer).

Usage
=====

```python
to be written
```

Development
===========

This package is maintained at [PyPI](https://pypi.python.org/pypi).

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
python setup.py bundle_nodejs sdist upload -r pypi
```

The command `bundle_nodejs` requires that you have `node.js` installed (see
[top level README](../README.md) for how to install it). It will bundle the
javascript and CSS files and place them in the `neuroglancer/static` directory.
