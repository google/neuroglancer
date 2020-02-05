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
import pytest
import neuroglancer.webdriver

def pytest_addoption(parser):
    parser.addoption('--headless',
                     action='store_true',
                     default=False,
                     help='Run Chrome browser headless')
    parser.addoption('--static-content-url',
                     default=None,
                     help='URL to Neuroglancer Python client')


@pytest.fixture(scope='session')
def _webdriver_internal(request):
    static_content_url = request.config.getoption('--static-content-url')
    if static_content_url is not None:
        neuroglancer.set_static_content_source(url=static_content_url)
    webdriver = neuroglancer.webdriver.Webdriver(headless=request.config.getoption('--headless'))
    atexit.register(webdriver.driver.close)
    return webdriver

@pytest.fixture
def webdriver(_webdriver_internal):
    viewer = _webdriver_internal.viewer
    viewer.set_state({})
    viewer.actions.clear()
    viewer.config_state.set_state({})
    return _webdriver_internal
