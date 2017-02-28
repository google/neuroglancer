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


class Storage(object):

    def __init__(self, dataset_name='', layer_name='', compress=True):
        self._dataset_name = dataset_name
        self._layer_name = layer_name
        self._compress = compress
        self._local = random_folder()
        os.makedirs(self._local)
        self._n_objects = 0 

        client = storage.Client \
            .from_service_account_json('client-secret.json')

        self._bucket = client.get_bucket(BUCKET_NAME)

    def get_blob(self, name):
        return self._bucket.get_blob(name)


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
        gsutil_upload_command = "gsutil {headers} -m cp {compress} -a public-read {local_dir}/* {remote_dir}".format(
          headers=" ".join(headers),
          compress=('-Z' if self._compress else ''),
          local_dir=self._local,
          remote_dir=os.path.join('gs://',BUCKET_NAME, self._dataset_name, self._layer_name, folder_name)
        )
        subprocess.check_call(gsutil_upload_command, shell=True)
