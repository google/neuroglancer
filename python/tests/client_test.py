"""Tests that screenshots of the example projects match neuroglancer itself.

This validates that the example project configurations are correct.
"""

import base64
import concurrent.futures
import hashlib
import io
import json
import os
import pickle
import re
import signal
import subprocess
import sys
import threading
import time

import filelock
import neuroglancer.static_file_server
import neuroglancer.webdriver
import numpy as np
import PIL.Image
import pytest
import pytest_html  # type: ignore[import-untyped,import]

root_dir = os.path.join(os.path.dirname(__file__), "..", "..")
examples_dir = os.path.join(os.path.dirname(__file__), "..", "..", "examples")


def capture_screenshot_from_dev_server(
    webdriver, example_dir, test_fragment, extra_args=None
):
    if sys.platform == "win32":
        process_group_args = dict(creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    else:
        # Technically, it would be better to use just a new process group rather
        # than a new session, as we would like the subprocesses to still be
        # considered part of the same session.  However, the parcel dev server
        # causes this test to hang when using a new process group rather than a
        # new session.
        process_group_args = dict(start_new_session=True)
    p = subprocess.Popen(
        ["npm", "run", "dev-server", "--"] + (extra_args or []),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=example_dir,
        encoding="utf-8",
        **process_group_args,
    )

    try:
        future = concurrent.futures.Future()

        def thread_func(f):
            url = None
            for line in f:
                print(f"[dev-server] {line.rstrip()}")
                if url is None:
                    m = re.search(r"http://[^,\s]+", line)
                    if m is not None:
                        url = m.group(0)
                        future.set_result(url)
            if url is None:
                future.set_result(None)

        thread = threading.Thread(target=thread_func, args=(p.stdout,))
        thread.start()

        print("waiting for url")
        while True:
            try:
                url = future.result(timeout=1)
                break
            except concurrent.futures.TimeoutError:
                continue
        print(f"got url: {url}")

        assert url is not None

        return capture_screenshot(webdriver, url, test_fragment)
    finally:
        if sys.platform == "win32":
            p.send_signal(signal.CTRL_BREAK_EVENT)
        else:
            os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            p.kill()
        p.wait()


def capture_screenshot_from_build(
    webdriver,
    example_dir,
    test_fragment,
    output_dir=None,
    extra_args=None,
):
    subprocess.run(
        ["npm", "run", "build", "--"] + (extra_args or []), cwd=example_dir, check=True
    )
    if output_dir is None:
        output_dir = os.path.join(example_dir, "dist")

    with neuroglancer.static_file_server.StaticFileServer(output_dir) as url:
        return capture_screenshot(webdriver, f"{url}/index.html", test_fragment)


def capture_screenshot(webdriver, url, test_fragment):
    test_url = url + test_fragment

    original_window_handle = webdriver.driver.current_window_handle
    # Use a separate tab for each capture.  This avoids hitting the limit on
    # number of WebAssembly memories due to the Chrome back/forward cache.
    webdriver.driver.switch_to.new_window("tab")
    try:
        webdriver.driver.get(test_url)
        print("Capturing screenshot")
        while True:
            # When using `vite`, the page may reload automatically due to vite's
            # lazy "optimizing dependencies".
            if webdriver.driver.execute_script(
                "return typeof viewer !== 'undefined' && viewer.isReady();"
            ):
                break
            time.sleep(0.1)

        # Wait for chunk statistics to update
        time.sleep(0.5)

        return webdriver.driver.get_screenshot_as_png()
    finally:
        # Close previously-opened tab
        webdriver.driver.close()
        webdriver.driver.switch_to.window(original_window_handle)


TEST_FRAGMENT = "#!%7B%22dimensions%22:%7B%22x%22:%5B8e-9%2C%22m%22%5D%2C%22y%22:%5B8e-9%2C%22m%22%5D%2C%22z%22:%5B8e-9%2C%22m%22%5D%7D%2C%22position%22:%5B22316.904296875%2C21921.87890625%2C24029.763671875%5D%2C%22crossSectionScale%22:1%2C%22crossSectionDepth%22:-37.62185354999912%2C%22projectionOrientation%22:%5B-0.1470303237438202%2C0.5691322684288025%2C0.19562694430351257%2C0.7849844694137573%5D%2C%22projectionScale%22:118020.30607575581%2C%22layers%22:%5B%7B%22type%22:%22image%22%2C%22source%22:%22precomputed://gs://neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg%22%2C%22tab%22:%22source%22%2C%22name%22:%22emdata%22%7D%2C%7B%22type%22:%22segmentation%22%2C%22source%22:%22precomputed://gs://neuroglancer-janelia-flyem-hemibrain/v1.0/segmentation%22%2C%22tab%22:%22segments%22%2C%22segments%22:%5B%221944507292%22%5D%2C%22name%22:%22segmentation%22%7D%5D%2C%22showSlices%22:false%2C%22selectedLayer%22:%7B%22layer%22:%22segmentation%22%7D%2C%22layout%22:%22xy-3d%22%7D"


@pytest.fixture(scope="session")
def expected_screenshot(request, webdriver_generic):
    return get_xdist_session_value(
        lambda: capture_screenshot_from_dev_server(
            webdriver=webdriver_generic,
            example_dir=root_dir,
            test_fragment=TEST_FRAGMENT,
            extra_args=["--no-typecheck", "--no-lint"],
        ),
        request,
    )


EXAMPLE_DIRS = [
    f"examples/{bundler}/{bundler}-project-{package}"
    for bundler in [
        "vite",
        # Disable parcel since it currently has "failed to resolve bundle" errors.
        # "parcel",
        "webpack",
    ]
    for package in ["source", "built"]
]


# https://pytest-xdist.readthedocs.io/en/latest/how-to.html#making-session-scoped-fixtures-execute-only-once
def get_xdist_session_value(getter, request, *args, **kwargs):
    print(request.node.name)
    worker_id = request.getfixturevalue("worker_id")
    if worker_id == "master":
        # Not executing with multiple workers
        return getter()

    root_tmp_dir = request.getfixturevalue("tmp_path_factory").getbasetemp().parent
    temp_path = (
        root_tmp_dir
        / hashlib.sha256(
            json.dumps([request.fixturename, args, kwargs]).encode("utf-8")
        ).hexdigest()
    )
    with filelock.FileLock(str(temp_path) + ".lock"):
        if temp_path.is_file():
            return pickle.loads(temp_path.read_bytes())
        data = getter()
        temp_path.write_bytes(pickle.dumps(data))
        return data


@pytest.fixture(scope="session", params=EXAMPLE_DIRS)
def example_dir(request):
    return request.param


@pytest.fixture(scope="session")
def built_package(request):
    def do_build():
        subprocess.run(
            ["npm", "install", "--no-fund", "--no-audit"], cwd=root_dir, check=True
        )
        subprocess.run(["npm", "run", "build-package"], cwd=root_dir, check=True)

    get_xdist_session_value(
        do_build,
        request,
    )


@pytest.fixture(scope="session")
def installed_example_dir(request, example_dir):
    def do_install():
        subprocess.run(
            ["npm", "install", "--no-fund", "--no-audit"],
            cwd=os.path.join(root_dir, example_dir),
            check=True,
        )

    get_xdist_session_value(
        do_install,
        request,
        example_dir,
    )


def compare_screenshot(screenshot, expected_screenshot, extras, threshold=20):
    # Avoid doing comparison within `assert` because pytest's built-in diffing
    # is too slow.
    actual = np.asarray(PIL.Image.open(io.BytesIO(screenshot)))
    expected = np.asarray(PIL.Image.open(io.BytesIO(expected_screenshot)))

    absdiff = np.abs(
        np.asarray(actual, dtype=np.int16) - np.asarray(expected, dtype=np.int16)
    )

    max_difference = np.max(absdiff)

    mask = np.max(absdiff, axis=2) > threshold
    mask = mask[..., np.newaxis] * np.array([255, 255, 255, 255], dtype=np.uint8)
    mismatch = np.any(mask)

    mask_image_buffer = io.BytesIO()
    PIL.Image.fromarray(mask).save(mask_image_buffer, format="png")
    mask_image_encoded = mask_image_buffer.getvalue()

    expected_b64 = base64.b64encode(expected_screenshot).decode("utf-8")
    actual_b64 = base64.b64encode(screenshot).decode("utf-8")
    mask_b64 = base64.b64encode(mask_image_encoded).decode("utf-8")

    extras.append(
        pytest_html.extras.html(
            f"""
            <div style="position: relative;">
              <img src="data:image/png;base64,{expected_b64}"/>
              <img style="position: absolute; opacity: 0; display: block; top: 0; left: 0;" src="data:image/png;base64,{actual_b64}"/>
              <img style="position: absolute; opacity: 0; display: block; top: 0; left: 0; background-color: rgba(0, 0, 0, 0.8);" title="Actual" src="data:image/png;base64,{mask_b64}" onmousedown="this.style.opacity = '1';" onmouseup="this.style.opacity = '0';" onmouseover="this.parentElement.children[1].style.display = 'none';" onmouseout="this.parentElement.children[1].style.display = 'block';"/>
            </div>
            """
        )
    )
    extras.append(
        pytest_html.extras.html(
            f'<img title="Expected" src="data:image/png;base64,{expected_b64}">'
        )
    )

    if mismatch:
        pytest.fail(f"Screenshots don't match, max_difference={max_difference}")


# Flaky due to https://github.com/parcel-bundler/parcel/issues/9476
@pytest.mark.flaky(reruns=5)
@pytest.mark.timeout(timeout=60, func_only=True)
def test_dev_server(
    request,
    webdriver_generic,
    built_package,
    example_dir,
    installed_example_dir,
    extras,
):
    screenshot = capture_screenshot_from_dev_server(
        webdriver=webdriver_generic,
        example_dir=os.path.join(root_dir, example_dir),
        test_fragment=TEST_FRAGMENT,
    )

    compare_screenshot(
        screenshot, request.getfixturevalue("expected_screenshot"), extras
    )


# Flaky due to https://github.com/parcel-bundler/parcel/issues/9476
@pytest.mark.flaky(reruns=5)
@pytest.mark.timeout(timeout=60, func_only=True)
def test_build(
    request,
    webdriver_generic,
    built_package,
    example_dir,
    installed_example_dir,
    extras,
):
    screenshot = capture_screenshot_from_build(
        webdriver=webdriver_generic,
        example_dir=os.path.join(root_dir, example_dir),
        test_fragment=TEST_FRAGMENT,
    )

    compare_screenshot(
        screenshot, request.getfixturevalue("expected_screenshot"), extras
    )


@pytest.mark.timeout(timeout=60, func_only=True)
def test_root_build(
    request,
    webdriver_generic,
    extras,
):
    screenshot = capture_screenshot_from_build(
        webdriver=webdriver_generic,
        example_dir=root_dir,
        output_dir=os.path.join(root_dir, "dist", "client"),
        test_fragment=TEST_FRAGMENT,
        extra_args=["--no-typecheck", "--no-lint"],
    )

    compare_screenshot(
        screenshot, request.getfixturevalue("expected_screenshot"), extras
    )
