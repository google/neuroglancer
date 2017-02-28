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

#if defined( ZI_HAS_POSIX_SUPPORT )
#
#include <unistd.h>
#
#if defined( _POSIX_TIMERS ) && ( _POSIX_TIMERS+0 >= 0 )
#  define ZI_HAS_CLOCK_GETTIME
#  define ZI_HAS_NANOSLEEP
#elif defined( _XOPEN_REALTIME ) && ( _XOPEN_REALTIME+0 >= 0 )
#  define ZI_HAS_NANOSLEEP
#endif
#
#
#if defined( _POSIX_THREADS ) && ( _POSIX_THREADS+0 >= 0 )
#  define ZI_HAS_PTHREADS
#endif
#
#
#if defined( _XOPEN_VERSION ) && ( _XOPEN_VERSION+0 >= 500 )
#  define ZI_HAS_GETTIMEOFDAY
#endif
#
#
#endif
