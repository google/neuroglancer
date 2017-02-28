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

#ifndef ZI_SYSTEM_DETAIL_MEMORY_USAGE_HPP
#define ZI_SYSTEM_DETAIL_MEMORY_USAGE_HPP 1

#include <zi/system/config.hpp>

namespace zi {
namespace system {
namespace detail {

inline int64_t memory_usage( bool virt = false )
{

    int64_t memory_used = 0;

#if defined( ZI_OS_LINUX )

    std::FILE* file = std::fopen( "/proc/self/statm", "r" );
    if ( file )
    {
        int vm, rm;
        if ( fscanf( file, "%d %d", &vm, &rm ) == 2 )
        {
            memory_used = static_cast< int64_t >( virt ? vm : rm) * getpagesize();
        }
        fclose( file );
    }

#elif defined( ZI_OS_MACOS )

#  ifdef __LP64__
    task_basic_info_64      ti;
    mach_msg_type_number_t  count  = TASK_BASIC_INFO_64_COUNT;
    task_flavor_t           flavor = TASK_BASIC_INFO_64;
#  else
    task_basic_info_32      ti;
    mach_msg_type_number_t  count  = TASK_BASIC_INFO_32_COUNT;
    task_flavor_t           flavor = TASK_BASIC_INFO_32;
#  endif

    task_info( current_task(), flavor, reinterpret_cast< task_info_t >( &ti ), &count );

    memory_used = static_cast< int64_t >( virt
                                          ? (ti.virtual_size -
                                             SHARED_TEXT_REGION_SIZE -
                                             SHARED_DATA_REGION_SIZE)
                                          : ti.resident_size );

#elif defined ( ZI_OS_WINDOWS )

  PROCESS_MEMORY_COUNTERS ctrs;

#  if defined( PSAPI_VERSION ) && ( PSAPI_VERSION > 1 )
  if ( K32GetProcessMemoryInfo( GetCurrentProcess(), &ctrs, sizeof( ctrs ) ) )
#  else
  if ( GetProcessMemoryInfo( GetCurrentProcess(), &ctrs, sizeof( ctrs ) ) )
#  endif
  {
      memory_used = static_cast< int64_t >( ctrs.WorkingSetSize );
  }

#endif

  return memory_used;

}

} // namespace detail
} // namespace system
} // namespace zi


#endif
