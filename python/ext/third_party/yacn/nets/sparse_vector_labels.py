#Let's change the loss function to only care about reconstructing the objects which pass through the centre of the volume. It's okay to reconstruct objects that don't touch the centre, but we need to be sure that we reconstruct those that are in the centre. In fact, we'll usually only care about the reconstruction of a particular object near the centre.

from __future__ import print_function
import os
os.environ['TF_CUDA_HOST_MEM_LIMIT_IN_MB'] = '200000'
import numpy as np
from datetime import datetime
import time
import math
import itertools
import threading
import pprint
from convkernels3d import *
from activations import *
import basic_net2
import gc

import tensorflow as tf
from tensorflow.python.client import timeline

from utils import *
from loss_functions import *
import dataset
import augment


class VectorLabelModel(Model):

	def __init__(self, patch_size, offsets, dataset,
				 nvec_labels, maxn,
				 devices, train_vols, test_vols, name=None):

		self.name=name
		self.summaries = []
		self.devices = devices
		self.patch_size = patch_size
		self.aug_patch_size = (patch_size[0],patch_size[1]+40, patch_size[2]+40)
		self.padded_patch_size = (1,) + patch_size + (1,)
		self.padded_aug_patch_size = (1,) + self.aug_patch_size + (1,)
		self.offsets = offsets
		self.maxn = maxn
		self.nvec_labels = nvec_labels

		config = tf.ConfigProto(
			#gpu_options = tf.GPUOptions(allow_growth=True),
			allow_soft_placement=True,
			#log_device_placement=True,
			#gpu_options=tf.GPUOptions(per_process_gpu_memory_fraction=0.9),
		)
		#config.graph_options.optimizer_options.global_jit_level = tf.OptimizerOptions.ON_1
		self.sess = tf.Session(config=config)
		self.run_metadata = tf.RunMetadata()

		def scv(sess,x):
			placeholder = tf.placeholder(tf.as_dtype(x.dtype), shape=x.shape)
			fd={}
			fd[placeholder]=x
			v=tf.Variable(placeholder,name="scv")
			sess.run(tf.variables_initializer([v]),feed_dict=fd)
			return v
		
		with tf.device("/cpu:0"):
			n_volumes = len(dataset.image)
			full_human_labels = static_constant_multivolume(self.sess, dataset.human_labels, self.padded_aug_patch_size)
			full_machine_labels = static_constant_multivolume(self.sess, dataset.machine_labels, self.padded_aug_patch_size)
			full_image = static_constant_multivolume(self.sess, dataset.image, self.padded_aug_patch_size)
			samples = static_constant_multivolume(self.sess, dataset.samples, (1,3), indexing='CORNER')
			valid = MultiTensor([scv(self.sess,i) for i in dataset.valid])

		with tf.name_scope('params'):
			self.step = tf.Variable(0)
			forward = basic_net2.make_forward_net(patch_size, 2, nvec_labels)

		params_var_list = tf.get_collection(
			tf.GraphKeys.TRAINABLE_VARIABLES, scope='params')

		self.iteration_type=tf.placeholder(tf.int64, shape=())

		iteration_type = self.iteration_type

		with tf.name_scope('optimize'):
			loss = 0
			for i,d in enumerate(devices):
				with tf.device(d):
					vol_id = tf.cond(tf.equal(self.iteration_type,0),
							lambda: random_sample(tf.constant(train_vols)),
							lambda: random_sample(tf.constant(test_vols)),
							)

					focus = tf.concat([[0],tf.reshape(samples[vol_id,('RAND',0)],(3,)),[0]],0)
					myvalid = valid[vol_id]
					maxlabel = tf.shape(myvalid)[0]

					image = full_image[vol_id, focus]
					human_labels = full_human_labels[vol_id,focus]
					central_label = extract_central(human_labels)

					aug_image, aug_label = augment.default_augmentation()
					image = aug_image(image)
					human_labels = aug_label(human_labels)

					is_valid = tf.to_float(myvalid[tf.reshape(central_label,[])])
					#is_valid = tf.Print(is_valid,[is_valid], message="is_valid")
					central_label_set = tf.scatter_nd(tf.reshape(central_label,[1,1]), [1], [maxlabel])

					#0 means that this label is removed
					#ensure that the central object is not masked, and also ensure that only valid objects are masked.
					error_probability = tf.random_uniform([],minval=0.0,maxval=0.75,dtype=tf.float32)
					masked_label_set = tf.maximum(tf.to_int32(rand_bool([maxlabel],error_probability)), central_label_set)
					#masked_label_set = tf.maximum(masked_label_set, 1-myvalid)

					#ensure that zero is masked out
					#masked_label_set = tf.minimum(masked_label_set, tf.concat(tf.zeros((1,),dtype=tf.int32),tf.ones((maxlabel-1,),dtype=tf.int32)))
					masked_label_set = tf.concat([tf.zeros([1],dtype=tf.int32),masked_label_set[1:]],0)
					mask = tf.to_float(tf.gather(masked_label_set, human_labels))
					central = tf.to_float(tf.gather(central_label_set, human_labels))
				with tf.device(d):
					vector_labels = forward(tf.concat([image,mask],4))
					
					central_vector = tf.reduce_sum(central * vector_labels, reduction_indices = [1,2,3], keep_dims=True)/ tf.reduce_sum(central, keep_dims=False) 

					with tf.name_scope("loss"):
						loss1=0
						loss2=0
						loss3=0
						#loss1, prediction = label_loss_fun(vector_labels, human_labels, central_labels, central)
						#loss2, long_range_affinities = long_range_loss_fun(vector_labels, human_labels, offsets, mask)
						guess = affinity(central_vector,vector_labels)
						truth = label_diff(human_labels, central_label)
						loss3 = tf.reduce_sum(bounded_cross_entropy(guess,truth)) * is_valid
						loss += loss1 + loss2 + loss3

			def training_iteration():
				optimizer = tf.train.AdamOptimizer(0.001, beta1=0.95, beta2=0.9995, epsilon=0.1)
				train_op = optimizer.minimize(loss, colocate_gradients_with_ops=True)

				ema_loss_train=EMA(decay=0.99)
				ema_loss_train.update(loss)

				with tf.control_dependencies([train_op]):
					train_op = tf.group(self.step.assign_add(1), tf.Print(
						0, [self.step, iteration_type, loss],
						message="step|iteration_type|loss"))
				quick_summary_op = tf.summary.merge([
					tf.summary.scalar("loss_train", loss),
					tf.summary.scalar("ema_loss_train", ema_loss_train.val),
				])
				return train_op, quick_summary_op

			def test_iteration():
				ema_loss_test=EMA(decay=0.9)
				ema_loss_test.update(loss)
				quick_summary_op = tf.summary.merge(
					[tf.summary.scalar("loss_test", loss),
					tf.summary.scalar("ema_loss_test", ema_loss_test.val),
						])
				return tf.no_op(), quick_summary_op

			self.iter_op, self.quick_summary_op = tf.cond(
				tf.equal(self.iteration_type, 0),
				training_iteration, test_iteration)

			#self.summaries.extend(
			#	[image_slice_summary(
			#		"boundary_{}".format(key), long_range_affinities[key])
			#		for key in long_range_affinities])
			self.summaries.extend([image_summary("image", image),
									image_summary("mask", tf.to_float(mask)),
									#image_summary("human_labels", tf.to_float(human_labels)),
								   image_summary("vector_labels", vector_labels),
								   image_summary("guess", guess),
								   image_summary("truth", truth),
								   ])
			#self.summaries.extend([tf.summary.image("prediction", tf.reshape(prediction,[1,maxn,maxn,1]))])
			summary_op = tf.summary.merge(self.summaries)

		self.sess.run(tf.variables_initializer(
			tf.get_collection(tf.GraphKeys.VARIABLES,scope='params')+
			tf.get_collection(tf.GraphKeys.VARIABLES,scope='optimize'))
			)
		print(self.sess.run( tf.report_uninitialized_variables( tf.all_variables( ))))

		self.saver = tf.train.Saver(var_list=params_var_list,keep_checkpoint_every_n_hours=2)
		self.summary_op = summary_op
	
	def get_filename(self):
		return os.path.splitext(os.path.basename(__file__))[0]

	def load_random_dataset(self):
		pass

