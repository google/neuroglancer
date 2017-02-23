import os
import string

def toversion(s):
  s = s.lower()
  allowed = set(string.lowercase + string.digits + '-')
  s = filter(lambda x: x in allowed, s)
  return s

print "export APPVERSION="+toversion(os.environ['TRAVIS_BRANCH'])