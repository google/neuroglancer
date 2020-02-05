# coding=utf-8
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
"""Interface for controlling a browser that runs Neuroglancer."""

from __future__ import absolute_import

import time

class Webdriver(object):

    def __init__(self, viewer=None, headless=True, window_size=(1920, 1080)):
        import selenium.webdriver
        import selenium.webdriver.chrome.options
        import selenium.webdriver.common.desired_capabilities
        try:
            # Use chromedriver_binary package if available
            import chromedriver_binary
        except ImportError:
            # Fallback to system chromedriver
            pass
        if viewer is None:
            from .viewer import Viewer
            viewer = Viewer()
        self.viewer = viewer
        chrome_options = selenium.webdriver.chrome.options.Options()
        if headless:
            chrome_options.add_argument('--headless')
        chrome_options.add_argument('--window_size=%dx%d' % (window_size[0], window_size[1]))
        caps = selenium.webdriver.common.desired_capabilities.DesiredCapabilities.CHROME.copy()
        caps['goog:loggingPrefs'] = {'browser': 'ALL'}
        self.driver = selenium.webdriver.Chrome(options=chrome_options, desired_capabilities=caps)
        self.driver.get(viewer.get_viewer_url())

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.driver.close()

    def get_log(self):
        return self.driver.get_log('browser')

    def sync(self):
        """Wait until client is ready."""
        while True:
            new_state = self.viewer.screenshot().viewer_state
            # Ensure self.viewer.state has also been updated to the new state.
            # The state sent in the screenshot reply can be newer.
            if new_state == self.viewer.state:
                return new_state
            time.sleep(0.1)

    @property
    def root_element(self):
        return self.driver.find_element_by_xpath('//body')

    def action_chain(self):
        import selenium.webdriver
        return selenium.webdriver.common.action_chains.ActionChains(self.driver)
