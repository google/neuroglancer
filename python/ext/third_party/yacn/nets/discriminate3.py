from __future__ import print_function
import os
os.environ['TF_CUDA_HOST_MEM_LIMIT_IN_MB'] = '200000'
import numpy as np
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
import random

import tensorflow as tf
from tensorflow.python.client import timeline

from utils import *
from dataset import MultiDataset
import augment

class DiscrimModel(Model):
	def __init__(self, patch_size, 
				 dataset,
				 devices, 
				 train_vols,
				 test_vols,
				 name=None):

		self.name=name
		self.summaries = []
		self.devices = devices
		self.patch_size = patch_size
		self.padded_patch_size = (1,) + patch_size + (1,)

		patchx,patchy,patchz = patch_size

		config = tf.ConfigProto(
			allow_soft_placement=True,
			#gpu_options=tf.GPUOptions(per_process_gpu_memory_fraction=0.9, allow_growth=True),
			#log_device_placement=True,
		)
		self.sess = tf.Session(config=config)
		self.run_metadata = tf.RunMetadata()

		with tf.device("/cpu:0"):
			n_volumes = len(dataset.image)
			full_labels_truth = static_constant_multivolume(self.sess, dataset.human_labels, self.padded_patch_size)
			full_labels_lies = static_constant_multivolume(self.sess, dataset.machine_labels, self.padded_patch_size)
			full_image = static_constant_multivolume(self.sess, dataset.image, self.padded_patch_size)
			samples = static_constant_multivolume(self.sess, dataset.samples, (1,3), indexing='CORNER')
		print("finished loading data")

		with tf.name_scope('params'):
			self.step=tf.Variable(0)
			discrim, reconstruct = discrim_net3.make_forward_net(patch_size,2,1)
			self.discrim = discrim

		self.iteration_type=tf.placeholder(shape=[],dtype=tf.int32)

		with tf.name_scope('optimize'):
			loss=0
			reconstruction_loss=0
			for i,d in enumerate(devices):
				with tf.name_scope("gpu"+str(i)):
					with tf.device(d):
						vol_id = tf.cond(tf.equal(self.iteration_type,0),
								lambda: random_sample(tf.constant(train_vols)),
								lambda: random_sample(tf.constant(test_vols)),
								)
						focus=tf.concat([[0],tf.reshape(samples[vol_id,('RAND',0)],(3,)),[0]],0)
						focus=tf.Print(focus,[vol_id, focus], message="focus", summarize=10)
				
						rr=augment.RandomRotationPadded()

						#1 is correct and 0 is incorrect
						lies_glimpse = rr(equal_to_centre(full_labels_lies[vol_id,focus]))
						tmp = full_labels_truth[vol_id,focus]
						truth_glimpse = rr(equal_to_centre(tmp))
						human_labels = rr(tmp)
						image_glimpse = rr(full_image[vol_id,focus])
						
						self.summaries.append(image_summary("lies_glimpse", lies_glimpse))
						self.summaries.append(image_summary("truth_glimpse", truth_glimpse))
						self.summaries.append(image_summary("human_labels", tf.to_float(human_labels)))
						
						occluded = random_occlusion(lies_glimpse)

					with tf.device("/cpu:0"):
						any_error = tf.stop_gradient(1-tf.to_float(tf.reduce_all(tf.equal(truth_glimpse, lies_glimpse))))

					with tf.device(d):
						gpu_any_error = tf.identity(any_error)
						reconstruction = reconstruct(tf.concat([occluded, image_glimpse],4))
						reconstruction_loss += tf.reduce_sum(tf.nn.sigmoid_cross_entropy_with_logits(logits=reconstruction, labels=truth_glimpse))
						
						self.summaries.append(image_summary("reconstruction", tf.nn.sigmoid(reconstruction)))
						self.summaries.append(image_summary("occluded", occluded))

						truth_discrim_tower = discrim(tf.concat([truth_glimpse,image_glimpse],4))
						lies_discrim_tower = tf.cond(tf.greater(gpu_any_error, 0.5),
								lambda: discrim(tf.concat([lies_glimpse,image_glimpse],4)),
								lambda: map(tf.identity, truth_discrim_tower))

					with tf.device(d):
						loss += tf.nn.sigmoid_cross_entropy_with_logits(logits=tf.reduce_sum(lies_discrim_tower[-1]), labels=any_error)
						loss += tf.nn.sigmoid_cross_entropy_with_logits(logits=tf.reduce_sum(truth_discrim_tower[-1]), labels=tf.constant(0,dtype=tf.float32))

					with tf.device("/cpu:0"):
						#any_error = has_error(lies_glimpse, human_labels)
						lies_glimpse = tf.identity(lies_glimpse)
						human_labels = tf.identity(human_labels)
						for i in range(4,6):
							ds_shape = static_shape(lies_discrim_tower[i])
							expander = compose(*reversed(discrim_net3.range_expanders[0:i]))

							tmp=slices_to_shape(expander(shape_to_slices(ds_shape[1:4])))
							assert tuple(tmp) == tuple(self.patch_size)
							def get_localized_errors():
								print(ds_shape)
								x=localized_errors(lies_glimpse, human_labels, ds_shape = ds_shape, expander=expander)
								return tf.Print(x,[any_error],message="any error")

							errors = tf.cond(
									tf.greater(any_error, 0.5),
									lambda:	get_localized_errors(),
									lambda: tf.zeros(ds_shape))
							#errors = tf.Print(errors, [tf.reduce_sum(errors)])
							loss += tf.reduce_mean(tf.nn.sigmoid_cross_entropy_with_logits(logits = lies_discrim_tower[i], labels=errors))
							loss += tf.reduce_mean(tf.nn.sigmoid_cross_entropy_with_logits(logits = truth_discrim_tower[i], labels=tf.zeros_like(truth_discrim_tower[i])))
							self.summaries.append(image_summary("guess"+str(i), upsample_mean(tf.nn.sigmoid(lies_discrim_tower[i]), self.padded_patch_size, expander), zero_one=True))
							self.summaries.append(image_summary("truth"+str(i), upsample_mean(errors, self.padded_patch_size, expander)))


			loss = loss/len(devices)
			reconstruction_loss = reconstruction_loss/len(devices)

			var_list = tf.get_collection(
				tf.GraphKeys.TRAINABLE_VARIABLES, scope='params')

			def train_op():
				optimizer = tf.train.AdamOptimizer(0.0001, beta1=0.95, beta2=0.9995, epsilon=0.1)
				op = optimizer.minimize(8e5*loss + reconstruction_loss, colocate_gradients_with_ops=True, var_list = var_list)

				ema_loss=EMA(decay=0.99)
				ema_loss.update(loss)

				ema_reconstruction_loss=EMA(decay=0.99)
				ema_reconstruction_loss.update(reconstruction_loss)

				with tf.control_dependencies([op]):
					with tf.control_dependencies([self.step.assign_add(1)]):
						op = tf.group(
								tf.Print(0, [tf.identity(self.step), loss], message="step|loss"),
								)
				quick_summary_op = tf.summary.merge([
					tf.summary.scalar("loss", loss),
					tf.summary.scalar("reconstruction_loss", reconstruction_loss),
					tf.summary.scalar("ema_reconstruction_loss", ema_reconstruction_loss.val),
					tf.summary.scalar("ema_loss", ema_loss.val),
				])
				return op, quick_summary_op
			def test_op():
				ema_test_loss=EMA(decay=0.9)
				ema_test_loss.update(loss)

				ema_test_reconstruction_loss=EMA(decay=0.9)
				ema_test_reconstruction_loss.update(reconstruction_loss)
				quick_summary_op = tf.summary.merge([
							tf.summary.scalar("test_loss", loss),
							tf.summary.scalar("test_reconstruction_loss", reconstruction_loss),
							tf.summary.scalar("ema_test_reconstruction_loss", ema_test_reconstruction_loss.val),
							tf.summary.scalar("ema_test_loss", ema_test_loss.val),
							])

				return tf.no_op(), quick_summary_op

			self.iter_op, self.quick_summary_op = tf.cond(tf.equal(self.iteration_type,0),
				train_op,
				test_op)
		self.sess.run(tf.variables_initializer(
			tf.get_collection(tf.GraphKeys.VARIABLES,scope='params')+
			tf.get_collection(tf.GraphKeys.VARIABLES,scope='optimize'))
			)
		print(self.sess.run( tf.report_uninitialized_variables( tf.all_variables( ))))

		summary_op = tf.summary.merge(self.summaries)

		self.saver = tf.train.Saver(var_list=var_list,keep_checkpoint_every_n_hours=2)
		self.summary_op = summary_op
	
	def get_filename(self):
		return os.path.splitext(os.path.basename(__file__))[0]

	def interrupt(self):
		return

	def load_random_dataset(self):
		dataset = random.choice(self.datasets)
		print("Loading new dataset: ")
		print(dataset.directories)

		self.load_truth(dataset.human_labels)
		self.load_lies(dataset.machine_labels)
		self.load_image(dataset.image)
		self.load_samples(dataset.samples)
TRAIN = MultiDataset(
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
			"machine_labels": "lzf_mean_agg_tr.h5",
			"human_labels": "lzf_proofread.h5",
			"image": "image.h5",
			"samples": "padded_valid_samples.h5",
		}
)
args = {
	"devices": get_device_list(),
	"patch_size": tuple(discrim_net3.patch_size_suggestions([2,3,3])[0]),
	"name": "test",
	"dataset": TRAIN,
	"train_vols": [0,1,2,3,4,5],
	"test_vols": [6]
}

#pp = pprint.PrettyPrinter(indent=4)
#pp.pprint(args)
#with tf.device(args["devices"][0]):
main_model = DiscrimModel(**args)
main_model.restore("~/experiments/discriminate3/latest.ckpt")
print("model initialized")
if __name__ == '__main__':
	main_model.train(nsteps=1000000, checkpoint_interval=3000, test_interval=15)
