from __future__ import print_function

import json
import inspect
import base64
import copy
from collections import OrderedDict

from googleapiclient.discovery import build

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
    decoded_string =  base64.b64decode(payload).encode('ascii')
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

    def serialize(self):
        d = copy.deepcopy(self._args)
        d['class'] = self.__class__.__name__
        return json.dumps(d)

    @property
    def payloadBase64(self):
        return base64.b64encode(self.serialize())

    def __repr__(self):
        
        string = self.__class__.__name__ + "("
        for arg_name, arg_value in self._args.iteritems():
            if type(arg_value) is str or type(arg_value) is unicode:
                string += "{}='{}',".format(arg_name, arg_value)
            else:
                string += "{}={},".format(arg_name, arg_value)

        return string[:-1] + ")"  #remove the last comma


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

    def __init__(self, project=PROJECT_NAME, queue_name=QUEUE_NAME, local=True):
        self._project = 's~' + project # unsure why this is necessary
        self._queue_name = queue_name

        self.api =  build('taskqueue', 'v1beta2', credentials=google_credentials).tasks()


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

        self.api.insert(project=self._project,
                        taskqueue=self._queue_name,
                        body=body).execute(num_retries=6)


    def get(self):
        """
        Gets the named task in a TaskQueue.
        """
        raise NotImplemented

    def list(self):
        """
        Lists all non-deleted Tasks in a TaskQueue, 
        whether or not they are currently leased, up to a maximum of 100.
        """
        print (self.api.list(project=self._project, taskqueue=self._queue_name).execute(num_retries=6))


    def update(self, task):
        """
        Update the duration of a task lease.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def lease(self, tag=''):
        """
        Acquires a lease on the topmost N unowned tasks in the specified queue.
        Required query parameters: leaseSecs, numTasks
        """
        if not tag:
            tasks = self.api.lease(
                project=self._project,
                taskqueue=self._queue_name, 
                numTasks=1, 
                leaseSecs=600,
                ).execute(num_retries=6)
        else:
            tasks = self.api.lease(
                project=self._project,
                taskqueue=self._queue_name, 
                numTasks=1, 
                leaseSecs=600,
                groupByTag=True,
                tag=tag).execute(num_retries=6)


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

    def delete(self, task):
        """Deletes a task from a TaskQueue."""
        self.api.delete(
            project=self._project,
            taskqueue=self._queue_name,
            task=task._id).execute(num_retries=6)
