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

#ifndef ZI_GL_GL_1_2_HPP
#define ZI_GL_GL_1_2_HPP 1

#include <zi/gl/detail/types.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

namespace zi {
namespace gl {

static const int rescale_normal                = 0x803a;
static const int clamp_to_edge                 = 0x812f;
static const int max_elements_vertices         = 0x80e8;
static const int max_elements_indices          = 0x80e9;
static const int bgr                           = 0x80e0;
static const int bgra                          = 0x80e1;
static const int unsigned_byte_3_3_2           = 0x8032;
static const int unsigned_byte_2_3_3_rev       = 0x8362;
static const int unsigned_short_5_6_5          = 0x8363;
static const int unsigned_short_5_6_5_rev      = 0x8364;
static const int unsigned_short_4_4_4_4        = 0x8033;
static const int unsigned_short_4_4_4_4_rev    = 0x8365;
static const int unsigned_short_5_5_5_1        = 0x8034;
static const int unsigned_short_1_5_5_5_rev    = 0x8366;
static const int unsigned_int_8_8_8_8          = 0x8035;
static const int unsigned_int_8_8_8_8_rev      = 0x8367;
static const int unsigned_int_10_10_10_2       = 0x8036;
static const int unsigned_int_2_10_10_10_rev   = 0x8368;
static const int light_model_color_control     = 0x81f8;
static const int single_color                  = 0x81f9;
static const int separate_specular_color       = 0x81fa;
static const int texture_min_lod               = 0x813a;
static const int texture_max_lod               = 0x813b;
static const int texture_base_level            = 0x813c;
static const int texture_max_level             = 0x813d;
static const int smooth_point_size_range       = 0x0b12;
static const int smooth_point_size_granularity = 0x0b13;
static const int smooth_line_width_range       = 0x0b22;
static const int smooth_line_width_granularity = 0x0b23;
static const int aliased_point_size_range      = 0x846d;
static const int aliased_line_width_range      = 0x846e;
static const int pack_skip_images              = 0x806b;
static const int pack_image_height             = 0x806c;
static const int unpack_skip_images            = 0x806d;
static const int unpack_image_height           = 0x806e;
static const int texture_3d                    = 0x806f;
static const int proxy_texture_3d              = 0x8070;
static const int texture_depth                 = 0x8071;
static const int texture_wrap_r                = 0x8072;
static const int max_3d_texture_size           = 0x8073;
static const int texture_binding_3d            = 0x806a;

ZI_GLAPI void ZI_GLAPI_ENTRY glDrawRangeElements( gl_enum mode, gl_uint start, gl_uint end, gl_sizei count, gl_enum type, const gl_void *indices );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexImage3D( gl_enum target, gl_int level, gl_int internalFormat, gl_sizei width, gl_sizei height, gl_sizei depth, gl_int border, gl_enum format, gl_enum type, const gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexSubImage3D( gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int zoffset, gl_sizei width, gl_sizei height, gl_sizei depth, gl_enum format, gl_enum type, const gl_void *pixels);
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyTexSubImage3D( gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int zoffset, gl_int x, gl_int y, gl_sizei width, gl_sizei height );

//typedef void (APIENTRYP PFNGLDRAWRANGEELEMENTSPROC) (gl_enum mode, gl_uint start, gl_uint end, gl_sizei count, gl_enum type, const gl_void *indices);
//typedef void (APIENTRYP PFNGLTEXIMAGE3DPROC) (gl_enum target, gl_int level, gl_int internalformat, gl_sizei width, gl_sizei height, gl_sizei depth, gl_int border, gl_enum format, gl_enum type, const gl_void *pixels);
//typedef void (APIENTRYP PFNGLTEXSUBIMAGE3DPROC) (gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int zoffset, gl_sizei width, gl_sizei height, gl_sizei depth, gl_enum format, gl_enum type, const gl_void *pixels);
//typedef void (APIENTRYP PFNGLCOPYTEXSUBIMAGE3DPROC) (gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int zoffset, gl_int x, gl_int y, gl_sizei width, gl_sizei height);

} // namespace gl
} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#endif
