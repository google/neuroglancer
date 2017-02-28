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

#ifndef ZI_SYSTEM_DETAIL_CPU_COUNT_HPP
#define ZI_SYSTEM_DETAIL_CPU_COUNT_HPP 1

#include <zi/system/config.hpp>

namespace zi {
namespace system {
namespace detail {

inline int32_t cpu_count()
{

#if ( defined( ZI_OS_LINUX ) || defined( ZI_OS_MACOS ) )

    return static_cast< int32_t >( sysconf( _SC_NPROCESSORS_CONF ) );

#elif defined ( ZI_OS_WINDOWS )

    SYSTEM_INFO info;
    GetSystemInfo( &info );
    return static_cast< int32_t >( info.dwNumberOfProcessors );

#else
#warning "no cpu_count function available"
#endif

}

} // namespace detail
} // namespace system
} // namespace zi


#endif
