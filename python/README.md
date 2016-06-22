Neuroglancer Python Package
===========================

This package provides a python interface to the [neuroglancer project](https://github.com/google/neuroglancer).

Usage
=====

The only method you need to call is `neuroglancer.server`, which you give a
dictionary of names to `numpy` arrays. `neuroglancer.serve` will run a local
HTTP server (by default on port 8888). It returns the URL under which you can
access the neuroglancer viewer.

Example:
```python
#!/usr/bin/env python

import neuroglancer
import numpy as np
import signal
import sys

def stop(signal, frame):
    neuroglancer.stop()
    sys.exit(0)

a = np.ones((100,100,100), dtype=np.uint8)*255
b = np.random.randint(0, 100, (100,1000,1000), dtype=np.uint64)

layers = [
    ('first', a),
    ('second', b)
]

print neuroglancer.serve(layers, server_args = { 'bind_address': '127.0.0.1' })

signal.signal(signal.SIGINT, stop)
print('Server started, press Ctrl+C to stop')
signal.pause()
```

To start the server on a different port, provide an additional `'bind_port'`
argument in `server_args`.

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
