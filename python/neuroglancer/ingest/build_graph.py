import h5py
import numpy as np
from itertools import product
from tqdm import tqdm
from numba import jit
from collections import defaultdict
import networkx as nx

edges = defaultdict(lambda: (0.0, 0))
def read_arrays():
  with h5py.File('./machine_labels.h5') as f:
    ml = f['main'][:]
  with h5py.File('./affinities.h5') as f:
    hl = f['main'][:]
  with h5py.File('./affinities.h5') as f:
    aff = f['main'][:]

  return ml, hl, aff , product(*map(xrange, ml.shape))
ml, hl, aff , p = read_arrays()

@jit
def compute_edges(z,y,x, ml_id):
  if z + 1 < ml.shape[0]:
    union_seg(ml_id, ml[z+1,y,x], aff[2, z+1, y, x])
  if y + 1 < ml.shape[1]:
    union_seg(ml_id, ml[z,y+1,x], aff[1, z, y+1, x])
  if x + 1 < ml.shape[2]:
    union_seg(ml_id, ml[z,y,x+1], aff[0, z, y, x+1])

@jit
def union_seg(id_1, id_2, aff_edge):
  if id_1 == id_2 or id_2 == 0: #no need to check if id_0 == 0, because of run() for loop
    return 
  if id_1 > id_2:
    id_1 , id_2 = id_2, id_1

  aff_sum, aff_count = edges[(id_1, id_2)]
  edges[(id_1, id_2)] = (aff_sum + aff_edge, aff_count + 1)

@jit
def create_list_of_edges():
  for z, y, x in tqdm(p):
    ml_id = ml[z,y,x]
    if ml_id == 0: #ignore boundaries
      continue
    compute_edges(z,y,x, ml_id)

# @jit
def create_graph():
  G = nx.Graph()
  for edge, (aff_sum, aff_count) in edges.iteritems():
    u, v = edge
    G.add_edge(u,v, capacity=aff_sum/aff_count)
  
  nx.write_gpickle(G,"snemi3d_graph.pickle")

create_list_of_edges()
create_graph()
