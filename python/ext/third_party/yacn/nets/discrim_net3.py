from convkernels3d import *
from activations import *
from utils import *

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
	lambda x: x,
	tf.nn.elu,
	tf.nn.elu,
	tf.nn.elu,
	tf.nn.elu,
	tf.nn.elu,
	tf.nn.elu
	]

connection_schemas = [
			Connection2dSchema(size=(4,4),strides=(2,2)),
			Connection2dSchema(size=(4,4),strides=(2,2)),
			Connection3dFactorizedSchema(size=(4,4,4),strides=(1,2,2)),
			Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2)),
			Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2)),
			Connection3dFactorizedSchema(size=(4,4,4),strides=(2,2,2))
			]

range_expanders = [range_tuple_expander(strides=strides3d(x), size=size3d(x)) for x in connection_schemas]

def patch_size_suggestions(top_shape):
	base_patch_size = shape_to_slices(top_shape)
	patch_size_suggestions = list(reversed(map(slices_to_shape,cum_compose(*reversed(range_expanders))(base_patch_size))))
	print(patch_size_suggestions)
	return patch_size_suggestions

def make_forward_net(patch_size, n_in, n_out):

	feature_schemas = [
				FeatureSchema(n_in+n_out,0),
				FeatureSchema(4,1),
				FeatureSchema(24,2),
				FeatureSchema(28,3),
				FeatureSchema(32,4),
				FeatureSchema(48,5),
				FeatureSchema(64,6),
				]


	initial = MultiscaleUpConv3d(
			feature_schemas = feature_schemas,
			connection_schemas = connection_schemas,
		activations=initial_activations)
	it1 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)
	it2 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)
	it3 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)
	it4 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)
	it5 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)
	it6 = MultiscaleConv3d(feature_schemas, feature_schemas, connection_schemas, connection_schemas, activations)


	ds_it1_pre = MultiscaleConv3d(feature_schemas[2:], feature_schemas[2:], connection_schemas[2:], connection_schemas[2:], activations[2:])
	ds_it2_pre = MultiscaleConv3d(feature_schemas[2:], feature_schemas[2:], connection_schemas[2:], connection_schemas[2:], activations[2:])
	
	ds_it1 = lambda l: l[0:2] + ds_it1_pre(l[2:])
	ds_it2 = lambda l: l[0:2] + ds_it2_pre(l[2:])

	linears = [FullLinear(n_in=x.nfeatures, n_out=1) for x in feature_schemas]
	apply_linears = lambda tower: [f(x) for f,x in zip(linears, tower)]

	def discriminate(x):
		with tf.name_scope("discriminate"):
			padded_x = tf.concat([x,tf.zeros((1,) + patch_size + (n_out,))],4)
			tower = compose(
					initial,
					it1,
					it2,
					ds_it1,
					ds_it2,
					apply_linears
					)(padded_x)
		return tower


	def reconstruct(x):
		with tf.name_scope("forward"):
			padded_x = tf.concat([x,tf.zeros((1,) + patch_size + (n_out,))],4)
			return compose(
					initial,
					it1,
					it2,

					ds_it1,
					ds_it2,
					ds_it1,
					ds_it2,

					it3,
					it4,
					it5,

					)(padded_x)[0][:,:,:,:,n_in:n_in+n_out]
	return discriminate, reconstruct
