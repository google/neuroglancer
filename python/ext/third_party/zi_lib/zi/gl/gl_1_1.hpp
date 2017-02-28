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

#ifndef ZI_GL_GL_1_1_HPP
#define ZI_GL_GL_1_1_HPP 1

#include <zi/gl/detail/types.hpp>

#include <zi/gl/detail/gl_prefix.hpp>

namespace zi {
namespace gl {

static const int proxy_texture_1d                      = 0x8063;
static const int proxy_texture_2d                      = 0x8064;
static const int texture_priority                      = 0x8066;
static const int texture_resident                      = 0x8067;
static const int texture_binding_1d                    = 0x8068;
static const int texture_binding_2d                    = 0x8069;
static const int texture_internal_format               = 0x1003;
static const int alpha4                                = 0x803b;
static const int alpha8                                = 0x803c;
static const int alpha12                               = 0x803d;
static const int alpha16                               = 0x803e;
static const int luminance4                            = 0x803f;
static const int luminance8                            = 0x8040;
static const int luminance12                           = 0x8041;
static const int luminance16                           = 0x8042;
static const int luminance4_alpha4                     = 0x8043;
static const int luminance6_alpha2                     = 0x8044;
static const int luminance8_alpha8                     = 0x8045;
static const int luminance12_alpha4                    = 0x8046;
static const int luminance12_alpha12                   = 0x8047;
static const int luminance16_alpha16                   = 0x8048;
static const int intensity                             = 0x8049;
static const int intensity4                            = 0x804a;
static const int intensity8                            = 0x804b;
static const int intensity12                           = 0x804c;
static const int intensity16                           = 0x804d;
static const int r3_g3_b2                              = 0x2a10;
static const int rgb4                                  = 0x804f;
static const int rgb5                                  = 0x8050;
static const int rgb8                                  = 0x8051;
static const int rgb10                                 = 0x8052;
static const int rgb12                                 = 0x8053;
static const int rgb16                                 = 0x8054;
static const int rgba2                                 = 0x8055;
static const int rgba4                                 = 0x8056;
static const int rgb5_a1                               = 0x8057;
static const int rgba8                                 = 0x8058;
static const int rgb10_a2                              = 0x8059;
static const int rgba12                                = 0x805a;
static const int rgba16                                = 0x805b;
static const int client_pixel_store_bit                = 0x00000001;
static const int client_vertex_array_bit               = 0x00000002;
static const int all_client_attrib_bits                = 0xffffffff;
static const int client_all_attrib_bits                = 0xffffffff;


/*
 * Miscellaneous
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glEnableClientState( gl_enum cap );
ZI_GLAPI void ZI_GLAPI_ENTRY glDisableClientState( gl_enum cap );
ZI_GLAPI void ZI_GLAPI_ENTRY glPushClientAttrib( gl_bitfield mask );
ZI_GLAPI void ZI_GLAPI_ENTRY glPopClientAttrib( void );

/*
 * Drawing Functions
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexub( gl_ubyte c );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexubv( const gl_ubyte *c );

/*
 * Vertex Arrays
 */

ZI_GLAPI void ZI_GLAPI_ENTRY glVertexPointer( gl_int size, gl_enum type, gl_sizei stride, const gl_void *ptr );
ZI_GLAPI void ZI_GLAPI_ENTRY glNormalPointer( gl_enum type, gl_sizei stride, const gl_void *ptr );
ZI_GLAPI void ZI_GLAPI_ENTRY glColorPointer( gl_int size, gl_enum type, gl_sizei stride, const gl_void *ptr );
ZI_GLAPI void ZI_GLAPI_ENTRY glIndexPointer( gl_enum type, gl_sizei stride, const gl_void *ptr );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexCoordPointer( gl_int size, gl_enum type, gl_sizei stride, const gl_void *ptr );
ZI_GLAPI void ZI_GLAPI_ENTRY glEdgeFlagPointer( gl_sizei stride, const gl_void *ptr );
ZI_GLAPI void ZI_GLAPI_ENTRY glGetPointerv( gl_enum pname, gl_void **params );
ZI_GLAPI void ZI_GLAPI_ENTRY glArrayElement( gl_int i );
ZI_GLAPI void ZI_GLAPI_ENTRY glDrawArrays( gl_enum mode, gl_int first, gl_sizei count );
ZI_GLAPI void ZI_GLAPI_ENTRY glDrawElements( gl_enum mode, gl_sizei count, gl_enum type, const gl_void *indices );
ZI_GLAPI void ZI_GLAPI_ENTRY glInterleavedArrays( gl_enum format, gl_sizei stride, const gl_void *pointer );

/*
 * Texture mapping
 */
ZI_GLAPI void ZI_GLAPI_ENTRY glGenTextures( gl_sizei n, gl_uint *textures );
ZI_GLAPI void ZI_GLAPI_ENTRY glDeleteTextures( gl_sizei n, const gl_uint *textures);
ZI_GLAPI void ZI_GLAPI_ENTRY glBindTexture( gl_enum target, gl_uint texture );
ZI_GLAPI void ZI_GLAPI_ENTRY glPrioritizeTextures( gl_sizei n, const gl_uint *textures, const gl_clampf *priorities );
ZI_GLAPI gl_boolean ZI_GLAPI_ENTRY glAreTexturesResident( gl_sizei n, const gl_uint *textures, gl_boolean *residences );
ZI_GLAPI gl_boolean ZI_GLAPI_ENTRY glIsTexture( gl_uint texture );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexSubImage1D( gl_enum target, gl_int level, gl_int xoffset, gl_sizei width, gl_enum format, gl_enum type, const gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glTexSubImage2D( gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_sizei width, gl_sizei height, gl_enum format, gl_enum type, const gl_void *pixels );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyTexImage1D( gl_enum target, gl_int level, gl_enum internalformat, gl_int x, gl_int y, gl_sizei width, gl_int border );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyTexImage2D( gl_enum target, gl_int level, gl_enum internalformat, gl_int x, gl_int y, gl_sizei width, gl_sizei height, gl_int border );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyTexSubImage1D( gl_enum target, gl_int level, gl_int xoffset, gl_int x, gl_int y, gl_sizei width );
ZI_GLAPI void ZI_GLAPI_ENTRY glCopyTexSubImage2D( gl_enum target, gl_int level, gl_int xoffset, gl_int yoffset, gl_int x, gl_int y, gl_sizei width, gl_sizei height );


} // namespace gl
} // namespace zi

#include <zi/gl/detail/gl_suffix.hpp>

#endif
