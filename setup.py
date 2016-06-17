#!/usr/bin/env python

from distutils.command.build import build
from distutils.core import setup
from subprocess import call
import os
import shutil

static_files = [ 'main.bundle.js', 'chunk_worker.bundle.js', 'styles.css' ]

class build_nodejs(build):

    def run(self):

        if not self.dry_run:

            this_dir = os.path.abspath(os.path.dirname(__file__))

            project_dir = this_dir
            build_dir = os.path.join(this_dir, 'dist/min')
            static_dir = os.path.join(this_dir, 'python/neuroglancer/static')

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

        build.run(self)

setup(
    name = 'neuroglancer',
    version = '0.1',
    description = 'Python data backend for neuroglancer, a WebGL-based viewer for volumetric data',
    author = 'Jeremy Maitin-Shepard, Jan Funke',
    author_email = 'jbms@google.com, jfunke@iri.upc.edu',
    packages = ['neuroglancer', 'neuroglancer.static'],
    package_dir = {
        '': 'python',
    },
    include_package_data = True,
    package_data = {
        'neuroglancer.static': static_files,
    },
    cmdclass = {'build' : build_nodejs},
)
