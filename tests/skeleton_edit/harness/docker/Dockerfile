FROM catmaid/catmaid@sha256:9e939ffe15ce6e67e198c04274dc487f25511a48c9594d1dd5ede17260d57ddd

# This image's coreapi imports pkg_resources, which setuptools 82 removed.
RUN /home/env/bin/python -m pip install --no-cache-dir setuptools==80.9.0
