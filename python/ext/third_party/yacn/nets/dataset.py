import h5py
import numpy as np
import random
import itertools
#import dataprep
from collections import defaultdict
from multiprocessing import Process, Queue
import os
import random


def h5read(filename):
	print "reading from", filename, "..."
	f = h5py.File(filename, "r")
	tmp = f["main"][()]
	f.close()
	print "done"
	return tmp


def h5write(filename, x):
	f = h5py.File(filename, "w")
	dset = f.create_dataset("main", data=x)
	f.close()

class Dataset():
	def __init__(self, directory,d):
		self.directory=directory
		for (k,v) in d.items():
			setattr(self, k, prep(k,h5read(os.path.join(directory, v))))

class MultiDataset():
	def __init__(self, directories, d):
		self.n = len(directories)
		self.directories=directories
		for (k,v) in d.items():
			setattr(self,k,[prep(k,h5read(os.path.join(directory, v))) for directory in directories])

def prep(typ,data):
	if typ in ["image", "errors"]:
		tmp=autopad(data.astype(np.float32))
		if tmp.max() > 10:
			#print "dividing by 256"
			return tmp/256
		else:
			return tmp
	elif typ in ["human_labels", "machine_labels", "labels"]:
		return autopad(data.astype(np.int32))
	elif typ in ["labels64"]:
		return autopad(data.astype(np.int64))
	elif typ in ["valid"]:
		return data.astype(np.int32)
	elif typ in ["samples"]:
		return data.astype(np.int32)
	elif typ in ["visited"]:
		return autopad(data.astype(np.int16))

def autopad(A):
	if len(A.shape)==3:
		return np.reshape(A,(1,)+A.shape+(1,))
	elif len(A.shape)==4:
		return np.reshape(A,(1,)+A.shape)
	elif len(A.shape)==5:
		return A
	else:
		raise Exception("Can't autopad")
		

def alternating_iterator(its, counts, label=False):
	while True:
		for k,(it, count) in enumerate(zip(its, counts)):
			for i in xrange(count):
				if label:
					yield (k,it.next())
				else:
					yield it.next()
