FROM nvidia/cuda:8.0-cudnn5-devel-ubuntu16.04
MAINTAINER Ignacio Tartavull
# This image contains private keys, make sure the image is not pushed to docker hub or any public repo.
## INSTALL gsutil
# Prepare the image.
ENV DEBIAN_FRONTEND noninteractive
RUN apt-get update && apt-get install -y -qq --no-install-recommends \
    apt-utils \
    curl \
    git \
    openssh-client \
    python-openssl \
    python \
    python-pip \
    python-dev \
    python-h5py \
    python-numpy \
    python-setuptools \
    libboost-all-dev \
    libhdf5-dev \
    liblzma-dev \
    libgmp-dev \
    libmpfr-dev \
    screen \
    software-properties-common \
    unzip \
    vim \
    wget \
    zlib1g-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN pip install setuptools Cython wheel numpy

# install neuroglancer
RUN mkdir /.ssh
ADD ./ /neuroglancer
RUN pip install -r /neuroglancer/python/requirements.txt
RUN cd /neuroglancer/python && pip install . && python setup.py develop

#installs julia
RUN add-apt-repository ppa:staticfloat/juliareleases && \
        add-apt-repository ppa:staticfloat/julia-deps && \
        apt-get update && \
        apt-get install -y julia

# installs yacn dependencies
RUN ln -s /usr/lib/x86_64-linux-gnu/libhdf5_serial.so /usr/lib/x86_64-linux-gnu/libhdf5.so
ENV HDF5_DIR=/usr/include/hdf5/serial
RUN echo "push!(LOAD_PATH, \"/neuroglancer/python/ext/third_party/yacn\")" > /root/.juliarc.jl
RUN cd /neuroglancer/python/ext/third_party/yacn/ && \
  julia -e "Pkg.update(); for f in readlines(open(\"REQUIRE\")); Pkg.add(strip(f)); end"
RUN pip install tensorflow-gpu gitpython pandas

CMD cd /neuroglancer/python/ && python -m neuroglancer.pipeline.task_execution