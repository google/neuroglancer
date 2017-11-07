# @license
# Copyright 2016 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import os
import posixpath

static_content_filenames = set(['main.bundle.js', 'chunk_worker.bundle.js', 'styles.css', 'index.html'])

mime_type_map = {
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.html': 'text/html',
    '.map': 'application/json'
}


def guess_mime_type_from_path(path):
    return mime_type_map.get(posixpath.splitext(path)[1], 'application/octet-stream')


class StaticContentSource(object):
    def get(self, name):
        if name == '':
            name = 'index.html'
        return self.get_content(name), guess_mime_type_from_path(name)

    def get_content(self, name):
        raise NotImplementedError


class PkgResourcesContentSource(StaticContentSource):
    def get_content(self, name):
        import pkg_resources
        if name not in static_content_filenames:
            raise ValueError('Invalid static resource name: %r' % name)
        if pkg_resources.resource_exists(__name__, name):
            return pkg_resources.resource_string(__name__, name)
        raise ValueError(
            'Static resources not built.  Run: "python setup.py bundle_client" or use an alternative static content source.'
        )


class HttpSource(StaticContentSource):
    def __init__(self, url):
        self.url = url

    def get_content(self, name):
        import requests
        full_url = posixpath.join(self.url, name)
        r = requests.get(full_url)
        if r.status_code >= 200 and r.status_code < 300:
            return r.content
        raise ValueError('Failed to retrieve %r: %s' % (full_url, r.reason))


class FileSource(StaticContentSource):
    def __init__(self, path=None, file_open=open):
        if path is None:
            path = os.path.join(os.path.dirname(__file__), '../../../dist/dev-python')
        self.file_path = path
        self.file_open = file_open

    def get_content(self, name):
        full_path = os.path.join(self.file_path, name)
        try:
            with self.file_open(full_path, 'rb') as f:
                return f.read()
        except Exception as e:
            raise ValueError('Failed to read local path %r: %s' % (full_path, e))


dist_dev_static_content_source = FileSource()


def get_default_static_content_source():
    return PkgResourcesContentSource()


def get_static_content_source(source=None, url=None, path=None, file_open=None):
    if source is not None:
        return source
    elif url is not None:
        return HttpSource(url)
    elif path is not None:
        return FileSource(path=path, file_open=file_open)
    else:
        return get_default_static_content_source()
