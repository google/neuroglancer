# 2.0.24 (2021-06-10)
FROM emscripten/emsdk@sha256:81ec54b7a096d28f24d906955dbf98ff336cca47658d980c243baa36f6484f9f

RUN mkdir -p /usr/src/spng \
    && curl -SL https://github.com/randy408/libspng/archive/refs/tags/v0.7.1.tar.gz \
    | tar -xzC /usr/src/spng --strip-components=1

RUN mkdir -p /usr/src/miniz \
    && curl -SL https://github.com/richgel999/miniz/archive/refs/tags/2.2.0.tar.gz \
    | tar -xzC /usr/src/miniz --strip-components=1

RUN mkdir -p /usr/src/miniz/build && cd /usr/src/miniz/build && cmake ..
RUN cp /usr/src/miniz/build/miniz_export.h /usr/src/miniz/
