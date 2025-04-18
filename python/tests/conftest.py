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

import os
import pathlib
import threading
from collections.abc import Callable, Iterator

import neuroglancer.static_file_server
import neuroglancer.webdriver
import pytest


def pytest_addoption(parser):
    parser.addoption(
        "--headless",
        action="store_true",
        default=False,
        help="Run Chrome browser headless",
    )
    parser.addoption(
        "--debug-webdriver",
        action="store_true",
        default=False,
        help="Show webdriver debug logs",
    )
    parser.addoption(
        "--webdriver-docker",
        action="store_true",
        default=False,
        help="Use webdriver configuration that supports running inside docker",
    )
    parser.addoption(
        "--neuroglancer-server-debug",
        action="store_true",
        default=False,
        help="Debug the Neuroglancer web server.",
    )
    parser.addoption(
        "--static-content-url", default=None, help="URL to Neuroglancer Python client"
    )
    parser.addoption(
        "--build-client",
        action="store_true",
        default=False,
        help="Test using a client built from source automatically.",
    )
    parser.addoption(
        "--browser",
        choices=["chrome", "firefox"],
        default="chrome",
        help="Specifies the browser to use.",
    )
    parser.addoption(
        "--browser-binary-path",
        help="Overrides default browser executable path.",
    )
    parser.addoption(
        "--skip-browser-tests",
        action="store_true",
        default=False,
        help="Skip tests that rely on a web browser.",
    )
    parser.addoption(
        "--failure-screenshot-dir",
        help="Save screenshots to specified directory in case of test failures.",
    )


def _setup_webdriver(request, cls):
    webdriver = cls(
        headless=request.config.getoption("--headless"),
        docker=request.config.getoption("--webdriver-docker"),
        debug=request.config.getoption("--debug-webdriver"),
        browser=request.config.getoption("--browser"),
        browser_binary_path=request.config.getoption("--browser-binary-path"),
    )

    # Note: Regular atexit functions are run only after non-daemon threads are joined.
    # However, Selenium creates a non-daemon thread for bidi websocket communication,
    # which blocks Python from exiting.
    #
    # The `threading._register_atexit` function registers an early atexit callback to be
    # invoked *before* non-daemon threads are joined.
    threading._register_atexit(webdriver.driver.quit)
    return webdriver


@pytest.fixture(scope="session")
def _webdriver_internal(request):
    if request.config.getoption("--skip-browser-tests"):
        pytest.skip("--skip-browser-tests")
    if request.config.getoption("--build-client"):
        neuroglancer.set_dev_server_content_source()
    else:
        static_content_url = request.config.getoption("--static-content-url")
        if static_content_url is not None:
            neuroglancer.set_static_content_source(url=static_content_url)
    webdriver = _setup_webdriver(request, neuroglancer.webdriver.Webdriver)
    if request.config.getoption("--neuroglancer-server-debug"):
        neuroglancer.server.debug = True
    return webdriver


@pytest.fixture(scope="session")
def webdriver_generic(request):
    if request.config.getoption("--skip-browser-tests"):
        pytest.skip("--skip-browser-tests")
    webdriver = _setup_webdriver(request, neuroglancer.webdriver.WebdriverBase)
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


# browser-based tests are flaky and can hang, so set a 30 second timeout and retry up to 5 times.
# Use `func_only=true` to work around https://github.com/pytest-dev/pytest-rerunfailures/issues/99
@pytest.fixture(
    params=[
        pytest.param(
            None,
            marks=[
                pytest.mark.flaky(reruns=5),
                pytest.mark.timeout(timeout=30, func_only=True),
            ],
        )
    ]
)
def webdriver(_webdriver_internal, request):
    viewer = _webdriver_internal.viewer
    viewer.set_state({})
    viewer.actions.clear()
    viewer.config_state.set_state({})
    yield _webdriver_internal
    if request.node.rep_setup.passed and request.node.rep_call.failed:
        screenshot_dir = request.config.getoption("--failure-screenshot-dir")
        if screenshot_dir:
            # Collect screenshot
            os.makedirs(screenshot_dir, exist_ok=True)
            _webdriver_internal.driver.save_screenshot(
                os.path.join(screenshot_dir, request.node.nodeid + ".png")
            )


@pytest.fixture
def static_file_server() -> Iterator[Callable[[pathlib.Path], str]]:
    servers: list[neuroglancer.static_file_server.StaticFileServer] = []

    def serve_path(path: pathlib.Path):
        server = neuroglancer.static_file_server.StaticFileServer(str(path))
        servers.append(server)
        return server.url

    try:
        yield serve_path
    finally:
        for server in servers:
            server.request_stop()
        for server in servers:
            server.stop()


@pytest.fixture
def tempdir_server(tmp_path: pathlib.Path, static_file_server):
    yield (tmp_path, static_file_server(tmp_path))
