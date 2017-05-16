from collections import namedtuple
from cStringIO import StringIO
from Queue import Queue
import os.path
import re
from threading import Thread, Lock
from functools import partial

from glob import glob
import google.cloud.exceptions
from google.cloud.storage import Client
import boto 
from boto.s3.connection import S3Connection
import gzip

from neuroglancer.pipeline.secrets import PROJECT_NAME, google_credentials_path, aws_credentials
from neuroglancer.pipeline.threaded_queue import ThreadedQueue

class Storage(ThreadedQueue):
    """
    Probably rather sooner that later we will have to store datasets in S3.
    The idea is to modify this class constructor to probably take a path of 
    the problem protocol://bucket_name/dataset_name/layer_name where protocol
    can be s3, gs or file.

    file:// would be useful for when the in-memory python datasource uses too much RAM,
    or possible for writing unit tests.

    This should be the only way to interact with files for any of the protocols.
    """
    gzip_magic_numbers = [0x1f,0x8b]
    path_regex = re.compile(r'^(gs|file|s3)://(/?.*?)/(.*/)?([^//]+)/([^//]+)/?$')
    ExtractedPath = namedtuple('ExtractedPath',
        ['protocol','bucket_name','dataset_path','dataset_name','layer_name'])

    def __init__(self, layer_path='', n_threads=20):
        self._layer_path = layer_path
        self._path = self.extract_path(layer_path)
        
        if self._path.protocol == 'file':
            self._interface_cls = FileInterface
        elif self._path.protocol == 'gs':
            self._interface_cls = GoogleCloudStorageInterface
        elif self._path.protocol == 's3':
            self._interface_cls = S3Interface

        self._interface = self._interface_cls(self._path)

        super(Storage, self).__init__(n_threads)

    def _initialize_interface(self):
        return self._interface_cls(self._path)

    @property
    def layer_path(self):
        return self._layer_path

    def get_path_to_file(self, file_path):
        return os.path.join(self._layer_path, file_path)

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
        return self.put_files([ (file_path, content) ], compress, block=False)

    def put_files(self, files, compress=False, block=True):
        """
        Put lots of files at once and get a nice progress bar. It'll also wait
        for the upload to complete, just like get_files.

        Required:
            files: [ (filepath, content), .... ]
        """
        def base_uploadfn(path, content, interface):
            interface.put_file(path, content, compress)

        for path, content in files:
            if compress:
                content = self._compress(content)

            uploadfn = partial(base_uploadfn, path, content)

            if len(self._threads):
                self.put(uploadfn)
            else:
                uploadfn(self._interface)

        if block:
            self.wait()

        return self

    def get_file(self, file_path):
        # Create get_files does uses threading to speed up downloading

        content, decompress = self._interface.get_file(file_path)
        if content and decompress != False:
            content = self._maybe_uncompress(content)
        return content

    def get_files(self, file_paths):
        """
        returns a list of files faster by using threads
        """

        results = []

        def get_file_thunk(path, interface):
            result = error = None 

            try:
                result = interface.get_file(path)
            except Exception as err:
                error = err
                print(err)
            
            content, decompress = result
            if content and decompress:
                content = self._maybe_uncompress(content)

            results.append({
                "filename": path,
                "content": content,
                "error": error,
            })

        for path in file_paths:
            if len(self._threads):
                self.put(partial(get_file_thunk, path))
            else:
                get_file_thunk(path, self._interface)

        self.wait()

        return results

    def delete_file(self, file_path):

        def thunk_delete(interface):
            interface.delete_file(file_path)

        if len(self._threads):
            self.put(thunk_delete)
        else:
            thunk_delete(self._interface)

        return self

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

    @staticmethod
    def _compress(content):
        stringio = StringIO()
        gzip_obj = gzip.GzipFile(mode='wb', fileobj=stringio)
        gzip_obj.write(content)
        gzip_obj.close()
        return stringio.getvalue()

    @staticmethod
    def _uncompress(content):
        stringio = StringIO(content)
        with gzip.GzipFile(mode='rb', fileobj=stringio) as gfile:
            return gfile.read()

    def list_files(self, prefix=""):
        for f in self._interface.list_files(prefix):
            yield f

class FileInterface(object):
    lock = Lock()

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
        dirpath = os.path.dirname(path)
        with FileInterface.lock:
            if not os.path.exists(dirpath):
                os.makedirs(dirpath)

        with open(path, 'wb') as f:
            f.write(content)

    def get_file(self, file_path):
        path = self.get_path_to_file(file_path)
        try:
            with open(path, 'rb') as f:
                return f.read(), None
        except IOError:
            return None, False

    def delete_file(self, file_path):
        path = self.get_path_to_file(file_path)
        if os.path.exists(path):
            os.remove(path)

    def list_files(self, prefix):
        layer_path = self.get_path_to_file("")        
        path = os.path.join(layer_path, prefix)
        path += "*"
        filenames = []
        for file_path in glob(path):
            if not os.path.isfile(file_path):
                continue
            filenames.append(os.path.basename(file_path))
        return _radix_sort(filenames).__iter__()

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
        # blob handles the decompression in the case
        # it is necessary
        return blob.download_as_string(), False

    def delete_file(self, file_path):
        key = self.get_path_to_file(file_path)
        
        try:
            self._bucket.delete_blob( key )
        except google.cloud.exceptions.NotFound:
            pass

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
        """
            There are many types of execptions which can get raised
            from this method. We want to make sure we only return
            None when the file doesn't exist.

            TODO maybe implement retry in case of timeouts. 
        """
        k = boto.s3.key.Key(self._bucket)
        k.key = self.get_path_to_file(file_path)
        try:
            return k.get_contents_as_string(), k.content_encoding == "gzip"
        except boto.exception.S3ResponseError as e:
            if e.error_code == 'NoSuchKey':
                return None, False
            else:
                raise e

    def delete_file(self, file_path):
        k = boto.s3.key.Key(self._bucket)
        k.key = self.get_path_to_file(file_path)
        self._bucket.delete_key(k)

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

def _radix_sort(L, i=0):
    """
    Most significant char radix sort
    """
    if len(L) <= 1: 
        return L
    done_bucket = []
    buckets = [ [] for x in range(255) ]
    for s in L:
        if i >= len(s):
            done_bucket.append(s)
        else:
            buckets[ ord(s[i]) ].append(s)
    buckets = [ _radix_sort(b, i + 1) for b in buckets ]
    return done_bucket + [ b for blist in buckets for b in blist ]