import logging
import socket
from time import sleep

import google.cloud.logging # Don't conflict with standard logging
from google.cloud.logging.handlers import CloudLoggingHandler

from neuroglancer.pipeline import TaskQueue
from neuroglancer.pipeline.secrets import PROJECT_NAME, QUEUE_NAME, google_credentials_path

# Look at the log produce when running this script at:
# https://console.cloud.google.com/logs/viewer?project=neuromancer-seung-import&minLogLevel=0&expandAll=false&resource=global
client = google.cloud.logging.Client.from_service_account_json(google_credentials_path, project=PROJECT_NAME)
handler = CloudLoggingHandler(client)
cloud_logger = logging.getLogger('cloudlogger')
cloud_logger.setLevel(logging.INFO) # defaults to WARN
cloud_logger.addHandler(handler)


tq = TaskQueue()
while True:
    try:
        task = tq.lease()
        task.execute()
        tq.delete(task.id)
        cloud_logger.info({
            "taskName": task.id,
            "taskQueueName": QUEUE_NAME,
            "message": "succesfully executed.\n" + task.__repr__()
        }) 
    except TaskQueue.QueueEmpty:
        sleep(1)
        continue
    except Exception as e:
        cloud_logger.exception("Exception in task_execution.py running at {}.".format(socket.gethostname()))
        raise 
