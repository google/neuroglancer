from time import sleep
import traceback

from neuroglancer.pipeline import TaskQueue, EmptyVolumeException
from neuroglancer.pipeline import logger

tq = TaskQueue()
while True:
    task = 'unknown'
    try:
        task = tq.lease()
        task.execute()
        tq.delete(task)
        logger.log('INFO', task , "succesfully executed")
    except TaskQueue.QueueEmpty:
        sleep(1)
        continue
    except EmptyVolumeException:
        logger.log('WARNING', task, "raised an EmptyVolumeException")
        tq.delete(task)
    except Exception as e:
        logger.log('ERROR', task, "raised {}\n {}".format(e , traceback.format_exc()))
        raise #this will restart the container in kubernetes