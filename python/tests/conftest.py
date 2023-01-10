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
import atexit
import asyncio
import concurrent.futures
import os
import pathlib
import threading

import neuroglancer.webdriver
import pytest
import tornado.httpserver
import tornado.netutil
import tornado.platform
import tornado.web


def pytest_addoption(parser):
    parser.addoption('--headless',
                     action='store_true',
                     default=False,
                     help='Run Chrome browser headless')
    parser.addoption('--debug-webdriver',
                     action='store_true',
                     default=False,
                     help='Show webdriver debug logs')
    parser.addoption('--webdriver-docker',
                     action='store_true',
                     default=False,
                     help='Use webdriver configuration that supports running inside docker')
    parser.addoption('--static-content-url', default=None, help='URL to Neuroglancer Python client')
    parser.addoption('--browser',
                     choices=['chrome', 'firefox'],
                     default='chrome',
                     help='Specifies the browser to use.')
    parser.addoption('--skip-browser-tests',
                     action='store_true',
                     default=False,
                     help='Skip tests that rely on a web browser.')
    parser.addoption('--failure-screenshot-dir',
                     help="Save screenshots to specified directory in case of test failures.")


@pytest.fixture(scope='session')
def _webdriver_internal(request):
    if request.config.getoption('--skip-browser-tests'):
        pytest.skip('--skip-browser-tests')
    static_content_url = request.config.getoption('--static-content-url')
    if static_content_url is not None:
        neuroglancer.set_static_content_source(url=static_content_url)
    webdriver = neuroglancer.webdriver.Webdriver(
        headless=request.config.getoption('--headless'),
        docker=request.config.getoption('--webdriver-docker'),
        debug=request.config.getoption('--debug-webdriver'),
        browser=request.config.getoption('--browser'),
    )
    atexit.register(webdriver.driver.close)
    return webdriver


# https://docs.pytest.org/en/latest/example/simple.html#making-test-result-information-available-in-fixtures
@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    # execute all other hooks to obtain the report object
    outcome = yield
    rep = outcome.get_result()

    # set a report attribute for each phase of a call, which can
    # be "setup", "call", "teardown"

    setattr(item, "rep_" + rep.when, rep)


@pytest.fixture
def webdriver(_webdriver_internal, request):
    viewer = _webdriver_internal.viewer
    viewer.set_state({})
    viewer.actions.clear()
    viewer.config_state.set_state({})
    yield _webdriver_internal
    if request.node.rep_setup.passed and request.node.rep_call.failed:
        screenshot_dir = request.config.getoption('--failure-screenshot-dir')
        if screenshot_dir:
            # Collect screenshot
            os.makedirs(screenshot_dir, exist_ok=True)
            _webdriver_internal.driver.save_screenshot(
                os.path.join(screenshot_dir, request.node.nodeid + ".png"))


class CorsStaticFileHandler(tornado.web.StaticFileHandler):

    def set_default_headers(self):
        self.set_header("Access-Control-Allow-Origin", "*")
        self.set_header("Access-Control-Allow-Headers", "x-requested-with")
        self.set_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')

    def options(self, *args):
        self.set_status(204)
        self.finish()


def _start_server(bind_address: str, output_dir: str) -> int:

    token = neuroglancer.random_token.make_random_token()
    handlers = [
        (fr'/{token}/(.*)', CorsStaticFileHandler, {
            'path': output_dir
        }),
    ]
    settings = {}
    app = tornado.web.Application(handlers, settings=settings)

    http_server = tornado.httpserver.HTTPServer(app)
    sockets = tornado.netutil.bind_sockets(port=0, address=bind_address)
    http_server.add_sockets(sockets)
    actual_port = sockets[0].getsockname()[1]
    url = neuroglancer.server._get_server_url(bind_address, actual_port)
    return f'{url}/{token}'


@pytest.fixture
def tempdir_server(tmp_path: pathlib.Path):

    bind_address = "localhost"

    server_url_future = concurrent.futures.Future()

    ioloop = None

    def run_server():
        nonlocal ioloop
        try:
            ioloop = tornado.platform.asyncio.AsyncIOLoop()
            ioloop.make_current()
            asyncio.set_event_loop(ioloop.asyncio_loop)
            server_url_future.set_result(_start_server(bind_address, str(tmp_path)))
        except Exception as e:
            server_url_future.set_exception(e)
            return
        ioloop.start()
        ioloop.close()

    thread = threading.Thread(target=run_server)
    try:
        thread.start()
        server_url = server_url_future.result()
        yield (tmp_path, server_url)
    finally:
        if ioloop is not None:
            ioloop.add_callback(ioloop.stop)
        thread.join()
