/**
 * @license
 * Copyright 2016 Google Inc.
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

/**
 * @file These typings were generated by manually editing the output of the closure2ts tool from
 * https://github.com/fivetran/typescript-closure-tools applied to nifti-reader-js version 0.5.3.
 */

declare module "nifti-reader-js" {
  class NIFTI1 {
    // data type codes
    static TYPE_NONE: number;
    static TYPE_BINARY: number;
    static TYPE_UINT8: number;
    static TYPE_INT16: number;
    static TYPE_INT32: number;
    static TYPE_FLOAT32: number;
    static TYPE_COMPLEX64: number;
    static TYPE_FLOAT64: number;
    static TYPE_RGB24: number;
    static TYPE_INT8: number;
    static TYPE_UINT16: number;
    static TYPE_UINT32: number;
    static TYPE_INT64: number;
    static TYPE_UINT64: number;
    static TYPE_FLOAT128: number;
    static TYPE_COMPLEX128: number;
    static TYPE_COMPLEX256: number;

    // transform codes
    static XFORM_UNKNOWN: number;
    static XFORM_SCANNER_ANAT: number;
    static XFORM_ALIGNED_ANAT: number;
    static XFORM_TALAIRACH: number;
    static XFORM_MNI_152: number;

    // unit codes
    static SPATIAL_UNITS_MASK: number;
    static TEMPORAL_UNITS_MASK: number;
    static UNITS_UNKNOWN: number;
    static UNITS_METER: number;
    static UNITS_MM: number;
    static UNITS_MICRON: number;
    static UNITS_SEC: number;
    static UNITS_MSEC: number;
    static UNITS_USEC: number;
    static UNITS_HZ: number;
    static UNITS_PPM: number;
    static UNITS_RADS: number;

    littleEndian: boolean;
    dim_info: number;
    dims: number[];
    intent_p1: number;
    intent_p2: number;
    intent_p3: number;
    intent_code: number;
    datatypeCode: number;
    numBitsPerVoxel: number;
    slice_start: number;
    slice_end: number;
    slice_code: number;
    pixDims: number[];
    vox_offset: number;
    scl_slope: number;
    scl_inter: number;
    xyzt_units: number;
    cal_max: number;
    cal_min: number;
    slice_duration: number;
    tooffset: number;
    description: string;
    aux_file: string;
    intent_name: string;
    qform_code: number;
    sform_code: number;
    quatern_b: number;
    quatern_c: number;
    quatern_d: number;
    qoffset_x: number;
    qoffset_y: number;
    qoffset_z: number;
    affine: number[][];
    magic: string;

    /**
     * Indicates if hdr/img format.
     */
    isHDR: boolean;

    extensionFlag: number[];
    extensionSize: number;
    extensionCode: number;

    /**
     * Reads the header data.
     */
    readHeader(data: ArrayBuffer): void;

    /**
     * Returns a formatted string of header fields.
     */
    toFormattedString(): string;

    /**
     * Returns a human-readable string of datatype.
     */
    getDatatypeCodeString(code: number): string;

    /**
     * Returns a human-readable string of transform type.
     */
    getTransformCodeString(code: number): string;

    /**
     * Returns a human-readable string of spatial and temporal units.
     */
    getUnitsCodeString(code: number): string;

    /**
     * Returns the qform matrix.
     */
    getQformMat(): number[][];

    /**
     * Converts qform to an affine.  (See
     * http://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1_io.c)
     */
    convertNiftiQFormToNiftiSForm(
      qb: number,
      qc: number,
      qd: number,
      qx: number,
      qy: number,
      qz: number,
      dx: number,
      dy: number,
      dz: number,
      qfac: number,
    ): number[][];

    /**
     * Converts sform to an orientation string (e.g., XYZ+--).  (See
     * http://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1_io.c)
     */
    convertNiftiSFormToNEMA(R: number[][]): string;

    /**
     * Returns the byte index of the extension.
     */
    getExtensionLocation(): number;

    /**
     * Returns the extension size.
     */
    getExtensionSize(data: DataView): number;

