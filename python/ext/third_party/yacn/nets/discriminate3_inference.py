from __future__ import print_function
import numpy as np
import os
from datetime import datetime
import math
import itertools
import pprint
from convkernels3d import *
from activations import *
from loss_functions import *
import discrim_net3
import os
from datetime import datetime
from experiments import save_experiment, repo_root
import random

import tensorflow as tf
from tensorflow.python.client import timeline

from utils import *
from dataset import MultiDataset
import dataset
#import pythonzenity

class DiscrimModel(Model):
	def __init__(self, patch_size, coverage, coverage_crop
				 ):

		self.summaries = []
		self.patch_size = patch_size
		self.padded_patch_size = (1,) + patch_size + (1,)
		self.coverage = coverage
		self.coverage_crop = coverage_crop

		patchx,patchy,patchz = patch_size

		config = tf.ConfigProto(
			allow_soft_placement=True,
			gpu_options=tf.GPUOptions(per_process_gpu_memory_fraction=0.5, allow_growth=True),
			#log_device_placement=True,
		)
		self.sess = tf.Session(config=config)
		self.run_metadata = tf.RunMetadata()

		with tf.name_scope('params'):
			self.step=tf.Variable(0)
			discrim, reconstruct = discrim_net3.make_forward_net(patch_size,2,1)
			self.discrim = discrim

		#for some reason we need to initialize here first... Figure this out!
		init = tf.global_variables_initializer()
		self.sess.run(init)

		self.ret_placeholder=tf.placeholder(dtype=tf.float32)
		self.machine_labels_placeholder=tf.placeholder(dtype=tf.int32)
		self.image_placeholder=tf.placeholder(dtype=tf.float32)
		self.visited_placeholder=tf.placeholder(dtype=tf.int16)
	
		self.ret = tf.Variable(self.ret_placeholder, validate_shape=False)
		self.visited = tf.Variable(self.visited_placeholder, validate_shape=False)
		self.machine_labels = tf.Variable(self.machine_labels_placeholder, validate_shape=False)
		self.image = tf.Variable(self.image_placeholder, validate_shape=False)

		ret_vol = Volume(self.ret, self.padded_patch_size)
		visited_vol = Volume(self.visited, self.padded_patch_size)
		machine_labels_vol = Volume(self.machine_labels, self.padded_patch_size)
		image_vol = Volume(self.image, self.padded_patch_size)

		self.focus_inpt = tf.placeholder(shape=(3,),dtype=tf.int32)
		focus=tf.concat([[0],self.focus_inpt,[0]],0)


		with tf.name_scope('iteration'):
			machine_labels_glimpse = equal_to_centre(machine_labels_vol[focus])
			image_glimpse = image_vol[focus]
			coverage_mask = np.zeros(self.padded_patch_size, dtype=np.float32)
			coverage_mask[:,
					int(self.padded_patch_size[1]*coverage_crop):(self.padded_patch_size[1] - int(self.padded_patch_size[1]*coverage_crop)),
					int(self.padded_patch_size[2]*coverage_crop):(self.padded_patch_size[2] - int(self.padded_patch_size[2]*coverage_crop)),
					int(self.padded_patch_size[3]*coverage_crop):(self.padded_patch_size[3] - int(self.padded_patch_size[3]*coverage_crop)),
					:]=1
			with tf.device("/gpu:0"):
				discrim_tower = self.discrim(tf.concat([machine_labels_glimpse,image_glimpse],4))
				i=4
				ds_shape = static_shape(discrim_tower[i])
				print(ds_shape)
				expander = compose(*reversed(discrim_net3.range_expanders[0:i]))
				otpt = upsample_max(tf.nn.sigmoid(discrim_tower[i]), self.padded_patch_size, expander)
			
			with tf.control_dependencies([
					ret_vol.__setitem__(focus,tf.maximum(coverage_mask * otpt * machine_labels_glimpse,ret_vol[focus])), 
					visited_vol.__setitem__(focus,tf.add(tf.cast(coverage_mask * machine_labels_glimpse, tf.int16), visited_vol[focus]))
					]):
				self.it = tf.no_op()

			self.check = self.visited[focus[0],focus[1],focus[2],focus[3],focus[4]]

		self.full_array_initializer = tf.variables_initializer([self.ret,self.visited,self.machine_labels,self.image])

		full_size = self.padded_patch_size
		self.sess.run(self.full_array_initializer, feed_dict={
			self.machine_labels_placeholder: np.zeros(full_size, dtype=np.int32), 
			self.image_placeholder: np.zeros(full_size, dtype=np.float32), 
			self.ret_placeholder: np.zeros(full_size,dtype=np.float32), 
			self.visited_placeholder: np.zeros(full_size,dtype=np.int16)})


		var_list = tf.get_collection(
			tf.GraphKeys.TRAINABLE_VARIABLES, scope='params')

		self.sess.run(tf.variables_initializer(tf.get_collection(tf.GraphKeys.GLOBAL_VARIABLES,scope='iteration')),feed_dict={self.focus_inpt:[0,0,0]})

		self.saver = tf.train.Saver(var_list=var_list)
	
	#plan: assign to each object the magnitude of the max value of the error detector in the window.
	#vol should be machine_labels of size [1,X,Y,Z,1]
	def inference(self, image, machine_labels, sample_generator, ret=None, visited=None, profile=False):
		if ret is None:
			ret = np.zeros_like(machine_labels, dtype=np.float32)
		if visited is None:
			visited = np.zeros_like(machine_labels, dtype=np.int32)
		if type(sample_generator) == np.ndarray:
			sample_generator = random_sample_generator(sample_generator)
		machine_labels = dataset.prep("labels", machine_labels)
		image = dataset.prep("image", image)
		ret = dataset.prep("errors", ret)
		visited = dataset.prep("visited", visited)

		self.sess.run(self.full_array_initializer, feed_dict={
			self.machine_labels_placeholder: machine_labels, 
			self.image_placeholder: image,
			self.ret_placeholder: ret, 
			self.visited_placeholder: visited})
		
		counter=0
		for i,sample in enumerate(sample_generator):
			t = time.time()
			print(str(counter) + "-" + str(i))
			if self.sess.run(self.check, feed_dict={self.focus_inpt: sample}) < self.coverage:
				self.sess.run(self.it, feed_dict={self.focus_inpt: sample})
				counter += 1
			if i == 10 and profile:
				run_metadata = tf.RunMetadata()
				_ =  self.sess.run(self.it, options=tf.RunOptions(trace_level=tf.RunOptions.FULL_TRACE), run_metadata=run_metadata, feed_dict={self.focus_inpt:sample})
				trace = timeline.Timeline(step_stats=run_metadata.step_stats)
				trace_file = open('timeline.ctf.json', 'w')
				trace_file.write(trace.generate_chrome_trace_format())
				trace_file.flush()
				trace_file.close()
			elapsed = time.time() - t
			print("elapsed: ", elapsed)

		return self.sess.run(self.ret)

