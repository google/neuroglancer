# Copyright 2026 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Start a disposable, real CATMAID API and bootstrap test credentials."""

import json
import os
from pathlib import Path
import site
import subprocess
import sys


django_dir = Path('/home/django')
project_dir = django_dir / 'projects'
writable_dir = Path('/tmp/catmaid-output')
writable_dir.mkdir(exist_ok=True)
configuration = {
    'abs_catmaid_path': '/home',
    'abs_virtualenv_python_library_path': site.getsitepackages()[0],
    'catmaid_database_name': 'catmaid',
    'catmaid_database_username': 'catmaid',
    'catmaid_database_password': 'disposable-test-password',
    'catmaid_database_host': 'db',
    'catmaid_database_port': '5432',
    'catmaid_writable_path': str(writable_dir),
    'catmaid_timezone': 'UTC',
    'catmaid_servername': '*',
    'catmaid_subdirectory': '',
    'catmaid_default_enabled_tools': ['tracing'],
}
(django_dir / 'configuration.py').write_text(''.join(
    f'{key} = {value!r}\n' for key, value in configuration.items()
))
subprocess.run([sys.executable, 'create_configuration.py'], cwd=django_dir, check=True)
with (project_dir / 'mysite/settings.py').open('a') as settings:
    settings.write('\nALLOWED_HOSTS = ["*"]\nDEBUG = False\n')
subprocess.run(
    [sys.executable, 'manage.py', 'migrate', '--noinput'],
    cwd=project_dir,
    check=True,
)
sys.path[:0] = [str(project_dir), str(django_dir / 'applications')]
os.environ['DJANGO_SETTINGS_MODULE'] = 'mysite.settings'
import django

django.setup()
from django.contrib.auth import get_user_model
from rest_framework.authtoken.models import Token
from catmaid.models import Project

user = get_user_model().objects.create_superuser(
    username='neuroglancer-test', email='', password=None
)
token, _ = Token.objects.get_or_create(user=user)
Project.objects.create(title='Ontology')
Path('/tmp/neuroglancer-fixture.json').write_text(json.dumps({'apiToken': token.key}))
os.chdir(project_dir)
os.execv(sys.executable, [
    sys.executable, 'manage.py', 'runserver', '--noreload', '0.0.0.0:8000'
])
