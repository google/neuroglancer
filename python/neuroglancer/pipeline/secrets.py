import json

from oauth2client import service_account

QUEUE_NAME = 'pull-queue'
PROJECT_NAME = 'neuromancer-seung-import'

google_credentials_path = '/secrets/google-secret.json'
google_credentials = service_account.ServiceAccountCredentials \
  .from_json_keyfile_name(google_credentials_path)

aws_credentials_path =  '/secrets/aws-secret.json'
with open(aws_credentials_path, 'rb') as f:
  aws_credentials = json.loads(f.read())