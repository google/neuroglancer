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

#ifndef ZI_TIME_CONFIG_HPP
#define ZI_TIME_CONFIG_HPP 1

#include <zi/config/config.hpp>

#ifndef ZI_HAS_CLOCK_GETTIME
#
#  if defined( ZI_HAS_GETTIMEOFDAY )
#    include <sys/time.h>
#
#  elif defined( ZI_OS_WINDOWS )
#
#    ifndef WIN32_LEAN_AND_MEAN
#      define WIN32_LEAN_AND_MEAN
#      include <windows.h>
#      undef  WIN32_LEAN_AND_MEAN
#    else
#      include <windows.h>
#    endif
#
#    include <time.h>
#
#    ifndef _TIMEVAL_DEFINED
#      define _TIMEVAL_DEFINED
#      define ZI_NEEDS_TIMEVAL
#    endif
#
#  else
#    error "no high precision timer found"
#
#  endif
#
#endif

#ifdef ZI_NEEDS_TIMEVAL

struct timeval {
    long tv_sec;
    long tv_usec;
};

#undef ZI_NEEDS_TIMEVAL
#endif

#endif
