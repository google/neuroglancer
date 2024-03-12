#!/usr/bin/env python


# Import setuptools before distutils because setuptools monkey patches
# distutils.
import atexit
import os
import pathlib
import platform
import shutil
import subprocess
import tempfile

import setuptools
import setuptools.command.build
import setuptools.command.build_ext
import setuptools.command.develop
import setuptools.command.install
import setuptools.command.sdist
import setuptools.command.test

package_name = "neuroglancer"
root_dir = os.path.dirname(__file__)
python_dir = os.path.join(root_dir, "python")
src_dir = os.path.join(python_dir, "ext", "src")
openmesh_dir = os.path.join(
    python_dir, "ext", "third_party", "openmesh", "OpenMesh", "src"
)


def _read_requirements(path: str) -> list[str]:
    return pathlib.Path(path).read_text(encoding="utf-8").splitlines()


_SETUP_REQUIRES = [
    "setuptools_scm>=4.1.2",
    "numpy>=1.11.0",
]


_PACKAGE_JSON_EXISTS = os.path.exists(os.path.join(root_dir, "package.json"))

if _PACKAGE_JSON_EXISTS:
    _SETUP_REQUIRES.extend(
        _read_requirements(os.path.join(python_dir, "requirements-nodejs.txt"))
    )


with open(os.path.join(python_dir, "README.md"), encoding="utf-8") as f:
    long_description = f.read()


def _maybe_bundle_client(cmd, inplace=False):
    """Build the client bundle if it does not already exist.

    If it has already been built but is stale, the user is responsible for
    rebuilding it.
    """

    bundle_client_cmd = cmd.distribution.get_command_obj("bundle_client")
    if inplace:
        bundle_client_cmd.build_bundle_inplace = True
    if bundle_client_cmd.skip_rebuild is None:
        bundle_client_cmd.skip_rebuild = True
    cmd.run_command("bundle_client")


def _setup_temp_egg_info(cmd):
    """Use a temporary directory for the `neuroglancer.egg-info` directory.

    When building an sdist (source distribution) or installing, locate the
    `neuroglancer.egg-info` directory inside a temporary directory so that it
    doesn't litter the source directory and doesn't pick up a stale SOURCES.txt
    from a previous build.
    """
    egg_info_cmd = cmd.distribution.get_command_obj("egg_info")
    if egg_info_cmd.egg_base is None:
        tempdir = tempfile.TemporaryDirectory(dir=os.curdir)
        egg_info_cmd.egg_base = tempdir.name
        atexit.register(tempdir.cleanup)


class SdistCommand(setuptools.command.sdist.sdist):
    def run(self):
        # Build the client bundle if it does not already exist.  If it has
        # already been built but is stale, the user is responsible for
        # rebuilding it.
        _maybe_bundle_client(self, inplace=True)
        _setup_temp_egg_info(self)
        super().run()

    def make_release_tree(self, base_dir, files):
        # Exclude .egg-info from source distribution.  These aren't actually
        # needed, and due to the use of the temporary directory in `run`, the
        # path isn't correct if it gets included.
        files = [x for x in files if ".egg-info" not in x]
        super().make_release_tree(base_dir, files)


setuptools.command.build.build.sub_commands.append(("bundle_client", None))


class BuildExtCommand(setuptools.command.build_ext.build_ext):
    def finalize_options(self):
        super().finalize_options()
        # Prevent numpy from thinking it is still in its setup process
        if isinstance(__builtins__, dict):
            __builtins__["__NUMPY_SETUP__"] = False
        else:
            setattr(__builtins__, "__NUMPY_SETUP__", False)
        import numpy

        self.include_dirs.append(numpy.get_include())


class InstallCommand(setuptools.command.install.install):
    def run(self):
        _setup_temp_egg_info(self)
        super().run()


class DevelopCommand(setuptools.command.develop.develop):
    def run(self):
        _maybe_bundle_client(self)
        super().run()


