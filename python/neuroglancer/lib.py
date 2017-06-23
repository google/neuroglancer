from __future__ import print_function

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
import operator
import time
from itertools import product

from google.cloud import storage
import numpy as np
from tqdm import tqdm

GCLOUD_PROJECT_NAME = 'neuromancer-seung-import'
GCLOUD_BUCKET_NAME = 'neuroglancer'
GCLOUD_QUEUE_NAME = 'pull-queue'
COMMON_STAGING_DIR = './staging/'

CLOUD_COMPUTING = False if 'CLOUD_COMPUTING' not in os.environ else bool(int(os.environ['CLOUD_COMPUTING']))

def mkdir(path):
  try:
    if path != '' and not os.path.exists(path):
      os.makedirs(path)
  except OSError as e:
    if e.errno == 17: # File Exists
      time.sleep(0.1)
      return mkdir(path)
    else:
      raise

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


def find_closest_divisor(to_divide, closest_to):
  """
  This is used to find the right chunk size for
  importing a neuroglancer dataset that has a
  chunk import size that's not evenly divisible by
  64,64,64. 

  e.g. 
    neuroglancer_chunk_size = find_closest_divisor(build_chunk_size, closest_to=[64,64,64])

  Required:
    to_divide: (tuple) x,y,z chunk size to rechunk
    closest_to: (tuple) x,y,z ideal chunk size

  Return: [x,y,z] chunk size that works for ingestion
  """
  def find_closest(td, ct):
    min_distance = td
    best = td
    
    for divisor in divisors(td):
      if abs(divisor - ct) < min_distance:
        min_distance = abs(divisor - ct)
        best = divisor
    return best
  
  return [ find_closest(td, ct) for td, ct in zip(to_divide, closest_to) ]

def divisors(n):
  """Generate the divisors of n"""
  for i in xrange(1, int(math.sqrt(n) + 1)):
    if n % i == 0:
      yield i
      if i*i != n:
        yield n / i

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

