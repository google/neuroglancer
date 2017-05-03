import numpy as np
import sys
import os
import os.path
import h5py
import numpy as np
from multiprocessing import Process, Queue
import misc_utils
import uuid
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'

class FileArray(object):
	def __init__(self, A):
		self.filename = "/tmp_ram/" + str(uuid.uuid4().hex) + ".h5"
		misc_utils.h5write(self.filename, A)
	
	def get(self):
		print("reading from " + self.filename)
		tmp = misc_utils.h5read(self.filename,force=True)
		os.remove(self.filename)
		return tmp
def unpack(A):
	if type(A) == FileArray:
		return A.get()
	else:
		return A
def pack(A):
	if type(A) == np.ndarray:
		return FileArray(A)
	else:
		return A

def run_trace(q1,q2,device):
	import os
	os.environ["CUDA_VISIBLE_DEVICES"]=device

	#import yacn.nets.sparse_vector_labels_inference as sparse_vector_labels_inference
	from ..nets import sparse_vector_labels_inference
	sparse_vector_labels_inference.main_model.restore("~/experiments/sparse_vector_labels/latest.ckpt")
	while True:
		try:
			image, mask,central = q1.get()
			X,Y,Z=np.shape(image)
			q2.put(np.reshape(sparse_vector_labels_inference.main_model.test(image, mask, central),[X,Y,Z]))
		except Exception as e:
			print(e)

def run_discrim_online(q1,q2,device):
	import os
	os.environ["CUDA_VISIBLE_DEVICES"]=device

	#import yacn.nets.discriminate3_online_inference as discriminate3_online_inference
	from ..nets import discriminate3_online_inference
	discriminate3_online_inference.main_model.restore("~/experiments/discriminate3/latest.ckpt")
	while True:
		try:
			image, mask = q1.get()
			X,Y,Z=np.shape(image)
			q2.put(np.reshape(discriminate3_online_inference.main_model.test(image, mask),[X,Y,Z]))
		except Exception as e:
			print(e)


def run_recompute_discrim(q1,q2,device):
	import os
	os.environ["CUDA_VISIBLE_DEVICES"]=device
	#import yacn.nets.discriminate3_online_inference as inference
	from ..nets import discriminate3_online_inference as inference
	inference.main_model.restore("~/experiments/discriminate3/latest.ckpt")
	while True:
		try:
			image, seg, samples, err, visited = map(unpack,q1.get())
			X,Y,Z=np.shape(seg)
			q2.put(pack(np.reshape(inference.main_model.inference(image,seg,samples, visited=visited,ret=err), [X,Y,Z])))
		except Exception as e:
			print(e)

class ComputeDaemon():
	def __init__(self,f,device):
		self.q1 = Queue()
		self.q2 = Queue()
		self.p = Process(target=f, args=(self.q1,self.q2,device))
		self.p.daemon=True
		self.p.start()
	def __call__(self, *args):
		self.q1.put(args)
		return self.q2.get()
import string
if 'CUDA_VISIBLE_DEVICES' not in os.environ:
	os.environ['CUDA_VISIBLE_DEVICES'] = ""
devices = string.split(os.environ['CUDA_VISIBLE_DEVICES'],",")+[""]*10
discrim_online_daemon = ComputeDaemon(run_discrim_online,devices[0])
trace_daemon = ComputeDaemon(run_trace,devices[0])
discrim_daemon = ComputeDaemon(run_recompute_discrim,devices[0])
