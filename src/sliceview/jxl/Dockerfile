# 2.0.24 (2024-09-16)

FROM emscripten/emsdk:3.1.67-arm64@sha256:7be1a8c22913aeac1b66b0ada6dea07cacabffa7634b71968859e330d54e709e

RUN apt-get update && apt-get -y install cmake g++

ENV LIBJXL_0_11_0_SHA256=7ce4ec8bb37a435a73ac18c4c9ff56c2dc6c98892bf3f53a328e3eca42efb9cf
ENV NINJA_BUILD_1_21_1=821bdff48a3f683bc4bb3b6f0b5fe7b2d647cf65d52aeb63328c91a6c6df285a

RUN mkdir -p /usr/src/libjxl \
    && curl -SL -o /usr/src/libjxl.tar.gz https://github.com/libjxl/libjxl/archive/refs/tags/v0.11.0.tar.gz

RUN mkdir -p /usr/src/ninja-build \
    && curl -SL -o /usr/src/ninja-build.tar.gz https://github.com/ninja-build/ninja/archive/refs/tags/v1.12.1.tar.gz

RUN echo "${LIBJXL_0_11_0_SHA256} /usr/src/libjxl.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/libjxl -f /usr/src/libjxl.tar.gz --strip-components=1 \
    && rm /usr/src/libjxl.tar.gz

RUN echo "${NINJA_BUILD_1_21_1} /usr/src/ninja-build.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/ninja-build -f /usr/src/ninja-build.tar.gz --strip-components=1 \
    && rm /usr/src/ninja-build.tar.gz

RUN cd /usr/src/ninja-build/ && mkdir build-cmake && cd build-cmake && cmake .. && make && sudo mv ninja /usr/local/bin

RUN /usr/src/libjxl/deps.sh

RUN mkdir -p /usr/src/libjxl/build-cmake/ && cd /usr/src/libjxl/build-cmake && cmake ..  -G Ninja -DCMAKE_TOOLCHAIN_FILE=/emsdk/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake -DBUILD_SHARED_LIBS=OFF -DJPEGXL_ENABLE_WASM_THREADS=OFF -DCMAKE_C_FLAGS="-g2 -O0" -DCMAKE_CXX_FLAGS="-g2 -O0" && ninja --verbose