def gcloudFileIterator(cloudpaths, keep_files=None, use_ls=False, compress=False):
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
    print("Downloading directory listing. If this is not desired, set use_ls=False.")
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

  gsutil_upload_cmd = "gsutil {multiprocessing} {quiet} cp {logging} -c -I {destination}".format(
    logging=('-L {}'.format(log) if log is not None else ''),
    destination=destination,
    multiprocessing=('-m' if not CLOUD_COMPUTING else ''),
    quiet=('-q' if CLOUD_COMPUTING else ''),
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
    paths = [ path for path in paths if not path.endswith('.gz') ]
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

  multiprocessing = '-m' if not CLOUD_COMPUTING else ''

  gsutil_upload_cmd = "gsutil {multiprocessing} {quiet} {headers} cp -c -I {compress} {public} gs://{cloudpath}/".format(
    headers=" ".join(headers),
    compress=('-Z' if compress else ''),
    public=('-a public-read' if public else ''),
    cloudpath=cloudpath,
    multiprocessing=multiprocessing,
    quiet=('-q' if CLOUD_COMPUTING else ''),
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
  assert len(a) == len(b), "Vector lengths do not match: {} (len {}), {} (len {})".format(a[:3], len(a), b[:3], len(b))

  result = np.empty(len(a))

  for i in xrange(len(result)):
    result[i] = fn(a[i], b[i])

  if isinstance(a, Vec) or isinstance(b, Vec):
    return Vec(*result)

  return result

def max2(a, b):
  return map2(max, a, b).astype(a.dtype)

def min2(a, b):
  return map2(min, a, b).astype(a.dtype)

def clamp(val, low, high):
  return min(max(val, low), high)

def eclamp(val, low, high):
  if val > high or val < low:
    raise ValueError('Value {} cannot be outside of inclusive range {} to {}'.format(val,low,high))
  return val

class Vec(np.ndarray):
    def __new__(cls, *args, **kwargs):
      dtype = kwargs['dtype'] if 'dtype' in kwargs else int
      return super(Vec, cls).__new__(cls, shape=(len(args),), buffer=np.array(args).astype(dtype), dtype=dtype)

    @classmethod
    def clamp(cls, val, minvec, maxvec):
      return Vec(*min2(max2(val, minvec), maxvec))

    def clone(self):
      return Vec(*self[:], dtype=self.dtype)

    def null(self):
        return self.length() <= 10 * np.finfo(np.float32).eps

    def dot(self, vec):
      return sum(self * vec)

    def length2(self):
        return self.dot(self)

    def length(self):
        return math.sqrt(self.dot(self))

    def rectVolume(self):
        return reduce(operator.mul, self)

    def __hash__(self):
      return int(''.join(map(str, self)))

    def __repr__(self):
      values = u",".join(self.astype(unicode))
      return u"Vec({}, dtype={})".format(values, self.dtype)

def __assign(self, val, index):
  self[index] = val

Vec.x = property(lambda self: self[0], lambda self,val: __assign(self,val,0))
Vec.y = property(lambda self: self[1], lambda self,val: __assign(self,val,1))
Vec.z = property(lambda self: self[2], lambda self,val: __assign(self,val,2))
Vec.w = property(lambda self: self[3], lambda self,val: __assign(self,val,3))

Vec.r = Vec.x
Vec.g = Vec.y
Vec.b = Vec.z
Vec.a = Vec.w

class Vec3(Vec):
    def __new__(cls, x, y, z, dtype=int):
      return super(Vec, cls).__new__(cls, shape=(3,), buffer=np.array([x,y,z]).astype(dtype), dtype=dtype)

    @classmethod
    def triple(cls, x):
      return Vec3(x,x,x)

    def __repr__(self):
        return "Vec3({},{},{}, dtype={})".format(self.x, self.y, self.z, self.dtype)

class Bbox(object):
  """Represents a three dimensional cuboid in space."""
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
    match = re.search(r'(\d+)-(\d+)_(\d+)-(\d+)_(\d+)-(\d+)(?:\.gz)?$', os.path.basename(filename))

    (xmin, xmax,
     ymin, ymax,
     zmin, zmax) = map(int, match.groups())

    return Bbox( (xmin, ymin, zmin), (xmax, ymax, zmax) )

  @classmethod
  def from_slices(cls, slices3):
    return Bbox(
      (slices3[0].start, slices3[1].start, slices3[2].start), 
      (slices3[0].stop, slices3[1].stop, slices3[2].stop) 
    )

  @classmethod
  def from_list(cls, lst):
    return Bbox( lst[:3], lst[3:6] )

  def to_filename(self):
    return '{}-{}_{}-{}_{}-{}'.format(
      self.minpt.x, self.maxpt.x,
      self.minpt.y, self.maxpt.y,
      self.minpt.z, self.maxpt.z,
    )

  def to_slices(self):
    return (
      slice(int(self.minpt.x), int(self.maxpt.x)),
      slice(int(self.minpt.y), int(self.maxpt.y)),
      slice(int(self.minpt.z), int(self.maxpt.z))
    )

  def to_list(self):
    return list(self.minpt) + list(self.maxpt)

  @classmethod
  def expand(cls, *args):
    result = args[0].clone()
    for bbx in args:
      result.minpt = min2(result.minpt, bbx.minpt)
      result.maxpt = max2(result.maxpt, bbx.maxpt)
    return result

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

  def expand_to_chunk_size(self, chunk_size, offset=Vec(0,0,0, dtype=int)):
    """
    Align a potentially non-axis aligned bbox to the grid by growing it
    to the nearest grid lines.

    Required:
      chunk_size: arraylike (x,y,z), the size of chunks in the 
                    dataset e.g. (64,64,64)
    Optional:
      offset: arraylike (x,y,z), the starting coordinate of the dataset
    """
    chunk_size = np.array(chunk_size, dtype=np.float32)
    result = self.clone()
    result = result - offset
    result.minpt = np.floor(result.minpt / chunk_size) * chunk_size
    result.maxpt = np.ceil(result.maxpt / chunk_size) * chunk_size 
    return result + offset

  def shrink_to_chunk_size(self, chunk_size, offset=Vec(0,0,0, dtype=int)):
    """
    Align a potentially non-axis aligned bbox to the grid by shrinking it
    to the nearest grid lines.

    Required:
      chunk_size: arraylike (x,y,z), the size of chunks in the 
                    dataset e.g. (64,64,64)
    Optional:
      offset: arraylike (x,y,z), the starting coordinate of the dataset
    """
    chunk_size = np.array(chunk_size, dtype=np.float32)
    result = self.clone()
    result = result - offset
    result.minpt = np.ceil(result.minpt / chunk_size) * chunk_size
    result.maxpt = np.floor(result.maxpt / chunk_size) * chunk_size 
    return result + offset

  def round_to_chunk_size(self, chunk_size, offset=Vec(0,0,0, dtype=int)):
    """
    Align a potentially non-axis aligned bbox to the grid by rounding it
    to the nearest grid lines.

    Required:
      chunk_size: arraylike (x,y,z), the size of chunks in the 
                    dataset e.g. (64,64,64)
    Optional:
      offset: arraylike (x,y,z), the starting coordinate of the dataset
    """
    chunk_size = np.array(chunk_size, dtype=np.float32)
    result = self.clone()
    result = result - offset
    result.minpt = np.round(result.minpt / chunk_size) * chunk_size
    result.maxpt = np.round(result.maxpt / chunk_size) * chunk_size
    return result + offset

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

  def astype(self, dtype):
    result = self.clone()
    result.minpt = self.minpt.astype(dtype)
    result.maxpt = self.maxpt.astype(dtype)
    return result

  def transpose(self):
    return Bbox(self.minpt[::-1], self.maxpt[::-1])

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

  def __ne__(self, other):
    return not (self == other)

  def __eq__(self, other):
    return np.array_equal(self.minpt, other.minpt) and np.array_equal(self.maxpt, other.maxpt)

  def __hash__(self):
    return int(''.join(self.to_list()))

  def __repr__(self):
    return "Bbox({},{})".format(self.minpt, self.maxpt)


BUCKETS = {}

def credentials_path():
    self_dir = os.path.dirname(os.path.realpath(__file__))
    return os.path.join(self_dir, 'client-secret.json')

def get_bucket(bucket_name=GCLOUD_BUCKET_NAME, use_secrets=False):
  global BUCKETS
  if bucket_name in BUCKETS:
    return BUCKETS[bucket_name]

  if use_secrets:
    client = storage.Client.from_service_account_json(
      credentials_path(), project=GCLOUD_PROJECT_NAME
    )
  else:
    client = storage.Client(project=GCLOUD_PROJECT_NAME)
    
  BUCKETS[bucket_name] = client.get_bucket(bucket_name)
  return BUCKETS[bucket_name]

def get_blob(name, bucket_name=GCLOUD_BUCKET_NAME, use_secrets=False):
    bucket = get_bucket(bucket_name=bucket_name, use_secrets=use_secrets)
    return bucket.get_blob(name)

def set_blob(name, value, mime_type=None, bucket_name=GCLOUD_BUCKET_NAME, use_secrets=False):
    bucket = get_bucket(bucket_name=bucket_name, use_secrets=use_secrets)
    blob = bucket.blob(name)
    blob.upload_from_string(value, mime_type)

class Storage(object):

    def __init__(self, dataset_name='', layer_name='', compress=True, public=False):
        self._dataset_name = dataset_name
        self._layer_name = layer_name
        self._compress = compress
        self._public = public
       
        self._local = None
        self._n_objects = 0
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
