from __future__ import print_function

import Queue
from functools import partial
import threading
import time

class ThreadedQueue(object):
  """Grant threaded task processing to any derived class."""
  def __init__(self, n_threads, queue_size=0):
    self._n_threads = n_threads

    self._queue = Queue.Queue(maxsize=queue_size) # 0 = infinite size
    self._error_queue = Queue.Queue(maxsize=queue_size)
    self._threads = ()
    self._terminate = threading.Event()

    self._processed_lock = threading.Lock()
    self.processed = 0

    self.start_threads(n_threads)

  @property
  def pending(self):
      return self._queue.qsize()

  def put(self, fn):
    """
    Enqueue a task function for processing.

    Requires:
      fn: a function object that takes one argument
        that is the interface associated with each
        thread.

        e.g. def download(api):
               results.append(api.download())

             self.put(download)

    Returns: self
    """
    self._queue.put(fn, block=True)
    return self

  def start_threads(self, n_threads):
    """
    Terminate existing threads and create a 
    new set if the thread number doesn't match
    the desired number.

    Required: 
      n_threads: (int) number of threads to spawn

    Returns: self
    """
    if n_threads == len(self._threads):
      return self
    
    # Terminate all previous tasks with the existing
    # event object, then create a new one for the next
    # generation of threads. The old object will hang
    # around in memory until the threads actually terminate
    # after another iteration.
    self._terminate.set()
    self._terminate = threading.Event()

    threads = []

    for _ in xrange(n_threads):
      worker = threading.Thread(
        target=self._consume_queue, 
        args=(self._terminate,)
      )
      worker.daemon = True
      worker.start()
      threads.append(worker)

    self._threads = tuple(threads)
    return self

  def are_threads_alive(self):
    """Returns: boolean indicating if any threads are alive"""
    return any(map(lambda t: t.isAlive(), self._threads))

  def kill_threads(self):
    """Kill all threads."""
    self._terminate.set()
    while self.are_threads_alive():
      time.sleep(0.1)
    self._threads = ()
    return self

  def _initialize_interface(self):
    """
    This is used to initialize the interfaces used in each thread.
    You should reimplement it in subclasses. For example, return
    an API object, file handle, or network connection. The functions
    you pass into the self._queue will get it as the first parameter.

    e.g. an implementation in a subclass.
 
        def _initialize_interface(self):
          return HTTPConnection()   

        def other_function(self):
          def threaded_file_read(connection):
              # do stuff

          self._queue.put(threaded_file_handle)

    Returns: Interface object used in threads
    """
    return None

  def _consume_queue(self, terminate_evt):
    """
    This is the main thread function that consumes functions that are
    inside the _queue object. To use, execute self._queue(fn), where fn
    is a function that performs some kind of network IO or otherwise
    benefits from threading and is independent.

    terminate_evt is automatically passed in on thread creation and 
    is a common event for this generation of threads. The threads
    will terminate when the event is set and the queue burns down.

    Returns: void
    """
    interface = self._initialize_interface()

    while not terminate_evt.is_set():
      try:
        fn = self._queue.get(block=True, timeout=1)
      except Queue.Empty:
        continue # periodically check if the thread is supposed to die

      fn = partial(fn, interface)

      try:
        self._consume_queue_execution(fn)
      except Exception as err:
        self._error_queue.put(err)

  def _consume_queue_execution(self, fn):
    """
    The actual task execution in each thread. This
    is broken out so that exceptions can be caught
    in derived classes and allow them to manipulate 
    the errant task, e.g. putting it back in the queue
    for a retry.

    Every task processed will automatically be marked complete.

    Required:
      [0] fn: A curried function that includes the interface
              as its first argument.
    Returns: void
    """

    # `finally` fires after all success or exceptions
    # exceptions are handled in derived classes
    # and uncaught ones are caught as a last resort
    # in _consume_queue to be raised on the main thread.
    try:
      fn()
    finally:
      self._queue.task_done()

      with self._processed_lock:
        self.processed += 1

  def wait(self):
    """
    Allow background threads to process until the
    task queue is empty. If there are no threads,
    in theory the queue should always be empty
    as processing happens immediately on the main thread.

    Required: None
    
    Returns: self (for chaining)

    Raises: The first exception recieved from threads
    """
    if len(self._threads):
        self._queue.join()

    try:
      # no blocking because we're guaranteed
      # that all threads have finished processing
      err = self._error_queue.get(block=False) 
      self._error_queue.task_done()
      raise err
    except Queue.Empty:
      pass

    return self

  def __del__(self):
    self.wait() # if no threads were set the queue is always empty
    self.kill_threads()

  def __enter__(self):
    if self.__class__ is ThreadedQueue and self._n_threads == 0:
      raise ValueError("Using 0 threads in base class ThreadedQueue with statement will never exit.")

    self.start_threads(self._n_threads)
    return self

  def __exit__(self, exception_type, exception_value, traceback):
    self.wait()
    self.kill_threads()
