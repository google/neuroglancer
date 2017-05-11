from neuroglancer.pipeline.threaded_queue import ThreadedQueue
from functools import partial

def test_threading():
  execution_count = 1000
  executions = []


  def reset_executions():
    return [ False for _ in xrange(execution_count) ]

  def addone(idnum, should_be_none):
    executions[idnum] = True    
    assert should_be_none is None

  executions = reset_executions()

  with ThreadedQueue(n_threads=1) as tq:
    for idnum in xrange(execution_count):
      fn = partial(addone, idnum)
      tq._queue.put(fn)
  assert all(executions)

  executions = reset_executions()
  tq = ThreadedQueue(n_threads=40)
  for idnum in xrange(execution_count):
    fn = partial(addone, idnum)
    tq._queue.put(fn)
  tq.wait().kill_threads()
  assert tq.processed == execution_count
  assert all(executions)

  # Base class with 0 threads on with statement will never terminate
  try:
    with ThreadedQueue(n_threads=0) as tq:
      assert False
  except ValueError:
    assert True
  except Exception:
    assert False

def test_derived_class():
  
  def what_fun(should_be_fun):
    assert should_be_fun == 'fun'

  class DerivedThreadedQueue(ThreadedQueue):
    def _initialize_interface(self):
      return 'fun'

  with DerivedThreadedQueue(n_threads=1) as tq:
    for _ in xrange(1000):
      tq._queue.put(what_fun)

    tq.wait()
    assert tq.processed == 1000

  # shouldn't crash w/ 0 threads because it's a derived class
  with DerivedThreadedQueue(n_threads=0) as tq:
    pass

def test_threads_die():
  tq = ThreadedQueue(n_threads=40)
  assert tq.are_threads_alive()
  tq.kill_threads()
  assert not tq.are_threads_alive()

  tq = ThreadedQueue(n_threads=0)
  assert not tq.are_threads_alive()

  with ThreadedQueue(n_threads=40) as tq:
    threads = tq._threads
  
  assert not any(map(lambda t: t.isAlive(), threads))

def test_thread_exceptions():

  def diediedie(interface):  
    raise NotImplementedError("Not implemented at all.")

  tq = ThreadedQueue(n_threads=40)
  for _ in xrange(1000):
    tq.put(diediedie)

  try:
    tq.wait()
  except NotImplementedError:
    pass



