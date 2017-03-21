import string
import random
import os
import shutil
import subprocess
from google.cloud import storage

BUCKET_NAME = 'neuroglancer'
QUEUE_NAME = 'pull-queue'
PROJECT_NAME = 'neuromancer-seung-import'

def id_generator(size=24, chars=string.ascii_uppercase + string.digits):
    return ''.join(random.choice(chars) for _ in range(size))

def random_folder():
    return './tmp/' + id_generator()

def credentials_path():
    self_dir = os.path.dirname(os.path.realpath(__file__))
    return self_dir+'/client-secret.json'

class Storage(object):
    """
    Probably rather sooner that later we will have to store datasets in S3.
    The idea is to modify this class constructor to probably take a path of 
    the problem protocol://bucket_name/dataset_name/layer_name where protocol
    can be s3, gs or file.

    file:// would be useful for when the in-memory python datasource uses too much RAM,
    or possible for writing unit tests.

    This should be the only way to interact with files, if there are methods outside this
    class the transition to many protocols will be harder.
    """

    def __init__(self, dataset_name='', layer_name='', compress=False):
        """
        Args:
            dataset_name (str, optional): Name of dataset
            layer_name (str, optional): Name of the layer
            compress (bool, optional):  If the file is large it will be download in parts and decompression will
                                        fail because of a bug in google.cloud.storage library
        """
        self._dataset_name = dataset_name
        self._layer_name = layer_name
        self._compress = compress
        self._local = random_folder()
        os.makedirs(self._local)
        self._n_objects = 0 

        self._client = storage.Client \
            .from_service_account_json(credentials_path(), project=PROJECT_NAME)

        self._bucket = self._client.get_bucket(BUCKET_NAME)

        self.get_blob = self._bucket.get_blob
        self.list_blobs = self._bucket.list_blobs

    def flush(self, folder_name=''):
        if not self._n_objects:
            return
            
        self._upload_to_gcloud(folder_name)
        shutil.rmtree(self._local)
        os.makedirs(self._local)
        self._n_objects = 0


    def add_file(self, filename , content):
        """Adds files that will later be pushed to google cloud storage
        
        Args:
            filename (string): it can contains folders
            content (string): binary data to save
        """
        self._n_objects += 1
        with open(os.path.join(self._local, filename), 'wb') as f:
            f.write(content)

    def __del__(self):
        shutil.rmtree(self._local)

    def _upload_to_gcloud(self, folder_name, compress=True, cache_control=None, content_type=None):
        def mkheader(header, content):
            if content is not None:
              return "-h '{}:{}'".format(header, content)
            return None

        headers = [
        mkheader('Content-Type', content_type),
        mkheader('Cache-Control', cache_control)
        ]

        headers = [ x for x in headers if x is not None ]
        gsutil_upload_command = "gsutil {headers} cp {compress} -a public-read {local_dir}/* {remote_dir}/".format(
          headers=" ".join(headers),
          compress=('-Z' if self._compress else ''),
          local_dir=self._local,
          remote_dir=os.path.join('gs://',BUCKET_NAME, self._dataset_name, self._layer_name, folder_name)
        )
        subprocess.check_call(gsutil_upload_command, shell=True)
