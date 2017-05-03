from convkernels3d import *
from activations import *
from utils import *

def make_forward_net(patch_size, n_in, n_out):
	feature_schemas = [
				FeatureSchema(n_in+n_out,0),
				FeatureSchema(18,1),
				FeatureSchema(24,2),
				FeatureSchema(28,3),
				FeatureSchema(32,4),
				FeatureSchema(48,5),
				FeatureSchema(64,6),
				]
	connection_schemas = [
				Connection2dSchema(size=(4,4),strides=(2,2)),
				Connection2dSchema(size=(4,4),strides=(2,2)),
				Connection3dFactorizedSchema(size=(4,4,4),strides=(1,2,2)),
				Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2)),
				Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2)),
				Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2))
				]

	initial_activations = [
		lambda x: x,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu
		]

	activations = [
		tf.nn.tanh,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu
		]

	initial = MultiscaleUpConv3d(
			feature_schemas = feature_schemas,
			connection_schemas = connection_schemas,
		activations=initial_activations)
	it1 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas,  [Tanh()] + activations[1:])
	it2 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas,  [Tanh()] + activations[1:])
	it3 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas,  [Tanh()] + activations[1:])
	it4 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas,  [Tanh()] + activations[1:])
	it5 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas,  [Tanh()] + activations[1:])
	it6 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas,  [Tanh()] + activations[1:])


	ds_it1_pre = MultiscaleConv3d(feature_schemas[1:], feature_schemas[1:], connection_schemas[1:], connection_schemas[1:], activations[1:])
	ds_it2_pre = MultiscaleConv3d(feature_schemas[1:], feature_schemas[1:], connection_schemas[1:], connection_schemas[1:], activations[1:])
	ds_it3_pre = MultiscaleConv3d(feature_schemas[1:], feature_schemas[1:], connection_schemas[1:], connection_schemas[1:], activations[1:])
	ds_it4_pre = MultiscaleConv3d(feature_schemas[1:], feature_schemas[1:], connection_schemas[1:], connection_schemas[1:], activations[1:])
	
	ds_ds_it1_pre = MultiscaleConv3d(feature_schemas[2:], feature_schemas[2:], connection_schemas[2:], connection_schemas[2:], activations[2:])
	ds_ds_it2_pre = MultiscaleConv3d(feature_schemas[2:], feature_schemas[2:], connection_schemas[2:], connection_schemas[2:], activations[2:])

	ds_it1 = lambda l: l[0:1] + ds_it1_pre(l[1:])
	ds_it2 = lambda l: l[0:1] + ds_it2_pre(l[1:])
	ds_it3 = lambda l: l[0:1] + ds_it3_pre(l[1:])
	ds_it4 = lambda l: l[0:1] + ds_it4_pre(l[1:])

	ds_ds_it1 = lambda l: l[0:2] + ds_ds_it1_pre(l[2:])
	ds_ds_it2 = lambda l: l[0:2] + ds_ds_it2_pre(l[2:])

	def forward(x):
		with tf.name_scope("forward"):
			padded_x = tf.concat([x,tf.zeros((1,) + patch_size + (n_out,))],4)
			i=initial(padded_x)
			print(map(static_shape,i))
			return compose(
					it1,
					it2,

					ds_it1,
					ds_it2,

					ds_ds_it1,
					ds_ds_it2,
					ds_ds_it1,
					ds_ds_it2,

					ds_it3,
					ds_it4,

					it3,
					it4,

					)(i)[0][:,:,:,:,n_in:n_in+n_out]
	return forward
