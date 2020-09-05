# @license
# Copyright 2020 Google Inc.
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


def add_server_arguments(ap):
    """Defines common options for the Neuroglancer server."""
    g = ap.add_argument_group(title='Neuroglancer server options')
    g.add_argument(
        '--bind-address',
        help='Bind address for Python web server.  Use 127.0.0.1 (the default) to restrict access '
        'to browers running on the local machine, use 0.0.0.0 to permit access from remote browsers.'
    )
    g.add_argument('--static-content-url',
                   help='Obtain the Neuroglancer client code from the specified URL.')
    g.add_argument('--debug-server',
                   action='store_true',
                   help='Log requests to web server used for Neuroglancer Python API')


def add_state_arguments(ap, required=False, dest='state'):
    """Defines options for specifying a Neuroglancer state."""
    g = ap.add_mutually_exclusive_group(required=required)

    def neuroglancer_url(s):
        from .url_state import parse_url
        return parse_url(s)

    g.add_argument('--url',
                   type=neuroglancer_url,
                   dest=dest,
                   help='Neuroglancer URL from which to obtain state.')

    def json_state(path):
        import json
        from . import viewer_state
        with open(path, 'r') as f:
            return viewer_state.ViewerState(json.load(f))

    g.add_argument('--json',
                   type=json_state,
                   dest=dest,
                   help='Path to file containing Neuroglancer JSON state.')


def handle_server_arguments(args):
    """Handles the options defined by `add_server_arguments`."""
    from . import server

    if args.bind_address:
        server.set_server_bind_address(args.bind_address)
    if args.static_content_url:
        server.set_static_content_source(url=args.static_content_url)
    if args.debug_server:
        server.debug = True
