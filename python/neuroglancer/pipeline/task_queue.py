from __future__ import print_function

import json
import inspect
import base64
import copy
from collections import OrderedDict
import Queue
from functools import partial
import threading
import time

import googleapiclient.errors
import googleapiclient.discovery

from neuroglancer.pipeline.secrets import google_credentials, PROJECT_NAME, QUEUE_NAME

__all__ = ['RegisteredTask', 'TaskQueue']

registry = {}

def register_class(target_class):
    registry[target_class.__name__] = target_class

def deserialize(data):
    params = json.loads(data)
    name = params['class']
    target_class = registry[name]
    del params['class']
    return target_class(**params)

def payloadBase64Decode(payload):
    decoded_string = base64.b64decode(payload).encode('ascii')
    return deserialize(decoded_string)

class Meta(type):
    def __new__(meta, name, bases, class_dict):
        cls = type.__new__(meta, name, bases, class_dict)
        register_class(cls)
        cls._arg_names = inspect.getargspec(class_dict['__init__'])[0][1:]
        return cls

class RegisteredTask(object):
    __metaclass__ = Meta

    def __init__(self, *arg_values):
        self._args = OrderedDict(zip(self._arg_names, arg_values))

    @classmethod
    def deserialize(cls, base64data):
        obj = deserialize(base64data)
        assert type(obj) == cls
        return obj
        
    def serialize(self):
        d = copy.deepcopy(self._args)
        d['class'] = self.__class__.__name__
        return json.dumps(d)

    @property
    def payloadBase64(self):
        return base64.b64encode(self.serialize())

    @property
    def id(self):
        return self._id

    def __repr__(self):
        
        string = self.__class__.__name__ + "("
        for arg_name, arg_value in self._args.iteritems():
            if type(arg_value) is str or type(arg_value) is unicode:
                string += "{}='{}',".format(arg_name, arg_value)
            else:
                string += "{}={},".format(arg_name, arg_value)

        # remove the last comma if necessary
        if string[-1] == ',':
            string = string[:-1]

        return string + ")"  

