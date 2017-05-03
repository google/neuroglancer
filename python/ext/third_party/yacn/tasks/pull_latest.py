import boto
from boto.s3.key import Key
import os
os.chdir(os.path.expanduser("~/"))

try:
	os.makedirs("experiments/sparse_vector_labels")
except Exception as e:
	print e
try:
	os.makedirs("experiments/discriminate3")
except Exception as e:
	print e

conn = boto.connect_s3()
b = conn.get_bucket('seunglab')
k = Key(b)

for path in ["experiments/sparse_vector_labels/latest.ckpt", "experiments/discriminate3/latest.ckpt"]:
	for extension in ["",".index",".data-00000-of-00001"]:
		k.key = "jzung/" + path + extension
		k.get_contents_to_filename(path + extension)
