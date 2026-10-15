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

"""Create/delete test-owned CATMAID projects inside the disposable container."""
import json
import os
import sys

sys.path[:0] = ['/home/django/projects', '/home/django/applications']
os.environ['DJANGO_SETTINGS_MODULE'] = 'mysite.settings'
import django
django.setup()
from django.contrib.auth import get_user_model
from django.db import transaction
from guardian.shortcuts import assign_perm
from catmaid.models import Project, ProjectStack, Stack
from catmaid.control.tracing import setup_tracing

PREFIX = 'Neuroglancer E2E '
with transaction.atomic():
    if sys.argv[1] == 'create':
        user = get_user_model().objects.get(username='neuroglancer-test')
        project = Project.objects.create(title=PREFIX + sys.argv[2])
        assign_perm('can_annotate_with_token', user, project)
        assign_perm('can_import', user, project)
        setup_tracing(project.id, user)
        stack = Stack.objects.create(
            title='Skeleton coordinates', dimension=(10000, 10000, 10000),
            resolution=(1, 1, 1), downsample_factors=None,
            metadata={'read_only': False, 'spatial': [
                {'chunk_size': [10000, 10000, 10000], 'limit': 0}
            ]},
        )
        ProjectStack.objects.create(project=project, stack=stack)
        print(json.dumps({'projectId': project.id}))
    elif sys.argv[1] == 'delete':
        project = Project.objects.get(pk=int(sys.argv[2]))
        if not project.title.startswith(PREFIX):
            raise ValueError('Refusing to delete a project not owned by the test run')
        stack_ids = list(project.stacks.values_list('id', flat=True))
        project.delete()
        Stack.objects.filter(id__in=stack_ids).delete()
        print(json.dumps({'removed': True}))
    elif sys.argv[1] == 'list':
        print(json.dumps(list(Project.objects.filter(
            title__startswith=PREFIX).values_list('id', flat=True))))
    else:
        raise ValueError('Unknown project command')
