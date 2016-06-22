#!/usr/bin/env python

from setuptools import setup, find_packages
from distutils.command.build import build
from subprocess import call
import os
import shutil

static_files = [ 'main.bundle.js', 'chunk_worker.bundle.js', 'styles.css', 'index.html' ]

class bundle_nodejs(build):

    def run(self):

        this_dir = os.path.abspath(os.path.dirname(__file__))
        project_dir = os.path.join(this_dir, '..')

        build_dir = os.path.join(project_dir, 'dist/min')
        static_dir = os.path.join(this_dir, 'neuroglancer/static')

        print "Project dir " + project_dir
        print "Build dir " + build_dir
        print "Static dir " + static_dir

        prev_dir = os.path.abspath('.')
        os.chdir(project_dir)

        try:
            call(['npm', 'i'])
            res = call(['npm', 'run', 'build-min'])
        except:
            raise RuntimeError('Could not run \'npm run build-min\'. Make sure node.js >= v5.9.0 is installed and in your path.')

        if res != 0:
            raise RuntimeError('failed to bundle neuroglancer node.js project')

        try:
            os.mkdir(static_dir)
        except OSError:
            pass

        for f in static_files:
            shutil.copy(
                os.path.join(build_dir, f),
                os.path.join(static_dir, f)
            )

        os.chdir(prev_dir)

setup(
    name = 'neuroglancer',
    version = '0.0.5',
    description = 'Python data backend for neuroglancer, a WebGL-based viewer for volumetric data',
    author = 'Jeremy Maitin-Shepard, Jan Funke',
    author_email = 'jbms@google.com, jfunke@iri.upc.edu',
    url = 'https://github.com/google/neuroglancer',
    license = 'Apache License 2.0',
    packages = find_packages(),
    package_data = {
        'neuroglancer.static': static_files,
    },
    install_requires = [
        "Pillow>=3.2.0",
    ],
    use_2to3 = True,
    cmdclass = {'bundle_nodejs' : bundle_nodejs},
)
