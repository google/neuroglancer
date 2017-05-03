
from __future__ import print_function
import time
import h5py
import numpy as np
import scipy.spatial as sp
import networkx as nx
import numpy as np
files = []
def h5read(filename, force=False):
	try:
		if force:
			with h5py.File(filename,'r') as f:
				return f['main'][:]
		else:
			f=h5py.File(filename,'r')
			global files
			files.append(f)
			return f['main']
	except IOError:
		print(filename+' not found')

def h5write(filename, x):
	f = h5py.File(filename, "w")
	dset = f.create_dataset("main", data=x)
	f.close()

tics=[]
def tic():
	global tics
	tics.append(time.time())

def toc(msg="toc"):
	elapsed = time.time() - tics.pop()
	print("\t"*len(tics) + msg + " " + str(elapsed))

def indicator(A, s):
	return np.reshape(np.in1d(A,np.array(list(s))).astype(np.int32),np.shape(A))


def compute_fullgraph(raw, resolution=np.array([4,4,40]), r=100):
	point_lists = [[] for i in xrange(np.max(raw)+1)]
	X,Y,Z = raw.shape

	print("computing fullgraph")
	for i in xrange(X):
		tic()
		for j in xrange(Y):
			for k in xrange(Z):
				point_lists[raw[i,j,k]].append(np.array([i,j,k])*resolution)
		toc("toc: point lists generated")

	println("accumulated points")

	trees = [sp.cKDTree(transpose(flatten(points))) for points in point_lists]

	print("generated trees")

	def close(x,y):
		t1=trees[i]
		t2=trees[j]
		return t1[:count_neighbors](t2,r) > 0
	return close

def unique_nonzero(A):
	return filter(lambda x: x!=0, np.unique(A))


def flatten(G, raw, dense=True):
	components = nx.connected_components(G)
	d={}
	for i,nodes in enumerate(components,1):
		for node in nodes:
			d[node]=i
	d[0]=0
	
	if dense:
		mp = np.arange(0,max(d.keys())+1,dtype=np.int32)
		mp[d.keys()] = d.values()
		return mp[raw]
	else:
		return np.vectorize(d.get)(raw)
