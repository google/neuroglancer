import os

import pytest

from neuroglancer.pipeline.tasks import RegisteredTask
from neuroglancer.pipeline import TaskQueue

TRAVIS_BRANCH = None if 'TRAVIS_BRANCH' not in os.environ else os.environ['TRAVIS_BRANCH']

if TRAVIS_BRANCH is None:
  QUEUE_NAME = 'test-pull-queue'
elif TRAVIS_BRANCH == 'master':
  QUEUE_NAME = 'travis-pull-queue-1'
else:
  QUEUE_NAME = 'travis-pull-queue-2'

class MockTask(RegisteredTask):
  def __init__(self):
    super(MockTask, self).__init__()

def test_single_threaded_insertion():
  global QUEUE_NAME
  tq = TaskQueue(n_threads=0, queue_name=QUEUE_NAME)

  n_inserts = 5

  tq.purge()

  try:
    for _ in xrange(n_inserts):
      task = MockTask()
      tq.insert(task)

    lst = tq.list()

    assert lst.has_key('items')

    items = lst['items']

    assert len(items) == n_inserts

    tags = map(lambda x: x['tag'], items)

    assert all(map(lambda x: x == MockTask.__name__, tags))
  finally:
    tq.purge()


def test_multi_threaded_insertion():
  global QUEUE_NAME
  tq = TaskQueue(n_threads=40, queue_name=QUEUE_NAME)

  n_inserts = 100

  tq.purge()

  try:
    for _ in xrange(n_inserts):
      task = MockTask()
      tq.insert(task)

    tq.wait_until_queue_empty()

    lst = tq.list()

    assert lst.has_key('items')

    items = lst['items']

    assert len(items) == n_inserts

    tags = map(lambda x: x['tag'], items)

    assert all(map(lambda x: x == MockTask.__name__, tags))
  finally:
    tq.purge()
  


