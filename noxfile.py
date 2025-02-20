import os

import nox

nox.options.default_venv_backend = "uv"
nox.options.reuse_existing_virtualenvs = True
nox.options.error_on_external_run = True


@nox.session
def lint(session):
    session.run_install(
        "uv",
        "sync",
        "--only-group",
        "ruff",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.run("ruff", "check", ".", *session.posargs)


@nox.session
def format(session):
    session.run_install(
        "uv",
        "sync",
        "--only-group",
        "ruff",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.run("ruff", "format", ".", *session.posargs)


@nox.session
def mypy(session):
    session.run_install(
        "uv",
        "sync",
        "--no-install-workspace",
        "--no-default-groups",
        "--group",
        "mypy",
        "--extra",
        "webdriver",
        "--group",
        "test",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.run("mypy", ".", *session.posargs)


@nox.session
def docs(session: nox.Session):
    session.run_install(
        "uv",
        "sync",
        "--no-default-groups",
        "--group",
        "docs",
        "--no-install-workspace",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.run(
        "sphinx-build",
        "docs",
        "dist/docs",
        "-E",
        "-j",
        "auto",
        "-T",
        "-W",
        "--keep-going",
        *session.posargs,
        env={
            "PYTHONPATH": os.path.join(os.path.dirname(__file__), "python"),
        },
    )


@nox.session
def test(session: nox.Session):
    session.run_install(
        "uv",
        "sync",
        "--no-default-groups",
        "--group",
        "test",
        "--extra",
        "webdriver",
        "--no-editable",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.chdir("python/tests")
    session.run("pytest", "-vv", "-s", *session.posargs)


@nox.session
def test_xvfb(session: nox.Session):
    session.run_install(
        "uv",
        "sync",
        "--no-default-groups",
        "--group",
        "test",
        "--extra",
        "webdriver",
        "--no-editable",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.chdir("python/tests")
    session.run(
        "xvfb-run",
        "-e",
        "/dev/stderr",
        "--auto-servernum",
        "--server-args",
        "-screen 0 1024x768x24",
        "pytest",
        "-vv",
        "-s",
        *session.posargs,
        external=True,
        env={"PATH": os.environ["PATH"]},
        include_outer_env=False,
    )


@nox.session
def test_editable(session: nox.Session):
    session.run_install(
        "uv",
        "sync",
        "--no-default-groups",
        "--group",
        "test",
        "--extra",
        "webdriver",
        env={"UV_PROJECT_ENVIRONMENT": session.virtualenv.location},
    )
    session.chdir("python/tests")
    session.run("pytest", "-vv", "-s", "--skip-browser-tests", *session.posargs)


@nox.session(python=False)
def cibuildwheel(session: nox.Session):
    session.run(
        "uv",
        "run",
        "--only-group",
        "cibuildwheel",
        "cibuildwheel",
        "--output-dir",
        "dist",
        *session.posargs,
        env={
            "CIBW_BUILD_FRONTEND": "build[uv]",
            "CIBW_ARCHS_MACOS": "x86_64 arm64",
            "CIBW_SKIP": "pp* *_i686 *-win32 *-musllinux*",
            "CIBW_TEST_GROUPS": "test",
            "CIBW_TEST_COMMAND": "python -m pytest {project}/python/tests -vv -s --skip-browser-tests",
            "CIBW_MANYLINUX_X86_64_IMAGE": "manylinux2014",
            # Assume the client bundle was already built. The github actions workflow builds
            # the client with specific defines to include the build stamp, and that would be
            # lost if setup.py rebuilds the client.
            "CIBW_ENVIRONMENT": "NEUROGLANCER_PREBUILT_CLIENT=1",
        },
    )
