import os
import re 
import sys
import subprocess

GCLOUD_PROJECT = 'neuromancer-seung-import'
COMMON_STAGING_DIR = './staging/'

def mkdir(path):
  if not os.path.exists(path):
      os.makedirs(path)

  return path

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

def upload_to_gcloud(filenames, cloudpath, headers={}, compress=False):
  
  mkheader = lambda header, content: "-h '{}:{}'".format(header, content)
  headers = [ mkheader(key, content) for key, content in headers.iteritems() if content != '' ]

  # gsutil chokes when you ask it to upload more than about 1500 files at once
  # so we're using streaming mode (-I) to enable it to handle arbitrary numbers of files
  # -m = multithreaded upload, -h = headers

  gsutil_upload_cmd = "gsutil -m {headers} cp -I {compress} -a public-read gs://{cloudpath}".format(
    headers=" ".join(headers),
    compress=('-Z' if compress else ''),
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

def upload_folder_to_gcloud(self, directory, key, compress=True, cache_control=None, content_type=None):
    def mkheader(header, content):
        if content is not None:
          return "-h '{}:{}'".format(header, content)
        return None

    headers = [
    mkheader('Content-Type', content_type),
    mkheader('Cache-Control', cache_control)
    ]

    headers = [ x for x in headers if x is not None ]

    print("Uploading " + directory)
    gsutil_upload_command = "gsutil {headers} -m cp {compress} -a public-read {local_dir} gs://{bucket}/{dataset}/{layer}/{key}/".format(
      headers=" ".join(headers),
      compress=('-Z' if compress else ''),
      local_dir=os.path.join(directory, '*'),
      bucket=BUCKET_NAME,
      dataset=self._dataset_name,
      layer=self._layer_name,
      key=key
    )
    print(gsutil_upload_command)
    subprocess.check_call(gsutil_upload_command, shell=True)

    shutil.rmtree(directory)
    os.mkdir(directory)