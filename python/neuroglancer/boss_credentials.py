import logging
import os
import threading
from configparser import ConfigParser

from . import credentials_provider
from .futures import run_on_new_thread


class BossCredentialsProvider(credentials_provider.CredentialsProvider):
    def __init__(self):
        super().__init__()

        # Make sure logging is initialized.  Does nothing if logging has already
        # been initialized.
        logging.basicConfig()

        self._lock = threading.Lock()
        self._credentials = None

    def set_token(self, token):
        # Token should be a string
        self._credentials = dict(tokenType="Token", accessToken=token)

    def get_new(self):
        def func():
            with self._lock:
                # First, see if user has defined a token using set_token
                if self._credentials is not None:
                    return self._credentials

                # If not, look for config file in intern file location
                config_path = "~/.intern/intern.cfg"
                if os.path.isfile(os.path.expanduser(config_path)):
                    with open(os.path.expanduser(config_path)) as config_file_handle:
                        config_parser = ConfigParser()
                        config_parser.read_file(config_file_handle)
                        # Try Default section first
                        try:
                            self._credentials = config_parser["Default"]["token"]
                            print("Using token from intern config file")
                            return dict(
                                tokenType="Token", accessToken=self._credentials
                            )
                        except Exception:
                            pass
                        # Try Volume Service section second
                        try:
                            self._credentials = config_parser["Volume Service"]["token"]
                            print("Using token from intern config file")
                            return dict(
                                tokenType="Token", accessToken=self._credentials
                            )
                        except Exception:
                            pass

                # Else, use "public"
                print("Accessing Boss data using token 'public'")
                return dict(tokenType="Token", accessToken="public")

        return run_on_new_thread(func)
