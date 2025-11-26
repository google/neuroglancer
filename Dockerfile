FROM mcr.microsoft.com/playwright:v1.50.1-jammy

ENV CI=true
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
ENV UV_PYTHON=3.12

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY --from=golang:1.24-bookworm /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    npm install -g pnpm

WORKDIR /app

COPY package.json package-lock.json ./

COPY build_tools ./build_tools

RUN --mount=type=cache,target=/root/.npm \
    npm ci

RUN cd build_tools/vitest/python_tools && uv sync --frozen

COPY . .

ENTRYPOINT ["npm", "run", "test"]
CMD []
