FROM nvidia/cuda:8.0-cudnn5-devel-ubuntu16.04

RUN apt-get update && apt-get install -y --no-install-recommends apt-utils software-properties-common


#####YACN dependencies#####

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        libhdf5-dev \
        zlib1g-dev \
        screen \
		vim \
        wget \
		python-pip \
		python-dev \ 
		python-h5py \ 
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

#Change this to install julia-0.5
RUN add-apt-repository ppa:staticfloat/juliareleases && \
        add-apt-repository ppa:staticfloat/julia-deps && \
        apt-get update && \
        apt-get install -y julia

RUN git clone https://github.com/seung-lab/neuroglancer.git /root/neuroglancer_repo
WORKDIR /root/neuroglancer_repo/python
RUN pip install setuptools Cython wheel numpy
RUN ln -s /usr/lib/x86_64-linux-gnu/libhdf5_serial.so /usr/lib/x86_64-linux-gnu/libhdf5.so
ENV HDF5_DIR=/usr/include/hdf5/serial
RUN pip install -r /root/neuroglancer_repo/python/requirements.txt /root/neuroglancer_repo/python || echo
ADD .boto /root/

RUN pip install tornado sockjs-tornado

RUN git clone https://github.com/seung-lab/yacn.git /root/yacn

WORKDIR /root/yacn

ENV PYTHONPATH $PYTHONPATH:/root
RUN echo "push!(LOAD_PATH, \"/root/yacn/pre\")" > /root/.juliarc.jl

RUN pip install -r requirements.txt

RUN julia -e "Pkg.update(); for f in readlines(open(\"REQUIRE\")); Pkg.add(strip(f)); end"

RUN python tasks/pull_latest.py