    /**
     * Returns the extension code.
     */
    getExtensionCode(data: DataView): number;
  }

  /**
   * Decoded NIFTI2 header.
   */
  class NIFTI2 {
    littleEndian: boolean;
    dim_info: number;
    dims: number[];
    intent_p1: number;
    intent_p2: number;
    intent_p3: number;
    intent_code: number;
    datatypeCode: number;
    numBitsPerVoxel: number;
    slice_start: number;
    slice_end: number;
    slice_code: number;
    pixDims: number[];
    vox_offset: number;
    scl_slope: number;
    scl_inter: number;
    xyzt_units: number;
    cal_max: number;
    cal_min: number;
    slice_duration: number;
    tooffset: number;
    description: string;
    aux_file: string;
    intent_name: string;
    qform_code: number;
    sform_code: number;
    quatern_b: number;
    quatern_c: number;
    quatern_d: number;
    qoffset_x: number;
    qoffset_y: number;
    qoffset_z: number;
    affine: number[][];
    magic: string;
    extensionFlag: number[];

    /**
     * Reads the header data.
     */
    readHeader(data: ArrayBuffer): void;

    /**
     * Returns a formatted string of header fields.
     */
    toFormattedString(): string;

    /**
     * Returns the byte index of the extension.
     */
    getExtensionLocation(): number;

    /**
     * Returns the extension size.
     */
    getExtensionSize(data: DataView): number;

    /**
     * Returns the extension code.
     */
    getExtensionCode(data: DataView): number;

    /**
     * Returns a human-readable string of datatype.
     */
    getDatatypeCodeString(code: number): string;

    /**
     * Returns a human-readable string of transform type.
     */
    getTransformCodeString(code: number): string;

    /**
     * Returns a human-readable string of spatial and temporal units.
     */
    getUnitsCodeString(code: number): string;

    /**
     * Returns the qform matrix.
     */
    getQformMat: any /*missing*/;

    /**
     * Converts qform to an affine.  (See
     * http://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1_io.c)
     */
    convertNiftiQFormToNiftiSForm(
      qb: number,
      qc: number,
      qd: number,
      qx: number,
      qy: number,
      qz: number,
      dx: number,
      dy: number,
      dz: number,
      qfac: number,
    ): number[][];

    /**
     * Converts sform to an orientation string (e.g., XYZ+--).  (See
     * http://nifti.nimh.nih.gov/pub/dist/src/niftilib/nifti1_io.c)
     */
    convertNiftiSFormToNEMA(R: number[][]): string;
  }

  /**
   * Returns true if this data represents a NIFTI-1 header.
   */
  function isNIFTI1(data: ArrayBuffer): boolean;

  /**
   * Returns true if this data represents a NIFTI-2 header.
   */
  function isNIFTI2(data: ArrayBuffer): boolean;

  /**
   * Returns true if this data represents a NIFTI header.
   */
  function isNIFTI(data: ArrayBuffer): boolean;

  /**
   * Returns true if this data is GZIP compressed.
   */
  function isCompressed(data: ArrayBuffer): boolean;

  /**
   * Returns decompressed data.
   */
  function decompress(data: ArrayBuffer): ArrayBuffer;

  /**
   * Reads and returns the header object.
   */
  function readHeader(data: ArrayBuffer): NIFTI1 | NIFTI2 | null;

  /**
   * Returns true if this header contains an extension.
   */
  function hasExtension(header: NIFTI1 | NIFTI2): boolean;

  /**
   * Returns the image data.
   */
  function readImage(header: NIFTI1 | NIFTI2, data: ArrayBuffer): ArrayBuffer;

  /**
   * Returns the extension data (including extension header).
   */
  function readExtension(
    header: NIFTI1 | NIFTI2,
    data: ArrayBuffer,
  ): ArrayBuffer;

  /**
   * Returns the extension data.
   */
  function readExtensionData(
    header: NIFTI1 | NIFTI2,
    data: ArrayBuffer,
  ): ArrayBuffer;
}
