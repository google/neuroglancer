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

#if defined( ZI_OS_WINDOWS )
#
#if defined( __MINGW32__ )
#
#  include <_mingw.h>
#
#  if ( __MINGW32_MAJOR_VERSION >= 2 )
#    define  ZI_HAS_POSIX_SUPPORT
#    include <zi/config/posix.hpp>
#  endif
#
#endif
#
#if !defined( WIN64 )
#  if ( defined( _WIN64 ) || defined( __WIN64__ ) || defined( _M_X64 ) )
#    define WIN64
#  endif
#endif
#
#else
#  warning "windows not detected"
#endif
