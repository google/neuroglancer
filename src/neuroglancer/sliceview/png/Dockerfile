# 2.0.24 (2021-06-10)
FROM emscripten/emsdk@sha256:81ec54b7a096d28f24d906955dbf98ff336cca47658d980c243baa36f6484f9f

ENV SPNG_0_7_1_SHA256 0726a4914ad7155028f3baa94027244d439cd2a2fbe8daf780c2150c4c951d8e
ENV MINIZ_2_2_0_SHA256 bd1136d0a1554520dcb527a239655777148d90fd2d51cf02c36540afc552e6ec

RUN mkdir -p /usr/src/spng \
    && curl -SL -o /usr/src/spng.tar.gz https://github.com/randy408/libspng/archive/refs/tags/v0.7.1.tar.gz 

RUN echo "${SPNG_0_7_1_SHA256} /usr/src/spng.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/spng -f /usr/src/spng.tar.gz --strip-components=1 \
    && rm /usr/src/spng.tar.gz

RUN mkdir -p /usr/src/miniz \
    && curl -SL -o /usr/src/miniz.tar.gz https://github.com/richgel999/miniz/archive/refs/tags/2.2.0.tar.gz
RUN echo "${MINIZ_2_2_0_SHA256} /usr/src/miniz.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/miniz -f /usr/src/miniz.tar.gz --strip-components=1 \
    && rm /usr/src/miniz.tar.gz

RUN mkdir -p /usr/src/miniz/build && cd /usr/src/miniz/build && cmake ..
RUN cp /usr/src/miniz/build/miniz_export.h /usr/src/miniz/
