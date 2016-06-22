import os
import binascii

def make_random_token():
  return binascii.hexlify(os.urandom(20))
