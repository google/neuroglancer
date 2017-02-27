import os
import io
import re 
import sys
import subprocess
import math
import tempfile
import shutil
import gc
import gzip
from itertools import product

from google.cloud import storage
import numpy as np
from tqdm import tqdm

GCLOUD_PROJECT_NAME = 'neuromancer-seung-import'
GCLOUD_BUCKET_NAME = 'neuroglancer'
GCLOUD_QUEUE_NAME = 'pull-queue'
COMMON_STAGING_DIR = './staging/'

def mkdir(path):
  if path != '' and not os.path.exists(path):
    os.makedirs(path)
  return path

def touch(path):
  mkdir(os.path.dirname(path))
  open(path, 'a').close()

def list_shape(shape, elem=None):
    """create Nd list filled wtih elem. e.g. shape([2,2], 0) => [ [0,0], [0,0] ]"""

    if (len(shape) == 0):
        return []

    def helper(elem, shape, i):
        if len(shape) - 1 == i:
            return [elem] * shape[i]
        return [ helper(elem, shape, i+1) for _ in xrange(shape[i]) ]

    return helper(elem, shape, 0)

def xyzrange(start_vec, end_vec=None, stride_vec=(1,1,1)):
  if end_vec is None:
    end_vec = start_vec
    start_vec = (0,0,0)

  start_vec = np.array(start_vec, dtype=int)
  end_vec = np.array(end_vec, dtype=int)

  rangeargs = ( (start, end, stride) for start, end, stride in zip(start_vec, end_vec, stride_vec) )
  xyzranges = [ xrange(*arg) for arg in rangeargs ]
  
  def vectorize():
    pt = Vec3(0,0,0)
    for x,y,z in product(*xyzranges):
      pt.x, pt.y, pt.z = x, y, z
      yield pt

  return vectorize()

def format_cloudpath(cloudpath):
  """convert gs://bucket/dataset/layer or /bucket/dataset/layer
                bucket/dataset/layer/
     to: bucket/dataset/layer """

  cloudpath = re.sub(r'^(gs:)?\/+', '', cloudpath)
  cloudpath = re.sub(r'\/+$', '', cloudpath)
  return cloudpath

def cloudpath_to_hierarchy(cloudpath):
  """Extract bucket, dataset, layer from cloudpath"""
  cloudpath = format_cloudpath(cloudpath)
  return cloudpath.split('/')

