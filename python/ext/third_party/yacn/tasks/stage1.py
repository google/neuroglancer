from neuroglancer.ingest.volumes.precomputed import Precomputed
from neuroglancer.ingest.storage import Storage
import boto
from boto.s3.key import Key
import uuid
import os
import h5py
import numpy as np
from subprocess import call

WORKDIR = "/tmp/stage1_" + uuid.uuid4().hex
os.makedirs(WORKDIR)

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
		'watershed': "s3://neuroglancer/pinky40_v3/watershed",
		'mean_affinity': "s3://neuroglancer/pinky40_v3/watershed",
		'affinities': "s3://neuroglancer/pinky40_v3/affinitymap-jnet-fix",
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

		storage = Storage(task['watershed'])
		pr=Precomputed(storage)
		h5write(os.path.join(WORKDIR, "raw.h5"), np.squeeze(pr[slices]).transpose().astype(np.int32))
		
		#storage = Storage(task['affinities'])
		#pr=Precomputed(storage)
		#h5write(os.path.join(WORKDIR, "aff.h5"), pr[slices])
		h5write(os.path.join(WORKDIR, "aff.h5"), np.zeros((map(lambda x: x.stop - x.start, slices)+[3,]),dtype=np.float32))

		storage = Storage(task['mean_affinity'])
		pr=Precomputed(storage)
		h5write(os.path.join(WORKDIR, "mean_agg_tr.h5"), np.squeeze(pr[slices]).transpose().astype(np.int32))

		call(["julia", "/usr/people/jzung/yacn/pre/full_prep_script.jl", WORKDIR])

		k.key = 'jzung/test/samples/' + task['chunk'] + ".h5"
		k.set_contents_from_filename(os.path.join(WORKDIR, "samples.h5"))

		k.key = 'jzung/test/mean_edges/' + task['chunk'] + ".h5"
		k.set_contents_from_filename(os.path.join(WORKDIR, "mean_edges.h5"))

		k.key = 'jzung/test/contact_edges/' + task['chunk'] + ".h5"
		k.set_contents_from_filename(os.path.join(WORKDIR, "contact_edges.h5"))

		print("processed task")
	except NoTasksException as e:
		print("No more tasks")
		break
