#!/usr/bin/env python
import sys
if sys.version_info < (3, 5):
    print('Python >= 3.5 is required to build')
    sys.exit(1)

# Import setuptools before distutils because setuptools monkey patches
# distutils.
import setuptools

import atexit
import distutils.command.build
import os
import platform
import shutil
import subprocess
import tempfile
import time
import setuptools.command.build
import setuptools.command.build_ext
import setuptools.command.develop
import setuptools.command.install
import setuptools.command.sdist
import setuptools.command.test

package_name = 'neuroglancer'
root_dir = os.path.dirname(__file__)
python_dir = os.path.join(root_dir, 'python')
src_dir = os.path.join(python_dir, 'ext', 'src')
openmesh_dir = os.path.join(python_dir, 'ext', 'third_party', 'openmesh', 'OpenMesh', 'src')

CLIENT_FILES = [
    "index.html",
    "main.bundle.js",
    "main.bundle.css",
    "main.bundle.js.map",
    "main.bundle.css.map",
    "chunk_worker.bundle.js",
    "chunk_worker.bundle.js.map",
    "async_computation.bundle.js",
    "async_computation.bundle.js.map",
]

with open(os.path.join(python_dir, 'README.md'), mode='r', encoding='utf-8') as f:
    long_description = f.read()


def _maybe_bundle_client(cmd, inplace=False):
    """Build the client bundle if it does not already exist.

    If it has already been built but is stale, the user is responsible for
    rebuilding it.
    """

    bundle_client_cmd = cmd.distribution.get_command_obj('bundle_client')
    if inplace:
        bundle_client_cmd.build_bundle_inplace = True
    if bundle_client_cmd.skip_rebuild is None:
        bundle_client_cmd.skip_rebuild = True
    cmd.run_command('bundle_client')


def _setup_temp_egg_info(cmd):
    """Use a temporary directory for the `neuroglancer.egg-info` directory.

    When building an sdist (source distribution) or installing, locate the
    `neuroglancer.egg-info` directory inside a temporary directory so that it
    doesn't litter the source directory and doesn't pick up a stale SOURCES.txt
    from a previous build.
    """
    egg_info_cmd = cmd.distribution.get_command_obj('egg_info')
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
        files = [x for x in files if '.egg-info' not in x]
        super().make_release_tree(base_dir, files)


setuptools.command.build.build.sub_commands.append(('bundle_client', None))


class BuildExtCommand(setuptools.command.build_ext.build_ext):

    def finalize_options(self):
        super().finalize_options()
        # Prevent numpy from thinking it is still in its setup process
        if isinstance(__builtins__, dict):
            __builtins__['__NUMPY_SETUP__'] = False
        else:
            setattr(__builtins__, '__NUMPY_SETUP__', False)
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


class BundleClientCommand(setuptools.command.build.build, setuptools.command.build.SubCommand):

    editable_mode: bool = False

    user_options = [
        ('client-bundle-type=', None,
         'The nodejs bundle type. "min" (default) creates condensed static files for production, "dev" creates human-readable files.'
         ),
        ('build-bundle-inplace', None, 'Build the client bundle inplace.'),
        ('skip-npm-reinstall', None,
         'Skip running `npm install` if the `node_modules` directory already exists.'),
        ('skip-rebuild', None,
         'Skip rebuilding if the `python/neuroglancer/static/index.html` file already exists.'),
    ]

    def initialize_options(self):

        self.build_lib = None
        self.client_bundle_type = 'min'
        self.skip_npm_reinstall = None
        self.skip_rebuild = None
        self.build_bundle_inplace = None

    def finalize_options(self):
        self.set_undefined_options("build_py", ("build_lib", "build_lib"))

        if self.client_bundle_type not in ['min', 'dev']:
            raise RuntimeError('client-bundle-type has to be one of "min" or "dev"')

        if self.skip_npm_reinstall is None:
            self.skip_npm_reinstall = False

        if self.build_bundle_inplace is None:
            self.build_bundle_inplace = (os.getenv('NEUROGLANCER_BUILD_BUNDLE_INPLACE') == '1')

        if self.skip_rebuild is None:
            self.skip_rebuild = self.build_bundle_inplace

    def get_outputs(self):
        if self.editable_mode or self.build_bundle_inplace:
            return []
        build_lib = self.build_lib
        return [f"{build_lib}/{f}" for f in self._get_bundle_files()]

    def _get_bundle_files(self):
        return [f"neuroglancer/static/{f}" for f in CLIENT_FILES]

    def get_source_files(self):
        return []

    def get_output_mapping(self):
        return {}

    def run(self):
        inplace = self.editable_mode or self.build_bundle_inplace
        print(f'Building client bundle: inplace={inplace}, skip_rebuild={self.skip_rebuild}')

        # If building from an sdist, `package.json` won't be present but the
        # bundled files will.
        if not os.path.exists(os.path.join(root_dir, 'package.json')):
            print('Skipping build of client bundle because package.json does not exist')
            for dest, source in self.get_output_mapping().items():
                if dest != source:
                    shutil.copyfile(source, dest)
            return

        if inplace:
            output_base_dir = python_dir
        else:
            output_base_dir = self.build_lib

        output_dir = os.path.join(output_base_dir, 'neuroglancer', 'static')

        if self.skip_rebuild and inplace:
            html_path = os.path.join(output_dir, 'index.html')
            if os.path.exists(html_path):
                print('Skipping rebuild of client bundle since %s already exists' % (html_path, ))
                return

        target = {"min": "build-python-min", "dev": "build-python-dev"}

        try:
            t = target[self.client_bundle_type]
            node_modules_path = os.path.join(root_dir, 'node_modules')
            if (self.skip_npm_reinstall and os.path.exists(node_modules_path)):
                print('Skipping `npm install` since %s already exists' % (node_modules_path, ))
            else:
                subprocess.call('npm i', shell=True, cwd=root_dir)
            res = subprocess.call(f'npm run {t} -- --output={output_dir}', shell=True, cwd=root_dir)
        except:
            raise RuntimeError(
                'Could not run \'npm run %s\'. Make sure node.js >= v12 is installed and in your path.'
                % t)

        if res != 0:
            raise RuntimeError('failed to bundle neuroglancer node.js project')