class BundleClientCommand(
    setuptools.command.build.build, setuptools.command.build.SubCommand
):
    editable_mode: bool = False

    user_options = [
        (
            "client-bundle-type=",
            None,
            'The nodejs bundle type. "min" (default) creates condensed static files for production, "dev" creates human-readable files.',
        ),
        ("build-bundle-inplace", None, "Build the client bundle inplace."),
        (
            "skip-npm-reinstall",
            None,
            "Skip running `npm install` if the `node_modules` directory already exists.",
        ),
        (
            "skip-rebuild",
            None,
            "Skip rebuilding if the `python/neuroglancer/static/client/index.html` file already exists.",
        ),
    ]

    def initialize_options(self):
        self.build_lib = None
        self.client_bundle_type = "min"
        self.skip_npm_reinstall = None
        self.skip_rebuild = None
        self.build_bundle_inplace = None

    def finalize_options(self):
        self.set_undefined_options("build_py", ("build_lib", "build_lib"))

        if self.client_bundle_type not in ["min", "dev"]:
            raise RuntimeError('client-bundle-type has to be one of "min" or "dev"')

        if self.skip_npm_reinstall is None:
            self.skip_npm_reinstall = False

        if self.build_bundle_inplace is None:
            self.build_bundle_inplace = (
                os.getenv("NEUROGLANCER_BUILD_BUNDLE_INPLACE") == "1"
            )

        if self.skip_rebuild is None:
            self.skip_rebuild = self.build_bundle_inplace

    def _get_inplace_client_dir(self):
        return os.path.join(python_dir, "neuroglancer", "static", "client")

    def _get_client_output_dir(self):
        if self.build_bundle_inplace:
            output_base_dir = python_dir
        else:
            output_base_dir = self.build_lib

        return os.path.join(output_base_dir, "neuroglancer", "static", "client")

    def get_outputs(self):
        return [str(p) for p in pathlib.Path(self._get_client_output_dir()).rglob("*")]

    def get_source_files(self):
        if not self.build_bundle_inplace:
            return []
        source_files = [
            str(p.relative_to(root_dir))
            for p in pathlib.Path(self._get_inplace_client_dir()).rglob("*")
        ]
        return source_files

    def get_output_mapping(self):
        return {}

    def run(self):
        inplace = self.editable_mode or self.build_bundle_inplace
        print(
            f"Building client bundle: inplace={inplace}, skip_rebuild={self.skip_rebuild}"
        )

        # If building from an sdist, `package.json` won't be present but the
        # bundled files will.
        if not _PACKAGE_JSON_EXISTS:
            print("Skipping build of client bundle because package.json does not exist")
            if not self.build_bundle_inplace:
                shutil.copytree(
                    self._get_inplace_client_dir(), self._get_client_output_dir()
                )
            return

        output_dir = self._get_client_output_dir()

        if self.skip_rebuild and inplace:
            html_path = os.path.join(output_dir, "index.html")
            if os.path.exists(html_path):
                print(
                    "Skipping rebuild of client bundle since {} already exists".format(
                        html_path
                    )
                )
                return

        target = {"min": "build-python-min", "dev": "build-python-dev"}

        t = target[self.client_bundle_type]
        node_modules_path = os.path.join(root_dir, "node_modules")
        if self.skip_npm_reinstall and os.path.exists(node_modules_path):
            print(f"Skipping `npm install` since {node_modules_path} already exists")
        else:
            subprocess.run(["npm", "install"], cwd=root_dir, check=True)
        subprocess.run(
            [
                "npm",
                "run",
                t,
                "--",
                "--no-typecheck",
                "--no-lint",
                f"--output={output_dir}",
            ],
            cwd=root_dir,
            check=True,
        )


local_sources = [
    "_neuroglancer.cc",
    "openmesh_dependencies.cc",
    "on_demand_object_mesh_generator.cc",
    "voxel_mesh_generator.cc",
    "mesh_objects.cc",
]

USE_OMP = False
if USE_OMP:
    openmp_flags = ["-fopenmp"]
else:
    openmp_flags = []

extra_compile_args = ["-std=c++11", "-fvisibility=hidden", "-O3"] + openmp_flags
if platform.system() == "Darwin":
    extra_compile_args.insert(0, "-stdlib=libc++")

# Disable newer exception handling from Visual Studio 2019, since it requires a
# newer C++ runtime than shipped with Python.  The C++ extension doesn't use
# exceptions anyway.
#
# https://cibuildwheel.readthedocs.io/en/stable/faq/#importerror-dll-load-failed-the-specific-module-could-not-be-found-error-on-windows
if platform.system() == "Windows":
    extra_compile_args.append("/d2FH4-")


# Copied from setuptools_scm, can be removed once a released version of
# setuptools_scm supports `version_scheme=no-guess-dev`.
#
# Note: It would be nice to include the commit hash in the version, but that
# can't be done in a PEP 440-compatible way.
def _no_guess_dev_version(version):
    if version.exact:
        return version.format_with("{tag}")
    else:
        return version.format_with("{tag}.post1.dev{distance}")


setuptools.setup(
    name=package_name,
    # Use setuptools_scm to determine version from git tags
    use_scm_version={
        "relative_to": __file__,
        "version_scheme": _no_guess_dev_version,
        "local_scheme": "no-local-version",
        "parentdir_prefix_version": package_name + "-",
    },
    description="Python data backend for neuroglancer, a WebGL-based viewer for volumetric data",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="Jeremy Maitin-Shepard",
    author_email="jbms@google.com",
    url="https://github.com/google/neuroglancer",
    license="Apache License 2.0",
    python_requires=">=3.9",
    packages=setuptools.find_packages("python"),
    package_dir={
        "": "python",
    },
    setup_requires=_SETUP_REQUIRES,
    install_requires=_read_requirements(os.path.join(python_dir, "requirements.txt")),
    extras_require={
        "webdriver": _read_requirements(
            os.path.join(python_dir, "requirements-webdriver.txt")
        ),
    },
    ext_modules=[
        setuptools.Extension(
            "neuroglancer._neuroglancer",
            sources=[os.path.join(src_dir, name) for name in local_sources],
            language="c++",
            include_dirs=[openmesh_dir],
            define_macros=[
                ("_USE_MATH_DEFINES", None),  # Needed by OpenMesh when used with MSVC
                ("Py_LIMITED_API", "0x03090000"),
                ("NPY_NO_DEPRECATED_API", "NPY_1_7_API_VERSION"),
            ],
            extra_compile_args=extra_compile_args,
            extra_link_args=openmp_flags,
            py_limited_api=True,
        ),
    ],
    cmdclass={
        "sdist": SdistCommand,
        "bundle_client": BundleClientCommand,
        "build_ext": BuildExtCommand,
        "install": InstallCommand,
        "develop": DevelopCommand,
    },
    options={"bdist_wheel": {"py_limited_api": "cp39"}},
)
