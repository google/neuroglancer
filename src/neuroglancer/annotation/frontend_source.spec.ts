/**
 * @license
 * Copyright 2020 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Annotation, AnnotationId, AnnotationPropertySerializer, AnnotationPropertySpec, AnnotationSerializer, AnnotationType, makeAnnotationPropertySerializers} from 'neuroglancer/annotation';
import {deleteAnnotation, makeTemporaryChunk, updateAnnotation} from 'neuroglancer/annotation/frontend_source';

class UpdateTester {
  annotations: Annotation[] = [];
  incrementalChunk = makeTemporaryChunk();
  propertySerializers: AnnotationPropertySerializer[];
  constructor(rank: number, propertySpecs: readonly Readonly<AnnotationPropertySpec>[]) {
    this.propertySerializers = makeAnnotationPropertySerializers(rank, propertySpecs);
  }
  compare() {
    const serializer = new AnnotationSerializer(this.propertySerializers);
    for (const annotation of this.annotations) serializer.add(annotation);
    const direct = serializer.serialize();
    const incremental = this.incrementalChunk.data!.serializedAnnotations;
    expect(direct.data).toEqual(incremental.data);
    expect(direct.typeToIds).toEqual(incremental.typeToIds);
    expect(direct.typeToOffset).toEqual(incremental.typeToOffset);
    expect(direct.typeToIdMaps).toEqual(incremental.typeToIdMaps);
  }
  update(annotation: Annotation) {
    const index = this.annotations.findIndex(x => x.id === annotation.id);
    if (index === -1) {
      this.annotations.push(annotation);
    } else {
      this.annotations[index] = annotation;
    }
    updateAnnotation(this.incrementalChunk.data!, annotation, this.propertySerializers);
    this.compare();
  }
  delete(id: AnnotationId, type: AnnotationType) {
    const index = this.annotations.findIndex(x => x.id === id);
    expect(index).toBeGreaterThan(-1);
    expect(this.annotations[index].type).toEqual(type);
    this.annotations.splice(index, 1);
    expect(deleteAnnotation(this.incrementalChunk.data!, type, id, this.propertySerializers))
        .toBe(true);
    this.compare();
  }
}

describe('updateAnnotations', () => {
  it('rank 1', () => {
    const tester = new UpdateTester(1, []);
    tester.compare();

    tester.update(
        {id: 'a', type: AnnotationType.POINT, point: Float32Array.of(1, 2), properties: []});
    tester.delete('a', AnnotationType.POINT);
    tester.update(
        {id: 'a', type: AnnotationType.POINT, point: Float32Array.of(1, 2), properties: []});

    tester.update(
        {id: 'b', type: AnnotationType.POINT, point: Float32Array.of(2, 3), properties: []});

    tester.update({
      id: 'c',
      type: AnnotationType.LINE,
      pointA: Float32Array.of(2, 3),
      pointB: Float32Array.of(4, 5),
      properties: []
    });

    tester.update({
      id: 'd',
      type: AnnotationType.LINE,
      pointA: Float32Array.of(6, 7),
      pointB: Float32Array.of(8, 9),
      properties: []
    });

    tester.delete('a', AnnotationType.POINT);
    tester.update({
      id: 'e',
      type: AnnotationType.ELLIPSOID,
      center: Float32Array.of(6, 7),
      radii: Float32Array.of(8, 9),
      properties: []
    });
    tester.update({
      id: 'f',
      type: AnnotationType.AXIS_ALIGNED_BOUNDING_BOX,
      pointA: Float32Array.of(6, 7),
      pointB: Float32Array.of(8, 9),
      properties: []
    });
    tester.delete('f', AnnotationType.AXIS_ALIGNED_BOUNDING_BOX);
  });
});
