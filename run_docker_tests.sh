set -e

export DOCKER_BUILDKIT=1

IMAGE_NAME="neuroglancer-playwright-runner"

echo "Building Docker image: $IMAGE_NAME..."
echo "  (Note: First build may be slow. Subsequent builds use cache.)"

docker build -t $IMAGE_NAME .

echo "Running Playwright tests with arguments: $@"

mkdir -p playwright-report test-results

docker run --rm \
  -v "$(pwd)/playwright-report:/app/playwright-report" \
  -v "$(pwd)/test-results:/app/test-results" \
  --ipc=host \
  $IMAGE_NAME "$@"
