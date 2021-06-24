# 2.0.24 (2021-06-10)
FROM emscripten/emsdk@sha256:81ec54b7a096d28f24d906955dbf98ff336cca47658d980c243baa36f6484f9f

RUN mkdir -p /usr/src/draco \
    && curl -SL https://github.com/google/draco/archive/1.4.1.tar.gz \
    | tar -xzC /usr/src/draco --strip-components=1