TRAIN = dataset.MultiDataset(
		[
			os.path.expanduser("~/mydatasets/1_1_1/"),
			os.path.expanduser("~/mydatasets/1_2_1/"),
			os.path.expanduser("~/mydatasets/2_1_1/"),
			os.path.expanduser("~/mydatasets/2_2_1/"),
			os.path.expanduser("~/mydatasets/1_3_1/"),
			os.path.expanduser("~/mydatasets/3_1_1/"),

			os.path.expanduser("~/mydatasets/2_3_1/"),
		],
		{
			"image": "image.h5",
			"human_labels": "lzf_proofread.h5",
			"machine_labels": "lzf_mean_agg_tr.h5",
			"samples": "padded_valid_samples.h5",
			"valid": "valid.h5",
		}
)

patch_size=(33,318,318)
args = {
	"offsets": filter(valid_offset, itertools.product(
		[-3, -1, 0, 1, 3],
		[-27, -9, 0, 9, 27],
		[-27, -9, 0, 9, 27])),
	"devices": get_device_list(),
	"patch_size": patch_size,
	"nvec_labels": 6,
	"maxn": 40,
	"dataset": TRAIN,
	"train_vols": [0,1,2,3,4,5],
	"test_vols": [6],
	"name": "test",
}

#New setup
#A sample is a list of supervoxel ids, a window position, and a volume id
#We want to be able to train with multiple volumes.

#pp = pprint.PrettyPrinter(indent=4)
#pp.pprint(args)
main_model = VectorLabelModel(**args)
#main_model.restore("~/experiments/sparse_vector_labels/latest.ckpt")

print("initialized")

if __name__ == '__main__':
	main_model.train(nsteps=1000000, checkpoint_interval=3000, test_interval=15)
	print("done")
