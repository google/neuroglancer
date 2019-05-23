#!/usr/bin/env python
from __future__ import print_function

import os
import shutil
import subprocess
import platform
from distutils.command.build import build
from setuptools.command.build_ext import build_ext

from setuptools import Extension, find_packages, setup

class build_ext_subclass(build_ext):
    def finalize_options(self):
        build_ext.finalize_options(self)
        # Prevent numpy from thinking it is still in its setup process:
        __builtins__.__NUMPY_SETUP__ = False
        import numpy
        self.include_dirs.append(numpy.get_include())


static_files = [
    'main.bundle.js',
    'chunk_worker.bundle.js',
    'tfjs-library.bundle.js',
    'draco.bundle.js',
    'index.html',
]


class bundle_client(build):

    user_options = [
        ('client-bundle-type=', None,
         'The nodejs bundle type. "min" (default) creates condensed static files for production, "dev" creates human-readable files.'
         )
    ]

    def initialize_options(self):

        self.client_bundle_type = 'min'

    def finalize_options(self):

        if self.client_bundle_type not in ['min', 'dev']:
            raise RuntimeError('client-bundle-type has to be one of "min" or "dev"')

    def run(self):

        this_dir = os.path.abspath(os.path.dirname(__file__))
        project_dir = os.path.join(this_dir, '..')

        build_dir = os.path.join(project_dir, 'dist/python-' + self.client_bundle_type)
        static_dir = os.path.join(this_dir, 'neuroglancer/static')

        print("Project dir " + project_dir)
        print("Build dir " + build_dir)
        print("Static dir " + static_dir)

        prev_dir = os.path.abspath('.')
        os.chdir(project_dir)

        target = {"min": "build-python-min", "dev": "build-python"}

        try:
            t = target[self.client_bundle_type]
            subprocess.call(['npm', 'i'])
            res = subprocess.call(['npm', 'run', t])
        except:
            raise RuntimeError(
                'Could not run \'npm run %s\'. Make sure node.js >= v5.9.0 is installed and in your path.'
                % t)

        if res != 0:
            raise RuntimeError('failed to bundle neuroglancer node.js project')

        try:
            os.mkdir(static_dir)
        except OSError:
            pass

        for f in static_files:
            shutil.copy(os.path.join(build_dir, f), os.path.join(static_dir, f))

        os.chdir(prev_dir)

setup_dir = os.path.dirname(__file__)
src_dir = os.path.join(setup_dir, 'ext/src')
openmesh_dir = os.path.join(setup_dir, 'ext/third_party/openmesh/OpenMesh/src')
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

setup(
    name='neuroglancer',
    version='1.1.0',
    description='Python data backend for neuroglancer, a WebGL-based viewer for volumetric data',
    author='Jeremy Maitin-Shepard, Jan Funke',
    author_email='jbms@google.com, jfunke@iri.upc.edu',
    url='https://github.com/google/neuroglancer',
    license='Apache License 2.0',
    packages=find_packages(),
    package_data={
        'neuroglancer.static': static_files,
    },
    setup_requires=[
        "numpy>=1.11.0",
    ],
    install_requires=[
        "Pillow>=3.2.0",
        "numpy>=1.11.0",
        'requests',
        'tornado<6',
        'sockjs-tornado',
        'six',
        'google-apitools',
    ],
    test_requires=[
        'pytest',
    ],
    extras_require={
        ":python_version<'3.2'": ['futures'],
    },
    ext_modules=[
        Extension(
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
        'bundle_client': bundle_client,
        'build_ext': build_ext_subclass,
    },
)
