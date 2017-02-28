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

#ifndef ZI_GL_DETAIL_TYPES_HPP
#define ZI_GL_DETAIL_TYPES_HPP 1

namespace zi {
namespace gl {

typedef unsigned int    gl_enum    ;
typedef unsigned char   gl_boolean ;
typedef unsigned int    gl_bitfield;
typedef void            gl_void    ;
typedef char            gl_byte    ;
typedef short           gl_short   ;
typedef int             gl_int     ;
typedef unsigned char   gl_ubyte   ;
typedef unsigned short  gl_ushort  ;
typedef unsigned int    gl_uint    ;
typedef int             gl_sizei   ;
typedef float           gl_float   ;
typedef float           gl_clampf  ;
typedef double          gl_double  ;
typedef double          gl_clampd  ;

} // namespace gl
} // namespace zi

#endif
