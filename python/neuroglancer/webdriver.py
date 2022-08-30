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

from typing import Sequence, Optional

import tempfile
import time
import threading


class Webdriver:
    def __init__(self,
                 viewer=None,
                 headless=True,
                 browser='chrome',
                 window_size=(1920, 1080),
                 debug=False,
                 docker=False,
                 print_logs=True,
                 extra_command_line_args: Optional[Sequence[str]] = None):
        if viewer is None:
            from .viewer import Viewer
            viewer = Viewer()
        self.viewer = viewer
        self.headless = headless
        self.browser = browser
        self.window_size = window_size
        self.headless = headless
        self.docker = docker
        self.extra_command_line_args = list(extra_command_line_args) if extra_command_line_args else []
        self.debug = debug
        self._logfile = None
        if browser == 'firefox':
            self._logfile = tempfile.NamedTemporaryFile(suffix='neuroglancer-geckodriver.log')
        self._init_driver()
        self._pending_logs = []
        self._pending_logs_to_print = []
        self._logs_lock = threading.Lock()
        self._closed = False

        def print_log_handler():
            while True:
                logs_to_print = self._get_logs_to_print()
                if logs_to_print:
                    print('\n'.join(x['message'] for x in logs_to_print))
                if self._closed:
                    break
                time.sleep(1)

        t = threading.Thread(target=print_log_handler)
        t.daemon = True
        t.start()

    def _init_chrome(self):
        import selenium.webdriver
        import selenium.webdriver.chrome.options
        import selenium.webdriver.common.service
        import selenium.webdriver.chrome.service

        def patched_init(self, executable_path, port=0, service_args=None, log_path=None, env=None):
            log_path = '/dev/stderr'
            self.service_args = service_args or []
            if log_path:
                self.service_args.append('--log-path=%s' % log_path)
            selenium.webdriver.common.service.Service.__init__(
                self,
                executable_path,
                port=port,
                env=env,
                log_file=None,
                start_error_message=
                "Please see https://sites.google.com/a/chromium.org/chromedriver/home")

        import selenium.webdriver.common.desired_capabilities
        executable_path = 'chromedriver'
        try:
            # Use webdriver_manager package if available
            import webdriver_manager.chrome
            import webdriver_manager.core.utils
            chrome_version = None
            chrome_types = (webdriver_manager.core.utils.ChromeType.GOOGLE,
                            webdriver_manager.core.utils.ChromeType.CHROMIUM)
            for chrome_type in chrome_types:
                try:
                    chrome_version = webdriver_manager.core.utils.get_browser_version_from_os(chrome_type)
                    if chrome_version is not None:
                        break
                except:
                    if chrome_type == chrome_types[-1]:
                        raise

            executable_path = webdriver_manager.chrome.ChromeDriverManager(
                chrome_type=chrome_type).install()
        except ImportError:
            # Fallback to system chromedriver
            pass
        chrome_options = selenium.webdriver.chrome.options.Options()
        if self.headless:
            chrome_options.add_argument('--headless')
        chrome_options.add_experimental_option("excludeSwitches", ['enable-automation'])
        if self.docker:
            # https://www.intricatecloud.io/2019/05/running-webdriverio-tests-using-headless-chrome-inside-a-container/
            chrome_options.add_argument('--no-sandbox')
            chrome_options.add_argument('--disable-gpu')
            chrome_options.add_argument('--disable-setuid-sandbox')
            chrome_options.add_argument('--disable-dev-shm-usage')
        chrome_options.add_argument('--window_size=%dx%d' %
                                    (self.window_size[0], self.window_size[1]))
        for arg in self.extra_command_line_args:
            chrome_options.add_argument(arg)
        caps = selenium.webdriver.common.desired_capabilities.DesiredCapabilities.CHROME.copy()
        caps['goog:loggingPrefs'] = {'browser': 'ALL'}
        try:
            orig_init = selenium.webdriver.chrome.service.Service.__init__
            if self.debug:
                selenium.webdriver.chrome.service.Service.__init__ = patched_init
            self.driver = selenium.webdriver.Chrome(executable_path=executable_path,
                                                    options=chrome_options,
                                                    desired_capabilities=caps)
        finally:
            if self.debug:
                selenium.webdriver.chrome.service.Service.__init__ = orig_init

    def _init_firefox(self):
        import selenium.webdriver
        import selenium.webdriver.firefox.firefox_binary
        executable_path = 'geckodriver'
        try:
            # Use webdriver_manager package if available
            import webdriver_manager.firefox
            executable_path = webdriver_manager.firefox.GeckoDriverManager().install()
        except (ImportError, SyntaxError):
            # Fallback to system geckodriver
            pass
        profile = selenium.webdriver.FirefoxProfile()
        profile.set_preference('devtools.console.stdout.content', True)
        binary = selenium.webdriver.firefox.firefox_binary.FirefoxBinary()
        for arg in self.extra_command_line_args:
            binary.add_command_line_options(arg)
        self.driver = selenium.webdriver.Firefox(firefox_profile=profile,
                                                 executable_path=executable_path,
                                                 firefox_binary=binary,
                                                 service_log_path=self._logfile.name)

    def _init_driver(self):
        if self.browser == 'chrome':
            self._init_chrome()
        elif self.browser == 'firefox':
            self._init_firefox()
        else:
            raise ValueError('unsupported browser: %s, must be "chrome" or "firefox"' %
                             (self.browser, ))
        self.driver.get(self.viewer.get_viewer_url())

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self._logfile is not None:
            self._logfile.file.close()
            self._logfile = None
        self.driver.quit()
        self._closed = True

    def _get_new_logs(self):
        if self.browser == 'chrome':
            new_logs = self.driver.get_log('browser')
        else:
            cur_offset = self._logfile.file.tell()
            new_data = self._logfile.file.read()
            # rfind may return -1, still works
            end_within_data = new_data.rfind(b'\n') + 1
            new_data = new_data[:end_within_data]
            self._logfile.file.seek(cur_offset + end_within_data)
            new_logs = []
            for msg in new_data.decode().split('\n'):
                msg = msg.strip()
                if not msg: continue
                if (not msg.startswith('console.log: ') and not msg.startswith('JavaScript ')):
                    continue
                new_logs.append({'message': msg})
        self._pending_logs.extend(new_logs)
        self._pending_logs_to_print.extend(new_logs)

    def _get_logs_to_print(self):
        with self._logs_lock:
            self._get_new_logs()
            new_logs = self._pending_logs_to_print
            self._pending_logs_to_print = []
            return new_logs

    def get_log(self):
        with self._logs_lock:
            self._get_new_logs()
            new_logs = self._pending_logs
            self._pending_logs = []
            return new_logs

    def get_log_messages(self):
        return '\n'.join(x['message'] for x in self.get_log())

    def sync(self):
        """Wait until client is ready."""
        while True:
            new_state = self.viewer.screenshot().viewer_state
            # Ensure self.viewer.state has also been updated to the new state.
            # The state sent in the screenshot reply can be newer.
            if new_state == self.viewer.state:
                return new_state
            time.sleep(0.1)

    def reload_browser(self):
        """Reloads the browser (useful if it crashes/becomes unresponsive)."""
        with self._logs_lock:
            try:
                self.driver.quit()
            except:
                pass
            self._init_driver()

    @property
    def root_element(self):
        return self.driver.find_element('xpath', '//body')

    def action_chain(self):
        import selenium.webdriver
        return selenium.webdriver.common.action_chains.ActionChains(self.driver)
