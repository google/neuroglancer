from neuroglancer.ingest.volumes.precomputed import Precomputed
from neuroglancer.ingest.storage import Storage
import boto
from boto.s3.key import Key
import uuid
import os
import h5py
import numpy as np
from subprocess import call


os.environ["CUDA_VISIBLE_DEVICES"]="0"
import sys
sys.path.insert(0, os.path.expanduser("~/yacn/nets"))
import discriminate3_inference
discriminate3_inference.__init__([1,128,512,512,1],checkpoint="~/experiments/discriminate3/latest.ckpt")


WORKDIR = "/tmp/stage2_" + uuid.uuid4().hex
os.makedirs(WORKDIR)

files=[]
def h5read(filename, force=False):
	try:
		if force:
			with h5py.File(filename,'r') as f:
				return f['main'][:]
		else:
			f=h5py.File(filename,'r')
			global files
			files.append(f)
			return f['main']
	except IOError:
		print(filename+' not found')

def h5write(filename, x):
	f = h5py.File(filename, "w")
	dset = f.create_dataset("main", data=x)
	f.close()

conn = boto.connect_s3()
b = conn.get_bucket('seunglab')
k = Key(b)
k.key = 'jzung/test'

task = {
		'chunk': '36352-36864_37376-37888_64-192',
		'image': "s3://neuroglancer/pinky40_v3/image",
		'seg': "s3://neuroglancer/pinky40_v3/watershed",
		'samples': "s3://seunglab/jzung/test/samples",

		'errors': "s3://seung/lab/jzung/test/errors",
		}

tasks = [task]

def parse_ranges(s):
	return map(lambda x: slice(*map(int, x.split("-"))), s.split("_"))

class NoTasksException(Exception):
	pass

def get_task():
	if len(tasks) > 0:
		return tasks.pop()
	else:
		raise NoTasksException()

while True:
	try:
		task = get_task()
		slices = parse_ranges(task['chunk'])

		storage = Storage(task['seg'])
		pr=Precomputed(storage)
		seg = np.squeeze(pr[slices]).transpose().astype(np.int32)
		
		#storage = Storage(task['image'])
		#pr=Precomputed(storage)
		#image = np.squeeze(pr[slices]).transpose().astype(np.int32)
		image = np.zeros_like(seg, dtype=np.uint8)

		storage = Storage(task['samples'])
		with open(os.path.join(WORKDIR, "samples.h5"),'w') as f:
			f.write(storage.get_file(task['chunk']+".h5"))
			f.close()
		samples = h5read(os.path.join(WORKDIR, "samples.h5"))

		np.squeeze(discriminate3_inference.main_model.inference(image, seg, samples))

		print("processed task")
	except NoTasksException as e:
		print("No more tasks")
		break
