import boto
from boto.s3.key import Key
import os
os.chdir(os.path.expanduser("~/"))

conn = boto.connect_s3()
b = conn.get_bucket('seunglab')
k = Key(b)

for path in ["experiments/sparse_vector_labels/latest.ckpt", "experiments/discriminate3/latest.ckpt"]:
	for extension in ["",".index",".data-00000-of-00001"]:
		k.key = "jzung/" + path + extension
		k.set_contents_from_filename(os.path.realpath(path)+extension)
