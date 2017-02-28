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

#ifndef ZI_ATOMIC_CONFIG_HPP
#define ZI_ATOMIC_CONFIG_HPP 1

#include <zi/config/config.hpp>

#if defined( ZI_OS_WINDOWS )
#  // look at concurrency/config.hpp
#  // for why we need NOMINMAX ( can't use numerical_limits< ... > )
#  ifndef NOMINMAX
#    define NOMINMAX 1
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#    include <windows.h>
#    undef  WIN32_LEAN_AND_MEAN
#  else
#    include <windows.h>
#  endif
#  undef NOMINMAX
#
#endif

#if defined( ZI_HAS_PTHREADS )
#  if ( defined( __USE_XOPEN2K ) && !defined( ZI_HAS_PT_SPINLOCK ) )
#    define ZI_HAS_PT_SPINLOCK
#  endif
#endif

#if defined( __GNUC__ ) && ( __GNUC__ * 100 + __GNUC_MINOR__ >= 401 )
#  ifndef ZI_HAS_GCC_SYNC
#    define ZI_HAS_GCC_SYNC
#  endif
#endif

#include <zi/bits/cstdint.hpp>

#endif
