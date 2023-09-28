export const vertexShader = `
vec3 boxVertex = getBoxFaceVertexPosition(gl_VertexID);
vec3 position = max(uLowerClipBound, min(uUpperClipBound, uTranslation + boxVertex * uChunkDataSize));
vNormalizedPosition = gl_Position = uModelViewProjectionMatrix * vec4(position, 1.0);
gl_Position.z = 0.0;
`;

export const fragmentExtras = `
void emitRGBA(vec4 rgba) {
  float alpha = rgba.a * uBrightnessFactor;
  outputColor += vec4(rgba.rgb * alpha, alpha);
}
void emitRGB(vec3 rgb) {
  emitRGBA(vec4(rgb, 1.0));
}
void emitGrayscale(float value) {
  emitRGB(vec3(value, value, value));
}
void emitTransparent() {
  emitRGBA(vec4(0.0, 0.0, 0.0, 0.0));
}
`
const findStepsShader = `
void main() {
  vec2 normalizedPosition = vNormalizedPosition.xy / vNormalizedPosition.w;
  vec4 nearPointH = uInvModelViewProjectionMatrix * vec4(normalizedPosition, -1.0, 1.0);
  vec4 farPointH = uInvModelViewProjectionMatrix * vec4(normalizedPosition, 1.0, 1.0);
  vec3 nearPoint = nearPointH.xyz / nearPointH.w;
  vec3 farPoint = farPointH.xyz / farPointH.w;
  vec3 rayVector = farPoint - nearPoint;
  vec3 boxStart = max(uLowerClipBound, uTranslation);
  vec3 boxEnd = min(boxStart + uChunkDataSize, uUpperClipBound);
  float intersectStart = uNearLimitFraction;
  float intersectEnd = uFarLimitFraction;
  for (int i = 0; i < 3; ++i) {
    float startPt = nearPoint[i];
    float endPt = farPoint[i];
    float boxLower = boxStart[i];
    float boxUpper = boxEnd[i];
    float r = rayVector[i];
    float startFraction;
    float endFraction;
    if (startPt >= boxLower && startPt <= boxUpper) {
      startFraction = 0.0;
    } else {
      startFraction = min((boxLower - startPt) / r, (boxUpper - startPt) / r);
    }
    if (endPt >= boxLower && endPt <= boxUpper) {
      endFraction = 1.0;
    } else {
      endFraction = max((boxLower - startPt) / r, (boxUpper - startPt) / r);
    }
    intersectStart = max(intersectStart, startFraction);
    intersectEnd = min(intersectEnd, endFraction);
  }
  float stepSize = (uFarLimitFraction - uNearLimitFraction) / float(uMaxSteps - 1);
  int startStep = int(floor((intersectStart - uNearLimitFraction) / stepSize));
  int endStep = min(uMaxSteps, int(floor((intersectEnd - uNearLimitFraction) / stepSize)) + 1);
`;

const doColorShader = `
  outputColor = vec4(0, 0, 0, 0);
  for (int step = startStep; step < endStep; ++step) {
    vec3 position = mix(nearPoint, farPoint, uNearLimitFraction + float(step) * stepSize);
    curChunkPosition = position - uTranslation;
    userMain();
  }
  emit(outputColor, 0u);
}
`;

export const userDefinedFragmentShader = findStepsShader + doColorShader;