# Use the official Playwright image with the version matching package.json
# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.50.1-jammy

# Set environment variables
ENV CI=true
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

# Install Node.js 22 optimized by copying from a pre-built image
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules

# Install uv (required for python tests/fixtures)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Install Go (required for fake-gcs-server)
COPY --from=golang:1.24-bookworm /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    npm install -g pnpm

# Set working directory
WORKDIR /app

# Copy package files first to leverage cache
COPY package.json package-lock.json ./

# Copy build_tools as it is required for the prepare script during npm ci
COPY build_tools ./build_tools

# Install dependencies using cache mount for npm
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy the rest of the application code
COPY . .

# Default command to run Playwright tests
ENTRYPOINT ["npm", "run", "test"]
CMD []
