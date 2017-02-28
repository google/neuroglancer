import json
import base64

class Task(object):
    """
    A task is defined by an arbitrary blob of data that should be understood by the client.
    """
    def __init__(self):
        self._body = None
        self._info_path = None
    
    @property
    def chunk_path(self):
        if self._body:
            self._chunk_path = self._body['payloadBase64']['chunk_path']
        return self._chunk_path

    @chunk_path.setter
    def chunk_path(self, value):
        self._chunk_path = value

    @property
    def chunk_encoding(self):
        if self._body:
            self._chunk_encoding = self._body['payloadBase64']['chunk_encoding']
        return self._chunk_encoding

    @chunk_encoding.setter
    def chunk_encoding(self, value):
        self._chunk_encoding = value

    @property
    def info_path(self):
        if self._body:
            self._info_path = self._body['payloadBase64']['info_path']
        return self._info_path

    @info_path.setter
    def info_path(self, value):
        self._info_path = value


    @property
    def body(self):
        if not self._body:
            payload = json.dumps({
                'chunk_path': self.chunk_path,
                'chunk_encoding': self.chunk_encoding,
                'info_path': self.info_path
            })
            payloadBase64 = base64.b64encode(payload)

            self._body = {
              "payloadBase64": payloadBase64,
            }

        return self._body
    
    @body.setter
    def body(self, value):
        decoded_string =  base64.b64decode(value['payloadBase64']).encode('ascii')
        value['payloadBase64'] = json.loads(decoded_string)
        self._body = value

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

    def __init__(self, project, queue_name, local=True):
        self._project = 's~' + project # unsure why this is necessary
        self._queue_name = queue_name

        if local:
            from oauth2client import service_account
            self._credentials = service_account.ServiceAccountCredentials \
            .from_json_keyfile_name('client-secret.json')
        else:
            from oauth2client.client import GoogleCredentials
            self._credentials = GoogleCredentials.get_application_default()

        from googleapiclient.discovery import build
        self.api =  build('taskqueue', 'v1beta2', credentials=self._credentials).tasks()


    def insert(self, task):
        """
        Insert a task into an existing queue.
        """
        body = task.body
        body["queueName"] = self._queue_name

        self.api.insert(project=self._project,
                        taskqueue=self._queue_name,
                        body=body).execute()


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
        print self.api.list(project=self._project, taskqueue=self._queue_name).execute()


    def update(self, task):
        """
        Update the duration of a task lease.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def lease(self):
        """
        Acquires a lease on the topmost N unowned tasks in the specified queue.
        Required query parameters: leaseSecs, numTasks
        """
        tasks = self.api.lease(
            project=self._project,
            taskqueue=self._queue_name, 
            numTasks=1, 
            leaseSecs=600).execute()


        if not 'items' in tasks:
            raise TaskQueue.QueueEmpty
        
        task_json = tasks['items'][0]
        t = Task()
        t.body = task_json
        return t

    def patch(self):
        """
        Update tasks that are leased out of a TaskQueue.
        Required query parameters: newLeaseSeconds
        """
        raise NotImplemented

    def delete(self, task):
        """Deletes a task from a TaskQueue."""
        print task.body
        self.api.delete(
            project=self._project,
            taskqueue=self._queue_name,
            task=task.body['id']).execute()
