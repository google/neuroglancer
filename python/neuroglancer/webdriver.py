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
from collections.abc import Sequence
from typing import Callable, NamedTuple, Optional


class LogMessage(NamedTuple):
    message: str
    level: Optional[str]


LogListener = Callable[[LogMessage], None]


class WebdriverBase:
    def __init__(
        self,
        headless=True,
        browser="chrome",
        window_size=(1920, 1080),
        debug=False,
        docker=False,
        print_logs=True,
        extra_command_line_args: Optional[Sequence[str]] = None,
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
        self._log_listeners_lock = threading.Lock()
        self._log_listeners: dict[LogListener, None] = {}

        if print_logs:
            self.add_log_listener(
                lambda log: print(
                    f"console.{log.level}: {log.message}", file=sys.stderr
                )
            )

        self._closed = False
        self._init_driver()

    def _init_chrome(self):
        import selenium.webdriver

        chrome_options = selenium.webdriver.ChromeOptions()
        if self.headless:
            chrome_options.add_argument("--headless=new")
        chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
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
        self.driver = selenium.webdriver.Firefox(
            options=options,
        )

    def _init_driver(self):
        import trio

        if self.browser == "chrome":
            self._init_chrome()
        elif self.browser == "firefox":
            self._init_firefox()
        else:
            raise ValueError(
                f'unsupported browser: {self.browser}, must be "chrome" or "firefox"'
            )

        def log_handler(driver):
            async def start_listening(listener):
                async for event in listener:
                    message = LogMessage(message=event.args[0].value, level=event.type_)
                    with self._log_listeners_lock:
                        for listener in self._log_listeners:
                            listener(message)

            async def start_listening_for_exceptions(listener):
                async for event in listener:
                    message = LogMessage(
                        message=event.exception_details.text, level="exception"
                    )
                    with self._log_listeners_lock:
                        for listener in self._log_listeners:
                            listener(message)

            async def run():
                async with self.driver.bidi_connection() as connection:
                    session, devtools = connection.session, connection.devtools
                    await session.execute(devtools.page.enable())
                    await session.execute(devtools.runtime.enable())
                    listener = session.listen(devtools.runtime.ConsoleAPICalled)
                    exception_listener = session.listen(
                        devtools.runtime.ExceptionThrown
                    )
                    with trio.CancelScope() as cancel_scope:
                        async with trio.open_nursery() as nursery:
                            nursery.start_soon(start_listening, listener)
                            nursery.start_soon(
                                start_listening_for_exceptions, exception_listener
                            )
                            while True:
                                await trio.sleep(2)
                                if not driver.service.is_connectable():
                                    cancel_scope.cancel()

            trio.run(run)

        t = threading.Thread(target=log_handler, args=(self.driver,))
        t.daemon = True
        t.start()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.driver.quit()
        self._closed = True

    def add_log_listener(self, listener: LogListener):
        with self._log_listeners_lock:
            self._log_listeners[listener] = None

    def remove_log_listener(self, listener: LogListener):
        with self._log_listeners_lock:
            return self._log_listeners.pop(listener, True) is None

    @contextlib.contextmanager
    def log_listener(self, listener: LogListener):
        try:
            self.add_log_listener(listener)
            yield
        finally:
            self.remove_log_listener(listener)

    @contextlib.contextmanager
    def wait_for_log_message(self, pattern: str, timeout: Optional[float] = None):
        event = threading.Event()

        def handle_message(msg):
            if event.is_set():
                return
            if re.fullmatch(pattern, msg.message):
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
        import selenium.webdriver

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