#samples should be a (N,3) array
def random_sample_generator(samples,k=None):
	N=samples.shape[0]
	if k is None:
		k=N
	for i in random.sample(range(N),k):
		yield samples[i,:]

args = {
	"patch_size": tuple(discrim_net3.patch_size_suggestions([2,3,3])[0]),
	"coverage": 2,
	"coverage_crop": 0.125,
}

#pp = pprint.PrettyPrinter(indent=4)
#pp.pprint(args)
with tf.device("/cpu:0"):
	main_model = DiscrimModel(**args)

if __name__ == '__main__':
	TRAIN = MultiDataset(
			[
				os.path.expanduser("~/mydatasets/3_3_1/"),
				#os.path.expanduser("~/mydatasets/golden/"),
				#os.path.expanduser("~/mydatasets/golden_test/"),
			],
			{
				"machine_labels": "mean_agg_tr.h5",
				"samples": "samples.h5",
				"image": "image.h5",
			}
	)
	main_model.restore("~/experiments/discriminate3/latest.ckpt")

	dataset.h5write(os.path.join(TRAIN.directories[0], "errors.h5"), 
			np.squeeze(
				main_model.inference(
					TRAIN.image[0], TRAIN.machine_labels[0],
					sample_generator = random_sample_generator(TRAIN.samples[0])),
				axis=(0,4)))
