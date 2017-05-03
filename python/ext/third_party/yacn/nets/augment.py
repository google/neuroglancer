import tensorflow as tf
import numpy as np
from utils import *

class RandomRotationPadded():
	def __init__(self):
		self.perm = tf.cond(rand_bool([]), lambda: tf.constant([0,1,2,3,4]), lambda: tf.constant([0,1,3,2,4]))
		r = tf.random_uniform([], minval=0, maxval=8, dtype=tf.int32)

		def rotation_factory(s):
			return lambda: tf.constant(s,dtype=tf.int32)
		
		self.rev = tf.case([(tf.equal(r,i), rotation_factory(s)) for i,s in enumerate(subsets([1,2,3]))],lambda: tf.constant([],dtype=tf.int32),exclusive=True)

	def __call__(self,x):
		return tf.reshape(tf.transpose(tf.reverse(x, self.rev), perm=self.perm), static_shape(x))

class MissingSection():
	def __init__(self, p):
		self.p=p
		pass

	def __call__(self,A):
		#remember A is of shape [_,z,y,x,_]
		s=static_shape(A)
		mask = tf.cast(rand_bool([1,static_shape(A)[1],1,1,1], prob = 1-self.p),A.dtype)
		return mask * A

class RandomBlur():
	def __init__(self):
		kernels0 = tf.pad(np.ones([3,3],dtype=np.float32), np.array([[1,1],[1,1]],dtype=np.float32))
		kernels1 = np.ones([5,5],dtype=np.float32)
		kernels0 = kernels0/tf.reduce_sum(kernels0)
		kernels1 = kernels1/tf.reduce_sum(kernels1)

		kernels = tf.concat(map(lambda x: tf.reshape(x,[5,5,1,1,1]),[kernels0,kernels1]), 4)
		self.kernel = kernels[:,:,:,:,tf.random_uniform([],minval=0,maxval=2,dtype=tf.int32)]

	def __call__(self,A):

		x=tf.squeeze(A,0)
		tmp=tf.nn.conv2d(x,self.kernel, strides=[1,1,1,1],padding='SAME')
		tmp=tf.expand_dims(tmp,0)
		return tmp

def circshift(A, dim, offset):
	s=static_shape(A)
	offset = tf.mod(offset, s[dim])
	rangesA = [slice(0,x) for x in s]
	rangesB = [slice(0,x) for x in s]
	rangesA[dim] = slice(0,offset)
	rangesB[dim] = slice(offset, s[dim])
	return tf.reshape(tf.concat([A[tuple(rangesB)],A[tuple(rangesA)]],dim), s)

class RandomBrightness():
	def __init__(self):
		self.delta = tf.random_uniform([],minval=-0.1,maxval=0.1)
		self.factor = tf.random_uniform([],minval=0.95,maxval=1.05)
	
	def __call__(self,x):
		return tf.maximum(tf.constant(0,dtype=x.dtype),tf.minimum(tf.constant(1,dtype=x.dtype),(x+self.delta)*self.factor))

class MisAlign():
	def __init__(self, max_offset):
		self.offset = [tf.random_uniform([], minval=-i, maxval=i+1, dtype=tf.int32) for i in max_offset]
	def __call__(self,A):
		s=static_shape(A)
		mA=A
		for i,o in enumerate(self.offset):
			mA=circshift(mA,i+2,o)

		return mA

class ApplyRandomSlice():
	def __init__(self, p, f):
		self.p=p
		self.f = f
	
	def __call__(self,A):
		if not hasattr(self, "mask"):
			z=static_shape(A)[1]
			self.mask = rand_bool([1,z,1,1,1], prob = 1-self.p)
		mask = tf.cast(self.mask, A.dtype)
		B = self.f(A)
		return A*mask + B*(tf.ones([],dtype=A.dtype)-mask)

class ApplyRandomChunk():
	def __init__(self, p, f):
		self.f=f
		self.p=p
	
	def __call__(self,A):
		fA = self.f(A)
		if not hasattr(self, "k"):
			z=static_shape(A)[1]
			self.k=tf.cond(rand_bool([],prob=self.p),
					lambda: tf.random_uniform([], minval=0, maxval=z,dtype=tf.int32),
					lambda: tf.constant(0,dtype=tf.int32))
		s=static_shape(A)
		rangesA = [slice(0,x) for x in s]
		rangesB = [slice(0,x) for x in s]
		rangesA[1] = slice(0,self.k)
		rangesB[1] = slice(self.k, s[1])
		return tf.reshape(tf.concat([fA[tuple(rangesA)],A[tuple(rangesB)]],1), s)

def default_augmentation():
	rr=RandomRotationPadded()
	t1=ApplyRandomSlice(0.01, MisAlign([20,20]))
	t2=ApplyRandomSlice(0.01, RandomBlur())
	t3=ApplyRandomSlice(0.01, RandomBrightness())
	t4=MissingSection(0.01)

	def f_image(x):
		s=static_shape(x)
		return rr(t4(t3(t2(t1(x)))))[:,:,20:s[2]-20,20:s[3]-20,:]

	def f_label(x):
		s=static_shape(x)
		return rr(t1(x))[:,:,20:s[2]-20,20:s[3]-20,:]
	return f_image, f_label

if __name__=='__main__':
	x=tf.constant(np.reshape(np.array([[range(0+i,5+i), range(10+i,15+i), range(20+i,25+i), range(30+i,35+i), range(40+i,45+i)] for i in xrange(8)],dtype=np.float32),[1,8,5,5,1]))

	t1=ApplyRandomSlice(0.2,MisAlign([3,3]))
	#t2=MissingSection(0.2)
	t2 = ApplyRandomChunk(0.5,MisAlign([3,3]))
	t3 = ApplyRandomSlice(0.2, RandomBlur())
	rr=RandomRotationPadded()

	print x
	sess = tf.Session()
	print np.reshape(sess.run(rr(t1(x))), [8,5,5])
