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
	def __init__(self, patch_size, coverage, coverage_crop):

		self.summaries = []
		self.patch_size = patch_size
		self.padded_patch_size = (1,) + patch_size + (1,)
		self.coverage=coverage


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

		with tf.name_scope('iteration'):
			self.coverage_mask = np.zeros(self.padded_patch_size, dtype=np.int32)
			self.coverage_mask[:,
					int(self.padded_patch_size[1]*coverage_crop):(self.padded_patch_size[1] - int(self.padded_patch_size[1]*coverage_crop)),
					int(self.padded_patch_size[2]*coverage_crop):(self.padded_patch_size[2] - int(self.padded_patch_size[2]*coverage_crop)),
					int(self.padded_patch_size[3]*coverage_crop):(self.padded_patch_size[3] - int(self.padded_patch_size[3]*coverage_crop)),
					:]=1

			self.mask = tf.placeholder(dtype=tf.float32, shape=self.padded_patch_size)
			self.image = tf.placeholder(dtype=tf.float32, shape = self.padded_patch_size)

			discrim_tower = self.discrim(tf.concat([self.mask,self.image],4))
			i=4
			ds_shape = static_shape(discrim_tower[i])
			print(ds_shape)
			expander = compose(*reversed(discrim_net3.range_expanders[0:i]))
			self.otpt = upsample_max(tf.nn.sigmoid(discrim_tower[i]), self.padded_patch_size, expander) * self.mask
			self.cropped_otpt = self.otpt * self.coverage_mask
			
		var_list = tf.get_collection(
			tf.GraphKeys.TRAINABLE_VARIABLES, scope='params')

		self.sess.run(tf.variables_initializer(tf.get_collection(tf.GraphKeys.GLOBAL_VARIABLES,scope='iteration')))

		self.saver = tf.train.Saver(var_list=var_list)
	
	def test(self, image, mask):
		image = dataset.prep("image",image)
		mask = dataset.prep("image",mask)
		ret = self.sess.run(self.otpt, feed_dict={self.image: image, self.mask: mask})
		return ret

	def inference(self, image, machine_labels, sample_generator, ret=None, visited=None, profile=False):
		machine_labels = np.squeeze(machine_labels)
		image = np.squeeze(image)
		if ret is None:
			ret = np.zeros_like(machine_labels, dtype=np.float32)
		if visited is None:
			visited = np.zeros_like(machine_labels, dtype=np.uint8)
		if type(sample_generator) == np.ndarray:
			sample_generator = random_sample_generator(sample_generator)

		machine_labels = NpVolume(machine_labels, self.patch_size)
		image = NpVolume(image, self.patch_size)
		ret = NpVolume(ret, self.patch_size)
		visited = NpVolume(visited, self.patch_size)

		counter=0
		for i,sample in enumerate(sample_generator):
			t = time.time()
			print(str(counter) + "-" + str(i))
			if visited.A[tuple(sample)] < self.coverage:
				mask = np.equal(machine_labels[sample],machine_labels.A[tuple(sample)]).astype(np.int32)
				ret[sample]=np.maximum(ret[sample],np.squeeze(self.test(image[sample], mask) * self.coverage_mask))
				visited[sample] = np.minimum(self.coverage, visited[sample] + mask * np.squeeze(self.coverage_mask))
				counter += 1
			elapsed = time.time() - t
			print("elapsed: ", elapsed)

		return np.reshape(ret.A,[1]+list(ret.A.shape)+[1])

	def get_filename(self):
		return os.path.splitext(os.path.basename(__file__))[0]

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
with tf.device("/gpu:0"):
	main_model = DiscrimModel(**args)
print("model initialized")
if __name__ == '__main__':
	TRAIN = MultiDataset(
			[
				os.path.expanduser("~/mydatasets/3_3_1_test/"),
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