local_sources = [
    '_neuroglancer.cc',
    'openmesh_dependencies.cc',
    'on_demand_object_mesh_generator.cc',
    'voxel_mesh_generator.cc',
    'mesh_objects.cc',
]

USE_OMP = False
if USE_OMP:
    openmp_flags = ['-fopenmp']
else:
    openmp_flags = []

extra_compile_args = ['-std=c++11', '-fvisibility=hidden', '-O3'] + openmp_flags
if platform.system() == 'Darwin':
    extra_compile_args.insert(0, '-stdlib=libc++')

# Disable newer exception handling from Visual Studio 2019, since it requires a
# newer C++ runtime than shipped with Python.  The C++ extension doesn't use
# exceptions anyway.
#
# https://cibuildwheel.readthedocs.io/en/stable/faq/#importerror-dll-load-failed-the-specific-module-could-not-be-found-error-on-windows
if platform.system() == 'Windows':
    extra_compile_args.append('/d2FH4-')


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
    description='Python data backend for neuroglancer, a WebGL-based viewer for volumetric data',
    long_description=long_description,
    long_description_content_type='text/markdown',
    author='Jeremy Maitin-Shepard',
    author_email='jbms@google.com',
    url='https://github.com/google/neuroglancer',
    license='Apache License 2.0',
    packages=setuptools.find_packages('python'),
    package_dir={
        '': 'python',
    },
    package_data={
        'neuroglancer.static': ['*.html', '*.css', '*.js', '*.js.map'],
    },
    setup_requires=[
        "setuptools_scm>=4.1.2",
        "numpy>=1.11.0",
    ],
    install_requires=[
        "Pillow>=3.2.0",
        "numpy>=1.11.0",
        'requests',
        'tornado',
        'six',
        'google-apitools',
        'google-auth',
        'atomicwrites',
        'typing_extensions',
    ],
    extras_require={
        'test': [
            'pytest>=6.1.2',
            'pytest-rerunfailures>=9.1.1',
            'pytest-timeout>=1.4.2',
        ],
        'test-browser': [
            'selenium>=3.141.0',
            'webdriver-manager>=3.5.0',
        ],
    },
    ext_modules=[
        setuptools.Extension(
            'neuroglancer._neuroglancer',
            sources=[os.path.join(src_dir, name) for name in local_sources],
            language='c++',
            include_dirs=[openmesh_dir],
            define_macros=[
                ('_USE_MATH_DEFINES', None),  # Needed by OpenMesh when used with MSVC
            ],
            extra_compile_args=extra_compile_args,
            extra_link_args=openmp_flags),
    ],
    cmdclass={
        'sdist': SdistCommand,
        'bundle_client': BundleClientCommand,
        'build_ext': BuildExtCommand,
        'install': InstallCommand,
        'develop': DevelopCommand,
    },
)