def gcloudFileIterator(cloudpaths, keep_files=None, use_ls=True, compress=False):
  """
    Given a set of cloud paths, present each image file via a generator
    in sorted order. If keep_files is specified, your files will
    be cached after download. Failed downloads will be marked as 
    zero length files.

    Required:
      cloudpaths: [ str, ... ] list of cloud paths fed to download_from_gcloud
    Optional:
      keep_files: (str) Cache downloaded files in this directory, default no caching
      use_ls: (boolean) Download a listing of all files in the cloud directory to avoid
         downloading nonexistant files one by one. Can be a massive performance boost 
         when requesting moderate to large numbers of files, but will be a massive 
         slowdown when requesting a few files from a huge directory.
  """
  if keep_files == None:
    download_dir = tempfile.mkdtemp(dir=mkdir(COMMON_STAGING_DIR))
  else:
    download_dir = mkdir(keep_files)

  def noextensions(fnames):
    return [ os.path.splitext(fname)[0] for fname in fnames ]

  filenames = noextensions(os.listdir(download_dir))

  basepathmap = { os.path.basename(path): os.path.dirname(path) for path in cloudpaths }

  # check which files are already cached, we only want to download ones not in cache
  requested = set([ os.path.basename(path) for path in cloudpaths ])
  already_have = requested.intersection(set(filenames))
  to_download = requested.difference(already_have)
  
  # ask gcloud which files are in the directory we care about
  # and filter out the ones it doesn't have. This is much faster than
  # requesting them one by one and getting a 404.
  if use_ls:
    in_cloud = set( gcloud_ls(os.path.dirname(cloudpaths[0])) )
    future_failed_downloads = to_download.difference(in_cloud)
    to_download = to_download.difference(future_failed_downloads)
  else:
    future_failed_downloads = set([])

  download_paths = [ os.path.join(basepathmap[fname], fname) for fname in to_download ]

  # delete now useless memory before the start of a potentially long process
  # each of these are potentially tens to over a hundred megabytes on mip levels 0 to 2
  cloudpaths = None
  in_cloud = None
  basepathmap = None 
  already_have = None
  filenames = None
  gc.collect()

  if len(download_paths) > 0:
    download_from_gcloud(download_paths, download_dir, gzip=compress)

  filenames = os.listdir(download_dir)
  gzipped = set([ os.path.splitext(fname)[0] for fname in filenames if os.path.splitext(fname)[1] == '.gz' ])
  filenames = set(noextensions(filenames))
  
  # Mark failed downloads with zero byte files so we know not to try to fetch them again
  # This includes files not in gcloud and actual failures as measured by their failure
  # to materialize.
  failed_downloads = to_download.difference(filenames).union(future_failed_downloads)
  for failure_path in failed_downloads:
    touch(os.path.join(download_dir, failure_path))

  filenames.update(failed_downloads)

  # If we were requesting a subset of files in cache, limit the 
  # returned results to those files.
  filenames = list(filenames.intersection(requested))
  filenames.sort()

  for filename in filenames:
    if filename in gzipped:
      openfn = gzip.open
      filename = filename + '.gz'
    else:
      openfn = open

    path = os.path.join(download_dir, filename)
    with openfn(path, 'rb') as file:
      yield file 

  if not keep_files:
    shutil.rmtree(download_dir)

def gcloud_ls(cloudpath):
  match = re.match(r'^gs://([\w\-\d_]+)/(.*)$', cloudpath)
  
  (bucket_name, directory) = match.groups()

  client = storage.Client(project=GCLOUD_PROJECT_NAME)
  bucket = client.get_bucket(bucket_name)
  cloud_iterator = bucket.list_blobs(prefix=directory, max_results=int(2e7))

  return [ os.path.basename(blob.name) for blob in cloud_iterator ]

def download_from_gcloud(cloudpaths, destination, log=None, gzip=False):
  # gsutil chokes when you ask it to upload more than about 1500 files at once
  # so we're using streaming mode (-I) to enable it to handle arbitrary numbers of files
  # -m = multithreaded upload

  gsutil_upload_cmd = "gsutil -m cp {logging} -I {destination}".format(
    logging=('-L {}'.format(log) if log is not None else ''),
    destination=destination,
  )

  print(gsutil_upload_cmd)

  pipeout = sys.stdout
  if log is not None:
    pipeout = open(os.devnull, 'w')

  gcs_pipe = subprocess.Popen([gsutil_upload_cmd], 
    stdin=subprocess.PIPE, 
    stdout=pipeout, 
    shell=True
  )

  # shoves filenames into pipe stdin, waits for process to execute, and terminates
  # returns stdout
  gcs_pipe.communicate(input="\n".join(cloudpaths))

  if gzip:
    paths = [ os.path.join(destination, name) for name in os.listdir(destination) ]
    for path in tqdm(paths, desc="Gzipping Downloads"):
      subprocess.check_output(['gzip', path])

