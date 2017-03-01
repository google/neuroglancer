import pandas
import h5py
import numpy as np

def get_box_slice(center, volume, size):

  z,y,x = center
  max_z , max_y, max_x = volume.shape

  slicing =  (slice(max(0,z-size),min(max_z,z+size)),
              slice(max(0,y-size),min(max_y,y+size)),
              slice(max(0,x-size),min(max_x,x+size)))

  return volume[slicing]

def find_pre_and_post(centroid, pre, pos, volume):
  for size in xrange(1,50,3):
    box = get_box_slice(centroid, volume, size)
    
    pre_where = np.where(box == pre)
    pos_where = np.where(box == pos)
    if len(pos_where[0]) and len(pre_where[0]):
      pre_rel =  np.array(map(lambda x: x[0], pre_where))
      pos_rel =  np.array(map(lambda x: x[0], pos_where))
      return pre_rel + centroid, pos_rel + centroid

  print 'couldnt find point ', centroid, pre, pos

parsed = []
failed = []
with h5py.File('/home/it2/evaluation/compressed.h5') as f:

  df = pandas.read_csv('/home/it2/evaluation/corrected_cons_edges.csv',sep=';',header=None)
  for row in df.iterrows():
    # print 
    i, row = row
    synapse_id, pre_pos, centroid, _ = row
    pre, pos = eval(pre_pos)
    centroid = eval(centroid)
    centroid = np.array(centroid[::-1])

    positions = find_pre_and_post(centroid, pre, pos, f['main'])
    if positions:
      parsed.append(list(positions[0][::-1]))
      parsed.append(list(positions[1][::-1]))
    else:
      failed.append(list(centroid)[::-1])

