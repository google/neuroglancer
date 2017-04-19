from collections import namedtuple
from cStringIO import StringIO
from Queue import Queue
import os.path
import re
from threading import Thread

from glob import glob
from google.cloud.storage import Client
import boto 
from boto.s3.connection import S3Connection
import gzip

from neuroglancer.pipeline.secrets import PROJECT_NAME, google_credentials_path, aws_credentials

class Storage(object):
    """
    Probably rather sooner that later we will have to store datasets in S3.
    The idea is to modify this class constructor to probably take a path of 
    the problem protocol://bucket_name/dataset_name/layer_name where protocol
    can be s3, gs or file.

    file:// would be useful for when the in-memory python datasource uses too much RAM,
    or possible for writing unit tests.

    This should be the only way to interact with files, either for anyone of the protocols
    """
    gzip_magic_numbers = [0x1f,0x8b]
    path_regex = re.compile(r'^(gs|file|s3)://(/?.*?)/(.*/)?([^//]+)/([^//]+)/?$')
    ExtractedPath = namedtuple('ExtractedPath',
        ['protocol','bucket_name','dataset_path','dataset_name','layer_name'])

    def __init__(self, layer_path='', n_threads=10):

        self._layer_path = layer_path
        self._path = self.extract_path(layer_path)
        self._n_threads = n_threads

        if self._path.protocol == 'file':
            self._interface = FileInterface
        elif self._path.protocol == 'gs':
            self._interface = GoogleCloudStorageInterface
        elif self._path.protocol == 's3':
            self._interface = S3Interface

        if self._n_threads:
            self._create_processing_queue()

    def get_path_to_file(self, file_path):
        return os.path.join(self._layer_path, file_path)

    def _create_processing_queue(self):
        self._queue = Queue(maxsize=self._n_threads*4)
        for _ in xrange(self._n_threads):
            worker = Thread(target=self._process_task)
            worker.setDaemon(True)
            worker.start()

    def _process_task(self):
        """
        Connections to s3 or gcs are likely not thread-safe,
        to account for that every worker create it's own 
        connection.
        """
        interface = self._interface(self._path)
        while True:
            # task[0] referes to an string with
            # the method name.
            # task[1:] are the arguments to the
            # method.
            task = self._queue.get()
            getattr(interface, task[0])(*task[1:])
            self._queue.task_done()

    @classmethod
    def extract_path(cls, layer_path):
        match = cls.path_regex.match(layer_path)
        if not match:
            return None
        else:
            return cls.ExtractedPath(*match.groups())

    def put_file(self, file_path, content, compress=False):
        """ 
        Args:
            filename (string): it can contains folders
            content (string): binary data to save
        """
        if compress:
            content = self._compress(content)

        if self._n_threads:
            try:
                self._queue.put(('put_file', file_path, content, compress))
            except Queue.Full:
                self.wait_until_queue_empty()
                self._queue.put(('put_file', file_path, content, compress))
        else:
            self._interface(self._path).put_file(file_path, content, compress)


    def get_file(self, file_path):
        # Create get_files does uses threading to speed up downloading

        content, decompress = self._interface(self._path).get_file(file_path)
        if content and decompress != False:
            content = self._maybe_uncompress(content)
        return content

    def _maybe_uncompress(self, content):
        """ Uncompression is applied if the first to bytes matches with
            the gzip magic numbers. 
            There is once chance in 65536 that a file that is not gzipped will
            be ungzipped. That's why is better to set uncompress to False in
            get file.
        """
        if [ord(byte) for byte in content[:2]] == self.gzip_magic_numbers:
            return self._uncompress(content)
        return content

    def get_files(self, file_paths):
        """
        returns a list of files faster by using threads
        """
        pass

    @staticmethod
    def _compress(content):
        stringio = StringIO()
        gzip_obj = gzip.GzipFile(mode='wb', fileobj=stringio)
        gzip_obj.write(content)
        gzip_obj.close()
        return  stringio.getvalue()

    @staticmethod
    def _uncompress(content):
        stringio = StringIO(content)
        with gzip.GzipFile(mode='rb', fileobj=stringio) as gfile:
            return gfile.read()

    def list_files(self, prefix=""):
        for f in self._interface(self._path).list_files(prefix):
            yield f

    def wait_until_queue_empty(self):
        if self._n_threads:
            self._queue.join()

    def __del__(self):
        self.wait_until_queue_empty()

