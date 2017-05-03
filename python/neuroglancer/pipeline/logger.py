from __future__ import print_function
import os
os.environ['GOOGLE_CLOUD_DISABLE_GRPC'] = 'true'

import socket

from google.cloud.logging.client import Client
from google.cloud.logging.logger import Logger

from neuroglancer.pipeline.secrets import PROJECT_NAME, QUEUE_NAME, google_credentials_path

client = Client.from_service_account_json(
    google_credentials_path, project=PROJECT_NAME)
logger =  Logger('pipeline_logger', client)

def log(severity, task, message):
    # Look at the log produce when running this script at:
    # https://console.cloud.google.com/logs/viewer?project=neuromancer-seung-import&resource=global
    # Choosing the severity:
    # DEBUG     Debug or trace information.
    # INFO      Routine information, such as ongoing status or performance.
    # NOTICE    Normal but significant events, such as start up, shut down, or a configuration change.
    # WARNING   Warning events might cause problems.
    # ERROR     Error events are likely to cause problems.
    # CRITICAL  Critical events cause more severe problems or outages.
    # ALERT     A person must take an action immediately.
    # EMERGENCY One or more systems are unusable.
    
    #TODO change resource from global to GKE containter or similar
    if hasattr(task,'_id'):
        task_id = task._id
        task_str = task.__repr__()
    else:
        task_id = 'undefined'
        task_str = 'undefined task'

    extended_message = '{}\n {}\n on host {}'.format(message, task_str, socket.gethostname())
    print(extended_message)

    logger.log_struct({'message': extended_message, 
                       'taskName':task_id, 
                       'taskQueueName':QUEUE_NAME},
                       severity=severity)

