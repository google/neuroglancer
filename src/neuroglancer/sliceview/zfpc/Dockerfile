# 2.0.24 (2021-06-10)
FROM emscripten/emsdk@sha256:81ec54b7a096d28f24d906955dbf98ff336cca47658d980c243baa36f6484f9f

ENV ZFP_1_0_0_SHA256 0ea08ae3e50e3c92f8b8cf41ba5b6e2de8892bc4a4ca0c59b8945b6c2ab617c4

RUN mkdir -p /usr/src/zfp \
    && curl -SL -o /usr/src/zfp.tar.gz https://github.com/LLNL/zfp/releases/download/1.0.0/zfp-1.0.0.tar.gz

RUN echo "${ZFP_1_0_0_SHA256} /usr/src/zfp.tar.gz" | sha256sum --check --status
RUN tar -xzC /usr/src/zfp -f /usr/src/zfp.tar.gz --strip-components=1 \
    && rm /usr/src/zfp.tar.gz

# Emits /usr/src/zfp/build/lib/libzfp.a
RUN mkdir -p /usr/src/zfp/build && cd /usr/src/zfp/build \
    && cmake .. -DBUILD_SHARED_LIBS=OFF \
    && cmake --build . --config MinSizeRel

