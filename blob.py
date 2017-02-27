import logging
import googleapiclient.discovery
import webapp2


# The bucket that will be used to list objects.
BUCKET_NAME = 'neuroglancer'

storage = googleapiclient.discovery.build('storage', 'v1')


class MainPage(webapp2.RequestHandler):
    def get(self, filename):
        try:
          response = storage.objects().get_media(bucket=BUCKET_NAME,object=filename).execute()
          self.response.write(response)
        except:
          self.response.write('Blob does not exist.')
          self.response.set_status(404)

app = webapp2.WSGIApplication([
    (r'/blob/(.*)', MainPage)
], debug=True)