def upload_to_gcloud(filenames, cloudpath, headers={}, compress=False, public=False):
  
  mkheader = lambda header, content: "-h '{}:{}'".format(header, content)
  headers = [ mkheader(key, content) for key, content in headers.iteritems() if content != '' ]

  # gsutil chokes when you ask it to upload more than about 1500 files at once
  # so we're using streaming mode (-I) to enable it to handle arbitrary numbers of files
  # -m = multithreaded upload, -h = headers

  cloudpath = re.sub(r'^/', '', cloudpath)
  cloudpath = re.sub(r'/$', '', cloudpath)

  gsutil_upload_cmd = "gsutil -m {headers} cp -I {compress} {public} gs://{cloudpath}/".format(
    headers=" ".join(headers),
    compress=('-Z' if compress else ''),
    public=('-a public-read' if public else ''),
    cloudpath=cloudpath,
  )

  print(gsutil_upload_cmd)

  gcs_pipe = subprocess.Popen([gsutil_upload_cmd], 
    stdin=subprocess.PIPE, 
    stdout=sys.stdout, 
    shell=True
  )

  # shoves filenames into pipe stdin, waits for process to execute, and terminates
  # returns stdout
  gcs_pipe.communicate(input="\n".join(filenames))


def map2(fn, a, b):
    assert len(a) == len(b)

    if isinstance(a, Vec3) or isinstance(b, Vec3):
      result = Vec3(0,0,0)
    else:    
      result = np.empty(len(a))

    for i in xrange(len(result)):
        result[i] = fn(a[i], b[i])

    return result

def max2(a, b, dtype=np.int32):
    return map2(max, a, b).astype(dtype)

def min2(a, b, dtype=np.int32):
    return map2(min, a, b).astype(dtype)

def clamp(val, low, high):
  return min(max(val, low), high)

class Vec3(np.ndarray):
    def __new__(cls, x, y, z, dtype=int):
      return super(Vec3, cls).__new__(cls, shape=(3,), buffer=np.array([x,y,z]).astype(dtype), dtype=dtype)

    @classmethod
    def triple(cls, x):
      return Vec3(x,x,x)

    @classmethod
    def clamp(cls, val, minvec, maxvec):
      return Vec3(*min2(max2(val, minvec), maxvec))

    @property
    def x(self):
        return self[0]

    @x.setter
    def x(self, val):
        self[0] = val

    @property
    def y(self):
        return self[1]

    @y.setter
    def y(self, val):
        self[1] = val

    @property
    def z(self):
        return self[2]

    @z.setter
    def z(self, val):
        self[2] = val

    def clone(self):
      return Vec3(self[0], self[1], self[2])

    def null(self):
        return self.length() <= 10 * np.finfo(np.float32).eps

    def dot(self, vec):
        return (self.x * vec.x) + (self.y * vec.y) + (self.z * vec.z)

    def length(self):
        return math.sqrt(self[0] * self[0] + self[1] * self[1] + self[2] + self[2])

    def rectVolume(self):
        return self[0] * self[1] * self[2]

    def __hash__(self):
        return repr(self)

    def __repr__(self):
        return "Vec3({},{},{})".format(self.x, self.y, self.z)