class TaskQueue(object):
    """
    The standard usage is that a client calls lease to get the next available task,
    performs that task, and then calls task.delete on that task before the lease expires.
    If the client cannot finish the task before the lease expires,
    and has a reasonable chance of completing the task,
    it should call task.update before the lease expires.

    If the client completes the task after the lease has expired,
    it still needs to delete the task. 

    Tasks should be designed to be idempotent to avoid errors 
    if multiple clients complete the same task.
    """
    class QueueEmpty(LookupError):
        def __init__(self):
            super(LookupError, self).__init__('Queue Empty')

    def __init__(self, n_threads=40, project=PROJECT_NAME, queue_name=QUEUE_NAME):
        self._project = 's~' + project # s~ means North America, e~ means Europe
        self._queue_name = queue_name

        self._api = googleapiclient.discovery.build('taskqueue', 'v1beta2', credentials=google_credentials)

        self._queue = Queue.Queue(maxsize=0) # infinite size
        self._threads = ()
        self._terminate = threading.Event()

        self._start_threads(n_threads)

    @property
    def enqueued(self):
        """
        Returns the approximate(!) number of tasks enqueued in the cloud.

        WARNING: The number computed by Google is eventually
            consistent. It may return impossible numbers that
            are small deviations from the number in the queue.
            For instance, we've seen 1005 enqueued after 1000 
            inserts.
        
        Returns: (int) number of tasks in cloud queue
        """
        tqinfo = self.get()
        return tqinfo['stats']['totalTasks']
        
    @property
    def pending(self):
        return self._queue.qsize()

    def _start_threads(self, n_threads):
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

    def _kill_threads(self):
        self._terminate.set()
        self._threads = ()
        return self

    def _consume_queue(self, terminate_evt):
        """
        This is the main thread function that consumes functions that are
        inside the _queue object. To use, execute self._queue(fn), where fn
        is a function that performs some kind of network IO or otherwise
        benefits from threading and is independent.

        terminate_evt is automatically passed in on thread creation and 
        is a common event for this generation of threads. The threads
        will terminate when the event is set and the queue burns down.
        """
        api = googleapiclient.discovery.build('taskqueue', 'v1beta2', credentials=google_credentials)

        while not terminate_evt.is_set():
            try:
                fn = self._queue.get(block=True, timeout=1)
            except Queue.Empty:
                continue # periodically check if the thread is supposed to die

            try:
                fn(api)
            except googleapiclient.errors.HttpError as httperr:
                print(httperr)
                if httperr.resp.status != 400: # i.e. "task name is invalid"
                    self._queue.put(fn)
            finally:
                self._queue.task_done()

    def insert(self, task):
        """
        Insert a task into an existing queue.
        """
        body = {
            "payloadBase64": task.payloadBase64,
            "queueName": self._queue_name,
            "groupByTag": True,
            "tag": task.__class__.__name__
        }

        def cloud_insertion(api):
            api.tasks().insert(
                project=self._project,
                taskqueue=self._queue_name,
                body=body,
            ).execute(num_retries=6)

        if len(self._threads):
            self._queue.put(cloud_insertion, block=True)
        else:
            cloud_insertion(self._api)

        return self

    def wait(self):
        """
        Allow background threads to process until the
        task queue is empty. If there are no threads,
        in theory the queue should always be empty
        as processing happens immediately on the main thread.

        Required: None
        
        Returns: self (for chaining)
        """
        self._queue.join()
        return self

    def get(self):
        """
        Gets information about the TaskQueue
        """
        return self._api.taskqueues().get(
            project=self._project,
            taskqueue=self._queue_name,
            getStats=True,
        ).execute(num_retries=6)

    def get_task(self, tid):
        """
        Gets the named task in the TaskQueue. 
        tid is a unique string Google provides 
        e.g. '7c6e81c9b7ab23f0'
        """
        return self._api.tasks().get(
            project=self._project,
            taskqueue=self._queue_name,
            task=tid,
        ).execute(num_retries=6)

    def list(self):
        """
        Lists all non-deleted Tasks in a TaskQueue, 
        whether or not they are currently leased, up to a maximum of 100.
        """
        return self._api.tasks().list(
            project=self._project, 
            taskqueue=self._queue_name
        ).execute(num_retries=6)

    def update(self, task):
        """
        Update the duration of a task lease.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def lease(self, tag=None):
        """
        Acquires a lease on the topmost N unowned tasks in the specified queue.
        Required query parameters: leaseSecs, numTasks
        """
        
        tasks = self._api.tasks().lease(
            project=self._project,
            taskqueue=self._queue_name, 
            numTasks=1, 
            leaseSecs=600,
            groupByTag=(tag is not None),
            tag=tag,
        ).execute(num_retries=6)

        if not 'items' in tasks:
            raise TaskQueue.QueueEmpty
          
        task_json = tasks['items'][0]
        t = payloadBase64Decode(task_json['payloadBase64'])
        t._id =  task_json['id']
        return t

    def patch(self):
        """
        Update tasks that are leased out of a TaskQueue.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def purge(self):
        """Deletes all tasks in the queue."""
        while True:
            lst = self.list()
            if not lst.has_key('items'):
                break

            for task in lst['items']:
                self.delete(task['id'])
            self.wait()
        return self

    def delete(self, task_id):
        """Deletes a task from a TaskQueue."""
        if isinstance(task_id, RegisteredTask):
            task_id = task_id.id

        def cloud_delete(api):
            api.tasks().delete(
                project=self._project,
                taskqueue=self._queue_name,
                task=task_id,
            ).execute(num_retries=6)

        if len(self._threads):
            self._queue.put(cloud_delete, block=True)
        else:
            cloud_delete(self._api)
        return self

    def __del__(self):
        self._queue.join() # if no threads were set the queue is always empty
        self._kill_threads()


