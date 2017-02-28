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

#ifndef ZI_SYSTEM_CONFIG_HPP
#define ZI_SYSTEM_CONFIG_HPP 1

#include <zi/config/config.hpp>

#if defined( ZI_OS_WINDOWS )
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#    include <windows.h>
#    undef  WIN32_LEAN_AND_MEAN
#  else
#    include <windows.h>
#  endif
#  include <winsock.h>
#  include <psapi.h>
#  pragma comment(lib, "Ws2_32.lib")
#  pragma comment(lib, "Kernel32.lib")
#  pragma comment(lib, "Psapi.lib")
#
#elif defined( ZI_OS_MACOS )
#  include <sys/types.h>
#  include <sys/sysctl.h>
#  include <mach/task.h>
#  include <mach/mach_init.h>
#  include <mach/shared_memory_server.h>
#
#elif defined( ZI_OS_LINUX )
#  include <sys/sysinfo.h>
#  include <cstdio>
#
#else
#  error "detected os is not supported"
#
#endif

#include <zi/bits/cstdint.hpp>

#endif
