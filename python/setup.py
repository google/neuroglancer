#!/usr/bin/env python

from setuptools import setup, find_packages
from distutils.command.build import build
from subprocess import call
import os
import shutil

static_files = [ 'main.bundle.js', 'chunk_worker.bundle.js', 'styles.css', 'index.html' ]

class bundle_client(build):

    user_options = [

        ('client-bundle-type=', None, 'The nodejs bundle type. "min" (default) creates condensed static files for production, "dev" creates human-readable files.')
    ]

    def initialize_options(self):

        self.client_bundle_type = 'min'

    def finalize_options(self):

        if self.client_bundle_type not in  [ 'min', 'dev' ]:
            raise RuntimeError('client-bundle-type has to be one of "min" or "dev"')

    def run(self):

        this_dir = os.path.abspath(os.path.dirname(__file__))
        project_dir = os.path.join(this_dir, '..')

        build_dir = os.path.join(project_dir, 'dist/' + self.client_bundle_type)
        static_dir = os.path.join(this_dir, 'neuroglancer/static')

        print "Project dir " + project_dir
        print "Build dir " + build_dir
        print "Static dir " + static_dir

        prev_dir = os.path.abspath('.')
        os.chdir(project_dir)

        target = {
            "min" : "build-min",
            "dev" : "build"
        }

        try:
            call(['npm', 'i'])
            res = call(['npm', 'run', target[self.client_bundle_type]])
        except:
            raise RuntimeError('Could not run \'npm run build-%s\'. Make sure node.js >= v5.9.0 is installed and in your path.' % self.client_bundle_type)

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
    version = '0.0.6',
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
        "numpy>=1.11.0",
    ],
    use_2to3 = True,
    cmdclass = {'bundle_client' : bundle_client},
)
