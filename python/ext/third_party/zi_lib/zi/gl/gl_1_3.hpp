//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_GL_GL_1_3_HPP
#define ZI_GL_GL_1_3_HPP 1

#include <zi/gl/detail/types.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

namespace zi {
namespace gl {

static const int texture0                             = 0x84c0;
static const int texture1                             = 0x84c1;
static const int texture2                             = 0x84c2;
static const int texture3                             = 0x84c3;
static const int texture4                             = 0x84c4;
static const int texture5                             = 0x84c5;
static const int texture6                             = 0x84c6;
static const int texture7                             = 0x84c7;
static const int texture8                             = 0x84c8;
static const int texture9                             = 0x84c9;
static const int texture10                            = 0x84ca;
static const int texture11                            = 0x84cb;
static const int texture12                            = 0x84cc;
static const int texture13                            = 0x84cd;
static const int texture14                            = 0x84ce;
static const int texture15                            = 0x84cf;
static const int texture16                            = 0x84d0;
static const int texture17                            = 0x84d1;
static const int texture18                            = 0x84d2;
static const int texture19                            = 0x84d3;
static const int texture20                            = 0x84d4;
static const int texture21                            = 0x84d5;
static const int texture22                            = 0x84d6;
static const int texture23                            = 0x84d7;
static const int texture24                            = 0x84d8;
static const int texture25                            = 0x84d9;
static const int texture26                            = 0x84da;
static const int texture27                            = 0x84db;
static const int texture28                            = 0x84dc;
static const int texture29                            = 0x84dd;
static const int texture30                            = 0x84de;
static const int texture31                            = 0x84df;
static const int active_texture                       = 0x84e0;
static const int client_active_texture                = 0x84e1;
static const int max_texture_units                    = 0x84e2;

static const int normal_map                           = 0x8511;
static const int reflection_map                       = 0x8512;
static const int texture_cube_map                     = 0x8513;
static const int texture_binding_cube_map             = 0x8514;
static const int texture_cube_map_positive_x          = 0x8515;
static const int texture_cube_map_negative_x          = 0x8516;
static const int texture_cube_map_positive_y          = 0x8517;
static const int texture_cube_map_negative_y          = 0x8518;
static const int texture_cube_map_positive_z          = 0x8519;
static const int texture_cube_map_negative_z          = 0x851a;
static const int proxy_texture_cube_map               = 0x851b;
static const int max_cube_map_texture_size            = 0x851c;

static const int compressed_alpha                     = 0x84e9;
static const int compressed_luminance                 = 0x84ea;
static const int compressed_luminance_alpha           = 0x84eb;
static const int compressed_intensity                 = 0x84ec;
static const int compressed_rgb                       = 0x84ed;
static const int compressed_rgba                      = 0x84ee;
static const int texture_compression_hint             = 0x84ef;
static const int texture_compressed_image_size        = 0x86a0;
static const int texture_compressed                   = 0x86a1;
static const int num_compressed_texture_formats       = 0x86a2;
static const int compressed_texture_formats           = 0x86a3;

static const int multisample                          = 0x809d;
static const int sample_alpha_to_coverage             = 0x809e;
static const int sample_alpha_to_one                  = 0x809f;
static const int sample_coverage                      = 0x80a0;
static const int sample_buffers                       = 0x80a8;
static const int samples                              = 0x80a9;
static const int sample_coverage_value                = 0x80aa;
static const int sample_coverage_invert               = 0x80ab;
static const int multisample_bit                      = 0x20000000;

static const int transpose_modelview_matrix           = 0x84e3;
static const int transpose_projection_matrix          = 0x84e4;
static const int transpose_texture_matrix             = 0x84e5;
static const int transpose_color_matrix               = 0x84e6;

static const int combine                              = 0x8570;
static const int combine_rgb                          = 0x8571;
static const int combine_alpha                        = 0x8572;
static const int source0_rgb                          = 0x8580;
static const int source1_rgb                          = 0x8581;
static const int source2_rgb                          = 0x8582;
static const int source0_alpha                        = 0x8588;
static const int source1_alpha                        = 0x8589;
static const int source2_alpha                        = 0x858a;
static const int operand0_rgb                         = 0x8590;
static const int operand1_rgb                         = 0x8591;
static const int operand2_rgb                         = 0x8592;
static const int operand0_alpha                       = 0x8598;
static const int operand1_alpha                       = 0x8599;
static const int operand2_alpha                       = 0x859a;
static const int rgb_scale                            = 0x8573;
static const int add_signed                           = 0x8574;
static const int interpolate                          = 0x8575;
static const int subtract                             = 0x84e7;
static const int constant                             = 0x8576;
static const int primary_color                        = 0x8577;
static const int previous                             = 0x8578;

static const int dot3_rgb                             = 0x86ae;
static const int dot3_rgba                            = 0x86af;
static const int clamp_to_border                      = 0x812D;

ZI_GLAPI void ZI_GLAPI_ENTRY glActiveTexture( gl_enum texture );
ZI_GLAPI void ZI_GLAPI_ENTRY glClientActiveTexture( gl_enum texture );
ZI_GLAPI void ZI_GLAPI_ENTRY glCompressedTexImage1D( gl_enum target, gl_int level, gl_enum internalformat, gl_sizei width, gl_int border, gl_sizei imageSize, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glCompressedTexImage2D( gl_enum target, gl_int level, gl_enum internalformat, gl_sizei width, gl_sizei height, gl_int border, gl_sizei imageSize, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glCompressedTexImage3D( gl_enum target, gl_int level, gl_enum internalformat, gl_sizei width, gl_sizei height, gl_sizei depth, gl_int border, gl_sizei imageSize, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glCompressedTexSubImage1D( gl_enum target, gl_int level, gl_int xoffset, gl_sizei width, gl_enum format, gl_sizei imageSize, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glCompressedTexSubImage2D( gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_sizei width, gl_sizei height, gl_enum format, gl_sizei imageSize, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glCompressedTexSubImage3D( gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int zoffset, gl_sizei width, gl_sizei height, gl_sizei depth, gl_enum format, gl_sizei imageSize, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetCompressedTexImage( gl_enum target, gl_int lod, gl_void *img );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1d( gl_enum target, gl_double s );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1dv( gl_enum target, const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1f( gl_enum target, gl_float s );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1fv( gl_enum target, const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1i( gl_enum target, gl_int s );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1iv( gl_enum target, const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1s( gl_enum target, gl_short s );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord1sv( gl_enum target, const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2d( gl_enum target, gl_double s, gl_double t );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2dv( gl_enum target, const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2f( gl_enum target, gl_float s, gl_float t );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2fv( gl_enum target, const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2i( gl_enum target, gl_int s, gl_int t );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2iv( gl_enum target, const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2s( gl_enum target, gl_short s, gl_short t );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord2sv( gl_enum target, const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3d( gl_enum target, gl_double s, gl_double t, gl_double r );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3dv( gl_enum target, const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3f( gl_enum target, gl_float s, gl_float t, gl_float r );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3fv( gl_enum target, const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3i( gl_enum target, gl_int s, gl_int t, gl_int r );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3iv( gl_enum target, const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3s( gl_enum target, gl_short s, gl_short t, gl_short r );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord3sv( gl_enum target, const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4d( gl_enum target, gl_double s, gl_double t, gl_double r, gl_double q );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4dv( gl_enum target, const gl_double *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4f( gl_enum target, gl_float s, gl_float t, gl_float r, gl_float q );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4fv( gl_enum target, const gl_float *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4i( gl_enum target, gl_int s, gl_int t, gl_int r, gl_int q );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4iv( gl_enum target, const gl_int *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4s( gl_enum target, gl_short s, gl_short t, gl_short r, gl_short q );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultiTexCoord4sv( gl_enum target, const gl_short *v );
ZI_GLAPI void ZI_GLAPI_ENTRY glLoadTransposeMatrixd( const gl_double m[16] );
ZI_GLAPI void ZI_GLAPI_ENTRY glLoadTransposeMatrixf( const gl_float m[16] );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultTransposeMatrixd( const gl_double m[16] );
ZI_GLAPI void ZI_GLAPI_ENTRY glMultTransposeMatrixf( const gl_float m[16] );
ZI_GLAPI void ZI_GLAPI_ENTRY glSampleCoverage( gl_clampf value, gl_boolean invert );

//typedef void (APIENTRYP PFNgl_ACTIVETEXTUREPROC) (gl_enum texture);
//typedef void (APIENTRYP PFNgl_SAMPLECOVERAGEPROC) (gl_clampf value, gl_boolean invert);
//typedef void (APIENTRYP PFNgl_COMPRESSEDTEXIMAGE3DPROC) (gl_enum target, gl_int level, gl_enum internalformat, gl_sizei width, gl_sizei height, gl_sizei depth, gl_int border, gl_sizei imageSize, const gl_void *data);
//typedef void (APIENTRYP PFNgl_COMPRESSEDTEXIMAGE2DPROC) (gl_enum target, gl_int level, gl_enum internalformat, gl_sizei width, gl_sizei height, gl_int border, gl_sizei imageSize, const gl_void *data);
//typedef void (APIENTRYP PFNgl_COMPRESSEDTEXIMAGE1DPROC) (gl_enum target, gl_int level, gl_enum internalformat, gl_sizei width, gl_int border, gl_sizei imageSize, const gl_void *data);
//typedef void (APIENTRYP PFNgl_COMPRESSEDTEXSUBIMAGE3DPROC) (gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int zoffset, gl_sizei width, gl_sizei height, gl_sizei depth, gl_enum format, gl_sizei imageSize, const gl_void *data);
//typedef void (APIENTRYP PFNgl_COMPRESSEDTEXSUBIMAGE2DPROC) (gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_sizei width, gl_sizei height, gl_enum format, gl_sizei imageSize, const gl_void *data);
//typedef void (APIENTRYP PFNgl_COMPRESSEDTEXSUBIMAGE1DPROC) (gl_enum target, gl_int level, gl_int xoffset, gl_sizei width, gl_enum format, gl_sizei imageSize, const gl_void *data);
//typedef void (APIENTRYP PFNgl_GETCOMPRESSEDTEXIMAGEPROC) (gl_enum target, gl_int level, gl_void *img);





} // namespace gl
} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#endif
