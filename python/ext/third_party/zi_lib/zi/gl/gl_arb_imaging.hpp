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

#ifndef ZI_GL_GL_ARB_IMAGING_HPP
#define ZI_GL_GL_ARB_IMAGING_HPP 1

#include <zi/gl/detail/types.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

namespace zi {
namespace gl {

static const int constant_color                       = 0x8001;
static const int one_minus_constant_color             = 0x8002;
static const int constant_alpha                       = 0x8003;
static const int one_minus_constant_alpha             = 0x8004;
static const int blend_color                          = 0x8005;
static const int func_add                             = 0x8006;
static const int min                                  = 0x8007;
static const int max                                  = 0x8008;
static const int blend_equation                       = 0x8009;
static const int func_subtract                        = 0x800a;
static const int func_reverse_subtract                = 0x800b;
static const int convolution_1d                       = 0x8010;
static const int convolution_2d                       = 0x8011;
static const int separable_2d                         = 0x8012;
static const int convolution_border_mode              = 0x8013;
static const int convolution_filter_scale             = 0x8014;
static const int convolution_filter_bias              = 0x8015;
static const int reduce                               = 0x8016;
static const int convolution_format                   = 0x8017;
static const int convolution_width                    = 0x8018;
static const int convolution_height                   = 0x8019;
static const int max_convolution_width                = 0x801a;
static const int max_convolution_height               = 0x801b;
static const int post_convolution_red_scale           = 0x801c;
static const int post_convolution_green_scale         = 0x801d;
static const int post_convolution_blue_scale          = 0x801e;
static const int post_convolution_alpha_scale         = 0x801f;
static const int post_convolution_red_bias            = 0x8020;
static const int post_convolution_green_bias          = 0x8021;
static const int post_convolution_blue_bias           = 0x8022;
static const int post_convolution_alpha_bias          = 0x8023;
static const int histogram                            = 0x8024;
static const int proxy_histogram                      = 0x8025;
static const int histogram_width                      = 0x8026;
static const int histogram_format                     = 0x8027;
static const int histogram_red_size                   = 0x8028;
static const int histogram_green_size                 = 0x8029;
static const int histogram_blue_size                  = 0x802a;
static const int histogram_alpha_size                 = 0x802b;
static const int histogram_luminance_size             = 0x802c;
static const int histogram_sink                       = 0x802d;
static const int minmax                               = 0x802e;
static const int minmax_format                        = 0x802f;
static const int minmax_sink                          = 0x8030;
static const int table_too_large                      = 0x8031;
static const int color_matrix                         = 0x80b1;
static const int color_matrix_stack_depth             = 0x80b2;
static const int max_color_matrix_stack_depth         = 0x80b3;
static const int post_color_matrix_red_scale          = 0x80b4;
static const int post_color_matrix_green_scale        = 0x80b5;
static const int post_color_matrix_blue_scale         = 0x80b6;
static const int post_color_matrix_alpha_scale        = 0x80b7;
static const int post_color_matrix_red_bias           = 0x80b8;
static const int post_color_matrix_green_bias         = 0x80b9;
static const int post_color_matrix_blue_bias          = 0x80ba;
static const int post_color_matrix_alpha_bias         = 0x80bb;
static const int color_table                          = 0x80d0;
static const int post_convolution_color_table         = 0x80d1;
static const int post_color_matrix_color_table        = 0x80d2;
static const int proxy_color_table                    = 0x80d3;
static const int proxy_post_convolution_color_table   = 0x80d4;
static const int proxy_post_color_matrix_color_table  = 0x80d5;
static const int color_table_scale                    = 0x80d6;
static const int color_table_bias                     = 0x80d7;
static const int color_table_format                   = 0x80d8;
static const int color_table_width                    = 0x80d9;
static const int color_table_red_size                 = 0x80da;
static const int color_table_green_size               = 0x80db;
static const int color_table_blue_size                = 0x80dc;
static const int color_table_alpha_size               = 0x80dd;
static const int color_table_luminance_size           = 0x80de;
static const int color_table_intensity_size           = 0x80df;
static const int constant_border                      = 0x8151;
static const int replicate_border                     = 0x8153;
static const int convolution_border_color             = 0x8154;


ZI_GLAPI void ZI_GLAPI_ENTRY glColorTable( gl_enum target, gl_enum internalformat, gl_sizei width, gl_enum format, gl_enum type, const gl_void *table );
ZI_GLAPI void ZI_GLAPI_ENTRY glColorSubTable( gl_enum target, gl_sizei start, gl_sizei count, gl_enum format, gl_enum type, const gl_void *data );
ZI_GLAPI void ZI_GLAPI_ENTRY glColorTableParameteriv(gl_enum target, gl_enum pname, const gl_int *params);
ZI_GLAPI void ZI_GLAPI_ENTRY glColorTableParameterfv(gl_enum target, gl_enum pname, const gl_float *params);
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyColorSubTable( gl_enum target, gl_sizei start, gl_int x, gl_int y, gl_sizei width );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyColorTable( gl_enum target, gl_enum internalformat, gl_int x, gl_int y, gl_sizei width );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetColorTable( gl_enum target, gl_enum format, gl_enum type, gl_void *table );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetColorTableParameterfv( gl_enum target, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetColorTableParameteriv( gl_enum target, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glBlendEquation( gl_enum mode );
ZI_GLAPI void ZI_GLAPI_ENTRY glBlendColor( gl_clampf red, gl_clampf green, gl_clampf blue, gl_clampf alpha );
ZI_GLAPI void ZI_GLAPI_ENTRY glHistogram( gl_enum target, gl_sizei width, gl_enum internalformat, gl_boolean sink );
ZI_GLAPI void ZI_GLAPI_ENTRY glResetHistogram( gl_enum target );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetHistogram( gl_enum target, gl_boolean reset, gl_enum format, gl_enum type, gl_void *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetHistogramParameterfv( gl_enum target, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetHistogramParameteriv( gl_enum target, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glMinmax( gl_enum target, gl_enum internalformat, gl_boolean sink );
ZI_GLAPI void ZI_GLAPI_ENTRY glResetMinmax( gl_enum target );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMinmax( gl_enum target, gl_boolean reset, gl_enum format, gl_enum types, gl_void *values );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMinmaxParameterfv( gl_enum target, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetMinmaxParameteriv( gl_enum target, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glConvolutionFilter1D( gl_enum target, gl_enum internalformat, gl_sizei width, gl_enum format, gl_enum type, const gl_void *image );
ZI_GLAPI void ZI_GLAPI_ENTRY glConvolutionFilter2D( gl_enum target, gl_enum internalformat, gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, const gl_void *image );
ZI_GLAPI void ZI_GLAPI_ENTRY glConvolutionParameterf( gl_enum target, gl_enum pname, gl_float params );
ZI_GLAPI void ZI_GLAPI_ENTRY glConvolutionParameterfv( gl_enum target, gl_enum pname, const gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glConvolutionParameteri( gl_enum target, gl_enum pname, gl_int params );
ZI_GLAPI void ZI_GLAPI_ENTRY glConvolutionParameteriv( gl_enum target, gl_enum pname, const gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyConvolutionFilter1D( gl_enum target, gl_enum internalformat, gl_int x, gl_int y, gl_sizei width );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyConvolutionFilter2D( gl_enum target, gl_enum internalformat, gl_int x, gl_int y, gl_sizei width, gl_sizei height);
ZI_GLAPI void ZI_GLAPI_ENTRY glGetConvolutionFilter( gl_enum target, gl_enum format, gl_enum type, gl_void *image );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetConvolutionParameterfv( gl_enum target, gl_enum pname, gl_float *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetConvolutionParameteriv( gl_enum target, gl_enum pname, gl_int *params );
ZI_GLAPI void ZI_GLAPI_ENTRY glSeparableFilter2D( gl_enum target, gl_enum internalformat, gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, const gl_void *row, const gl_void *column );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetSeparableFilter( gl_enum target, gl_enum format, gl_enum type, gl_void *row, gl_void *column, gl_void *span );

//typedef void (APIENTRYP PFNgl_BLENDCOLORPROC) (gl_clampf red, gl_clampf green, gl_clampf blue, gl_clampf alpha);
//typedef void (APIENTRYP PFNgl_BLENDEQUATIONPROC) (gl_enum mode);


} // namespace gl
} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#endif