class FileInterface(object):

    def __init__(self, path):
        self._path = path

    def get_path_to_file(self, file_path):
        
        clean = filter(None,[self._path.bucket_name,
                             self._path.dataset_path,
                             self._path.dataset_name,
                             self._path.layer_name,
                             file_path])
        return  os.path.join(*clean)

    def put_file(self, file_path, content, compress):
        path = self.get_path_to_file(file_path)
        try:
            with open(path, 'wb') as f:
                f.write(content)
        except IOError:
            try: 
                # a raise condition is possible
                # where the first try fails to create the file
                # because the folder that contains it doesn't exists
                # but when we try to create here, some other thread
                # already created this folder
                os.makedirs(os.path.dirname(path))
            except OSError:
                pass

            with open(path, 'wb') as f:
                f.write(content)

    def get_file(self, file_path):
        path = self.get_path_to_file(file_path) 
        try:
            with open(path, 'rb') as f:
                return f.read(), None
        except IOError:
            return None, False

    def list_files(self, prefix):
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        path += "*"

        for file_path in glob(path):
            if not os.path.isfile(file_path):
                continue
            yield os.path.basename(file_path)

class GoogleCloudStorageInterface(object):
    def __init__(self, path):
        self._path = path
        client = Client.from_service_account_json(
            google_credentials_path,
            project=PROJECT_NAME)
        self._bucket = client.get_bucket(self._path.bucket_name)

    def get_path_to_file(self, file_path):
        clean = filter(None,[self._path.dataset_path,
                             self._path.dataset_name,
                             self._path.layer_name,
                             file_path])
        return  os.path.join(*clean)


    def put_file(self, file_path, content, compress):
        """ 
        TODO set the content-encoding to
        gzip in case of compression.
        """
        key = self.get_path_to_file(file_path)
        blob = self._bucket.blob( key )
        blob.upload_from_string(content)
        if compress:
            blob.content_encoding = "gzip"
            blob.patch()

    def get_file(self, file_path):
        key = self.get_path_to_file(file_path)
        blob = self._bucket.get_blob( key )
        if not blob:
            return None, False
        return blob.download_as_string(), blob.content_encoding == "gzip"

    def list_files(self, prefix):
        """
        if there is no trailing slice we are looking for files with that prefix
        """
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        for blob in self._bucket.list_blobs(prefix=path):
            filename =  os.path.basename(prefix) + blob.name[len(path):]
            if '/' not in filename:
                yield filename

class S3Interface(object):

    def __init__(self, path):
        self._path = path
        conn = S3Connection(aws_credentials['AWS_ACCESS_KEY_ID'],
                            aws_credentials['AWS_SECRET_ACCESS_KEY'])
        self._bucket = conn.get_bucket(self._path.bucket_name)

    def get_path_to_file(self, file_path):
        clean = filter(None,[self._path.dataset_path,
                             self._path.dataset_name,
                             self._path.layer_name,
                             file_path])
        return  os.path.join(*clean)

    def put_file(self, file_path, content, compress):
        k = boto.s3.key.Key(self._bucket)
        k.key = self.get_path_to_file(file_path)
        if compress:
            k.set_contents_from_string(
                content,
                headers={"Content-Encoding": "gzip"})
        else:
            k.set_contents_from_string(content)
            
    def get_file(self, file_path):
        k = boto.s3.key.Key(self._bucket)
        k.key = self.get_path_to_file(file_path)
        try:
            return k.get_contents_as_string(), k.content_encoding == "gzip"
        except boto.exception.S3ResponseError:
            return None, False

    def list_files(self, prefix):
        """
        if there is no trailing slice we are looking for files with that prefix
        """
        from tqdm import tqdm
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        for blob in self._bucket.list(prefix=path):
            filename =  os.path.basename(prefix) + blob.name[len(path):]
            if '/' not in filename:
                yield filename