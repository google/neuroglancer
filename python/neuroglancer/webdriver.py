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

import contextlib
import re
import sys
import threading
import time
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from selenium.webdriver.common.bidi.log import ConsoleLogEntry
else:
    ConsoleLogEntry = None

LogListener = Callable[[ConsoleLogEntry], None]


class WebdriverBase:
    def __init__(
        self,
        headless=True,
        browser="chrome",
        browser_binary_path: str | None = None,
        window_size=(1920, 1080),
        debug=False,
        docker=False,
        print_logs=True,
        extra_command_line_args: Sequence[str] | None = None,
    ):
        self.headless = headless
        self.browser = browser
        self.window_size = window_size
        self.headless = headless
        self.docker = docker
        self.extra_command_line_args = (
            list(extra_command_line_args) if extra_command_line_args else []
        )
        self.debug = debug
        self.browser_binary_path = browser_binary_path

        self._closed = False
        self._init_driver()

        if print_logs:
            self.add_log_listener(
                lambda log: print(f"console.{log.level}: {log.text}", file=sys.stderr)
            )

    def _init_chrome(self):
        import selenium.webdriver

        chrome_options = selenium.webdriver.ChromeOptions()
        chrome_options.enable_bidi = True
        if self.headless:
            chrome_options.add_argument("--headless=new")
        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
        if self.browser_binary_path:
            chrome_options.binary_location = self.browser_binary_path
        if self.docker:
            # https://www.intricatecloud.io/2019/05/running-webdriverio-tests-using-headless-chrome-inside-a-container/
            chrome_options.add_argument("--no-sandbox")
            chrome_options.add_argument("--disable-gpu")
            chrome_options.add_argument("--disable-setuid-sandbox")
            chrome_options.add_argument("--disable-dev-shm-usage")
        chrome_options.add_argument(
            "--window_size=%dx%d" % (self.window_size[0], self.window_size[1])
        )
        for arg in self.extra_command_line_args:
            chrome_options.add_argument(arg)
        self.driver = selenium.webdriver.Chrome(options=chrome_options)

    def _init_firefox(self):
        import selenium.webdriver

        options = selenium.webdriver.FirefoxOptions()
        if self.headless:
            options.add_argument("--headless")
        options.arguments.extend(self.extra_command_line_args)
        if self.browser_binary_path:
            options.binary_location = self.browser_binary_path
        options.enable_bidi = True
        self.driver = selenium.webdriver.Firefox(
            options=options,
        )

    def _init_driver(self):
        if self.browser == "chrome":
            self._init_chrome()
        elif self.browser == "firefox":
            self._init_firefox()
        else:
            raise ValueError(
                f'unsupported browser: {self.browser}, must be "chrome" or "firefox"'
            )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.driver.quit()
        self._closed = True

    def add_log_listener(self, listener: LogListener) -> Callable[[], None]:
        console_id = self.driver.script.add_console_message_handler(listener)
        error_id = self.driver.script.add_javascript_error_handler(listener)

        def unregister():
            self.driver.script.remove_console_message_handler(console_id)
            self.driver.script.remove_javascript_error_handler(error_id)

        return unregister

    @contextlib.contextmanager
    def log_listener(self, listener: LogListener):
        unregister = self.add_log_listener(listener)
        try:
            yield
        finally:
            unregister()

    @contextlib.contextmanager
    def wait_for_log_message(self, pattern: str, timeout: float | None = None):
        event = threading.Event()

        def handle_message(msg):
            if event.is_set():
                return
            if re.fullmatch(pattern, msg.text):
                event.set()

        with self.log_listener(handle_message):
            yield
            if not event.wait(timeout):
                raise TimeoutError

    def reload_browser(self):
        """Reloads the browser (useful if it crashes/becomes unresponsive)."""
        try:
            self.driver.quit()
        except Exception:
            pass
        self._init_driver()

    @property
    def root_element(self):
        return self.driver.find_element("xpath", "//body")

    def action_chain(self):
        import selenium.webdriver.common.action_chains

        return selenium.webdriver.common.action_chains.ActionChains(self.driver)


class Webdriver(WebdriverBase):
    def __init__(self, viewer=None, **kwargs):
        if viewer is None:
            from .viewer import Viewer

            viewer = Viewer()
        self.viewer = viewer
        super().__init__(**kwargs)

    def _init_driver(self):
        super()._init_driver()
        self.driver.get(self.viewer.get_viewer_url())

    def sync(self):
        """Wait until client is ready."""
        while True:
            new_state = self.viewer.screenshot().viewer_state
            # Ensure self.viewer.state has also been updated to the new state.
            # The state sent in the screenshot reply can be newer.
            if new_state == self.viewer.state:
                return new_state
            time.sleep(0.1)
