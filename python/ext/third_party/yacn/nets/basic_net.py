from convkernels import *
from activations import *

def make_forward_net(patch_size, n_in, n_out):
	strides = [(2, 2) for i in xrange(5)]
	sizes = [(4, 4, 1), (4, 4, 2), (4, 4, 4), (4, 4, 8), (4, 4, 16)]

	initial_schemas = [
				FeatureSchema(n_in+n_out,0),
				FeatureSchema(24,1),
				FeatureSchema(28,2),
				FeatureSchema(32,3),
				FeatureSchema(48,4),
				FeatureSchema(64,5)]
	second_schemas = [
				FeatureSchema(n_in+n_out,0),
				FeatureSchema(24,1),
				FeatureSchema(28,2),
				FeatureSchema(32,3),
				FeatureSchema(48,4),
				FeatureSchema(64,5)]
	connection_schemas = [
				Connection3dSchema(size=(4,4,1),strides=(2,2)),
				Connection3dSchema(size=(4,4,2),strides=(2,2)),
				Connection3dSchema(size=(4,4,4),strides=(2,2)),
				Connection3dSchema(size=(4,4,8),strides=(2,2)),
				Connection3dSchema(size=(4,4,16),strides=(2,2))]

	initial_activations = [
		lambda x: x,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu]

	activations = [
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu,
		tf.nn.elu
		]
	initial = MultiscaleUpConv3d(
			feature_schemas = initial_schemas,
			connection_schemas = connection_schemas,
		activations=initial_activations)
	it1 = MultiscaleConv3d(initial_schemas, second_schemas, connection_schemas, connection_schemas, [SymmetricTanh()] + activations)
	it2 = MultiscaleConv3d(second_schemas, second_schemas, connection_schemas, connection_schemas, [SymmetricTanh()] + activations)
	it3 = MultiscaleConv3d(second_schemas, second_schemas, connection_schemas, connection_schemas, [SymmetricTanh()] + activations)
	it4 = MultiscaleConv3d(second_schemas, second_schemas, connection_schemas, connection_schemas, [SymmetricTanh()] + activations)
	it5 = MultiscaleConv3d(second_schemas, second_schemas, connection_schemas, connection_schemas, [SymmetricTanh()] + activations)
	it6 = MultiscaleConv3d(second_schemas, second_schemas, connection_schemas, connection_schemas, [SymmetricTanh()] + activations)

	def forward(x):
		padded_x = tf.concat(3,[x,tf.zeros(patch_size + (n_out,))])
		return it6(it5(it4(it5(it4(it3(it2(it1(initial(padded_x)))))))))[0][:,:,:,n_in:n_in+n_out]
	return forward
