import os

import pytest

from neuroglancer.pipeline.tasks import RegisteredTask
from neuroglancer.pipeline import TaskQueue
from neuroglancer.pipeline.secrets import PROJECT_NAME

import time

PIPELINE_USER_QUEUE = None if 'PIPELINE_USER_QUEUE' not in os.environ else os.environ['PIPELINE_USER_QUEUE']
TRAVIS_BRANCH = None if 'TRAVIS_BRANCH' not in os.environ else os.environ['TRAVIS_BRANCH']

if PIPELINE_USER_QUEUE is not None:
  QUEUE_NAME = PIPELINE_USER_QUEUE
elif TRAVIS_BRANCH is None:
  QUEUE_NAME = 'test-pull-queue'
elif TRAVIS_BRANCH == 'master':
  QUEUE_NAME = 'travis-pull-queue-1'
else:
  QUEUE_NAME = 'travis-pull-queue-2'

class MockTask(RegisteredTask):
  def __init__(self):
    super(MockTask, self).__init__()

def test_get():
  global QUEUE_NAME
  tq = TaskQueue(n_threads=0, queue_name=QUEUE_NAME)

  n_inserts = 5
  tq.purge()

  try:
    for _ in xrange(n_inserts):
      task = MockTask()
      tq.insert(task)
    tq.wait()

    tqinfo = tq.get()
    assert tqinfo['id'] == 'projects/s~{}/taskqueues/{}'.format(PROJECT_NAME, QUEUE_NAME)
    assert tqinfo['stats']['totalTasks'] == n_inserts
    assert tq.enqueued == n_inserts
  finally:
    tq.purge()

  time.sleep(5)
  assert tq.enqueued == 0

def test_single_threaded_insertion():
  global QUEUE_NAME
  tq = TaskQueue(n_threads=0, queue_name=QUEUE_NAME).purge()
  
  n_inserts = 5

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

  lst = tq.list()
  assert not lst.has_key('items')

def test_multi_threaded_insertion():
  global QUEUE_NAME
  tq = TaskQueue(n_threads=40, queue_name=QUEUE_NAME)

  n_inserts = 1000

  tq.purge()

  time.sleep(1)
  assert tq.enqueued == 0

  try:
    for _ in xrange(n_inserts):
      task = MockTask()
      tq.insert(task)

    tq.wait()

    lst = tq.list()

    assert lst.has_key('items')

    items = lst['items']

    assert len(items) == 100 # task list api only lists 100 items at a time
    # time.sleep(5)
    # assert tq.enqueued == n_inserts # Google is returning impossible values like 1005

    tags = map(lambda x: x['tag'], items)

    assert all(map(lambda x: x == MockTask.__name__, tags))
  finally:
    tq.purge()

  time.sleep(5)
  assert tq.enqueued == 0
  

def test_400_errors():
  global QUEUE_NAME
  with TaskQueue(n_threads=1, queue_name=QUEUE_NAME) as tq:
    tq.delete('nonexistent')




