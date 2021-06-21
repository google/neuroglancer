FROM trzeci/emscripten:sdk-tag-1.38.44-64bit

RUN mkdir -p /usr/src/draco \
    && curl -SL https://github.com/google/draco/archive/1.3.5.tar.gz \
    | tar -xzC /usr/src/draco --strip-components=1
