# 2.0.24 (2021-06-10)
FROM emscripten/emsdk@sha256:81ec54b7a096d28f24d906955dbf98ff336cca47658d980c243baa36f6484f9f

ENV FPZIP_1_3_0_SHA256 248df7d84259e3feaa4c4797956b2a77c3fcd734e8f8fdc51ce171dcf4f0136c

RUN mkdir -p /usr/src/fpzip \
    && curl -SL -o /usr/src/fpzip.tar.gz https://github.com/LLNL/fpzip/releases/download/1.3.0/fpzip-1.3.0.tar.gz

RUN echo "${FPZIP_1_3_0_SHA256} /usr/src/fpzip.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/fpzip -f /usr/src/fpzip.tar.gz --strip-components=1 \
    && rm /usr/src/fpzip.tar.gz

# RUN mkdir -p /usr/src/fpzip/build && cd /usr/src/fpzip/build && cmake -DSHARED_LIBS_SUPPORTED=OFF .. && make


