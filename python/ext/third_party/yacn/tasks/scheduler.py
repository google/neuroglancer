from itertools import product
import random

chunk_size=[768,768,96]
full_size=[10000,10000,1000]
offset=[0,0,0]

corners = list(product(*[xrange(o, f, c) for o,f,c in zip(offset,full_size,chunk_size)]))

def neighbours(corner):
	for i in [-1,0,1]:
		for j in [-1,0,1]:
			for k in [-1,0,1]:
				yield (corner[0]+i*chunk_size[0], 
						corner[1]+j*chunk_size[1],
						corner[2]+k*chunk_size[2])

def corner_to_chunk(corner):
	return tuple(slice(c,c+x) for c,x in zip(corner, chunk_size))

class LockException(Exception):
	def __init__(self, key, subscriber):
		self.key=key
		self.subscriber=subscriber

locks = {}
def lock(corner, subscriber):
	if corner in locks and locks[corner] != subscriber:
		raise LockException(corner,subscriber)
	locks[corner]=subscriber

def unlock(corner, subscriber):
	assert locks[corner] == subscriber
	locks.pop(corner)

def atomic_lock(corners, subscriber):
	corners = sorted(corners)
	for i in xrange(len(corners)):
		try:
			lock(corners[i], subscriber)
		except LockException as e:
			for j in xrange(i):
				unlock(corners[j], subscriber)
			raise e

def atomic_unlock(corners, subscriber):
	corners = sorted(corners)
	for i in xrange(len(corners)):
		unlock(corners[i], subscriber)

not_started=set(corners)
in_progress=set([])
finished=set([])

def schedule(corner):
	assert corner in not_started
	atomic_lock(list(neighbours(corner)), corner)
	not_started.remove(corner)
	in_progress.add(corner)
	print "scheduled " + str(corner)

def finish(corner):
	assert corner not in not_started
	atomic_unlock(list(neighbours(corner)), corner)
	in_progress.remove(corner)
	finished.add(corner)
	print "finished " + str(corner)


while len(finished) < len(corners):
	#print str(len(finished)) +  " / " + str(len(corners)) + "/" + str(len(in_progress))
	try:
		corner = random.sample(not_started,1)[0]
		schedule(corner)
	except (LockException, ValueError) as e:
		#print "Lock failed: " + str(e.key) + " " + str(e.subscriber)
		if len(in_progress) > 0:
			finish(random.sample(in_progress,1)[0])

