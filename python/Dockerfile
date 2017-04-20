FROM python:2.7
MAINTAINER Ignacio Tartavull
# This image contains private keys, make sure the image is not pushed to docker hub or any public repo.
## INSTALL gsutil
# Prepare the image.
ENV DEBIAN_FRONTEND noninteractive
RUN apt-get update && apt-get install -y -qq --no-install-recommends wget unzip python php5-mysql php5-cli php5-cgi openjdk-7-jre-headless openssh-client python-openssl libboost-all-dev libhdf5-dev && apt-get clean
# Install the Google Cloud SDK.
ENV HOME /
ENV CLOUDSDK_PYTHON_SITEPACKAGES 1
ENV CLOUD_COMPUTING 1
RUN wget https://dl.google.com/dl/cloudsdk/channels/rapid/google-cloud-sdk.zip && unzip google-cloud-sdk.zip && rm google-cloud-sdk.zip
RUN google-cloud-sdk/install.sh --usage-reporting=true --path-update=true --bash-completion=true --rc-path=/.bashrc --additional-components app-engine-java app-engine-python app kubectl alpha beta gcd-emulator pubsub-emulator cloud-datastore-emulator app-engine-go bigtable
# Disable updater check for the whole installation.
# Users won't be bugged with notifications to update to the latest version of gcloud.
RUN google-cloud-sdk/bin/gcloud config set --installation component_manager/disable_update_check true
# Disable updater completely.
# Running `gcloud components update` doesn't really do anything in a union FS.
# Changes are lost on a subsequent run.
RUN sed -i -- 's/\"disable_updater\": false/\"disable_updater\": true/g' /google-cloud-sdk/lib/googlecloudsdk/core/config.json
RUN mkdir /.ssh
ENV PATH /google-cloud-sdk/bin:$PATH
ADD ./ /root/python
RUN pip install -r /root/python/requirements.txt
RUN cd /root/python && python setup.py install
RUN cd /root/python/neuroglancer/ingest && make
ADD ./neuroglancer/ingest/client-secret.json /root/client-secret.json
RUN gcloud auth activate-service-account --key-file=/root/client-secret.json
CMD cd /root/python/ && python -m neuroglancer.ingest.digest