class Bbox(object):

    def __init__(self, a, b):
        self.minpt = Vec3(
            min(a[0], b[0]),
            min(a[1], b[1]),
            min(a[2], b[2])
        )

        self.maxpt = Vec3(
            max(a[0], b[0]),
            max(a[1], b[1]),
            max(a[2], b[2])
        )

    @classmethod
    def from_vec(cls, vec):
      return Bbox( (0,0,0), vec )

    @classmethod
    def from_filename(cls, filename):
      match = re.match(r'^(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)', os.path.basename(filename))

      (xmin, xmax,
       ymin, ymax,
       zmin, zmax) = map(int, match.groups())

      return Bbox( (xmin, ymin, zmin), (xmax, ymax, zmax) )

    @classmethod
    def clamp(cls, bbx0, bbx1):
      result = bbx0.clone()
      result.minpt = Vec3.clamp(bbx0.minpt, bbx1.minpt, bbx1.maxpt)
      result.maxpt = Vec3.clamp(bbx0.maxpt, bbx1.minpt, bbx1.maxpt)
      return result

    def size3(self):
      return Vec3(*(self.maxpt - self.minpt))

    def volume(self):
      return self.size3().rectVolume()

    def center(self):
      return (self.minpt + self.maxpt) / 2.0

    def fit_to_chunk_size(self, chunk_size):
      chunk_size = Vec3(*chunk_size)
      result = self.clone()
      result.minpt = result.minpt - np.mod(result.minpt, chunk_size)
      result.maxpt = result.maxpt + (chunk_size - np.mod(result.maxpt, chunk_size))
      return result

    def contains(self, point):
      return (
            point[0] >= self.minpt[0] 
        and point[1] >= self.minpt[1]
        and point[2] >= self.minpt[2] 
        and point[0] <= self.maxpt[0] 
        and point[1] <= self.maxpt[1]
        and point[2] <= self.maxpt[2]
      )

    def contains_bbox(self, bbox):
      return self.contains(bbox.minpt) and self.contains(bbox.maxpt)

    def clone(self):
      return Bbox(self.minpt, self.maxpt)

    # note that operand can be a vector 
    # or a scalar thanks to numpy
    def __sub__(self, operand): 
      tmp = self.clone()
      
      if isinstance(operand, Bbox):
        tmp.minpt -= operand.minpt
        tmp.maxpt -= operand.maxpt
      else:
        tmp.minpt -= operand
        tmp.maxpt -= operand

      return tmp

    def __add__(self, operand):
      tmp = self.clone()
      
      if isinstance(operand, Bbox):
        tmp.minpt += operand.minpt
        tmp.maxpt += operand.maxpt
      else:
        tmp.minpt += operand
        tmp.maxpt += operand

      return tmp

    def __mul__(self, operand):
      tmp = self.clone()
      tmp.minpt *= operand
      tmp.maxpt *= operand
      return tmp

    def __div__(self, operand):
      tmp = self.clone()
      tmp.minpt /= operand
      tmp.maxpt /= operand
      return tmp

    def __eq__(self, other):
      return np.array_equal(self.minpt, other.minpt) and np.array_equal(self.maxpt, other.maxpt)

    def __repr__(self):
      return "Bbox({},{})".format(self.minpt, self.maxpt)

BLOB_BUCKET = None

def credentials_path():
    self_dir = os.path.dirname(os.path.realpath(__file__))
    return os.path.join(self_dir, 'client-secret.json')

def create_bucket_from_secrets():
    client = storage.Client.from_service_account_json('client-secret.json')
    return client.get_bucket(GCLOUD_BUCKET_NAME)

def get_blob(name):
    global BLOB_BUCKET
    if BLOB_BUCKET is None:
        BLOB_BUCKET = create_bucket_from_secrets()

    return BLOB_BUCKET.get_blob(name)

class Storage(object):

    def __init__(self, dataset_name='', layer_name='', compress=True, public=False):
        self._dataset_name = dataset_name
        self._layer_name = layer_name
        self._compress = compress
       
        self._local = None
        self._n_objects = 0 

        self._public = public

        self.emptyCache()

    def emptyCache(self):
        if self._local is not None:
            shutil.rmtree(self._local)

        self._local = tempfile.mkdtemp()
        self._n_objects = 0 

    def flush(self, cloud_directory=''):
        if not self._n_objects:
            return

        filenames = [ os.path.join(self._local, filename) for filename in os.listdir(self._local) ]
        
        cloudpath = os.path.join(
            GCLOUD_BUCKET_NAME,
            self._dataset_name,
            self._layer_name,
            cloud_directory
        )

        headers = {}
        if self._layer_name == 'image':
            headers['Content-Type'] = 'image/jpeg'
        elif self._layer_name == 'segmentation':
            headers['Content-Type'] = 'application/octet-stream'

        upload_to_gcloud(filenames, cloudpath, 
            headers=headers,
            compress=self._compress, 
            public=self._public,
        )

        self.emptyCache()

    def add_file(self, filename, content):
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
