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

#ifndef ZI_TIME_TIME_UTILS_HPP
#define ZI_TIME_TIME_UTILS_HPP 1

#include <zi/time/config.hpp>
#include <zi/bits/cstdint.hpp>

namespace zi {
namespace time_utils {

#if defined( ZI_HAS_POSIX_SUPPORT ) && !defined( ZI_OS_WINDOWS )

inline void msec_to_ts( timespec& ts, int64_t t )
{
    ts.tv_sec  = t / 1000LL;
    ts.tv_nsec = (t % 1000LL) * 1000000LL;
}

inline void usec_to_ts( timespec& ts, int64_t t )
{
    ts.tv_sec  = t / 1000000LL;
    ts.tv_nsec = (t % 1000000LL) * 1000LL;
}

inline void nsec_to_ts( timespec& ts, int64_t t )
{
    ts.tv_sec  = t / 1000000000LL;
    ts.tv_nsec = t % 1000000000LL;
}

inline int64_t ts_to_msec( timespec& ts )
{
    int64_t t = static_cast< int64_t >( ts.tv_sec ) * 1000LL;
    t += ts.tv_nsec / 1000000LL;
    return ( ts.tv_nsec % 1000000LL > 500000LL ) ? ++t : t;
}

inline int64_t ts_to_usec( timespec& ts )
{
    int64_t t = static_cast< int64_t >( ts.tv_sec ) * 1000000LL;
    t += ts.tv_nsec / 1000LL;
    return ( ts.tv_nsec % 1000LL > 500LL ) ? ++t : t;
}

inline int64_t ts_to_nsec( timespec& ts )
{
    return static_cast< int64_t >( ts.tv_sec ) * 1000000000LL + ts.tv_nsec;
}

#endif

#if defined( ZI_OS_WINDOWS )

inline int64_t ft_to_msec( FILETIME& ft )
{
    LARGE_INTEGER t;

    t.LowPart  = ft.dwLowDateTime;
    t.HighPart = ft.dwHighDateTime;

    return static_cast< int64_t >
        ( t.QuadPart - (116444736000000000ULL) ) / 10000ULL;
}

inline int64_t ft_to_usec( FILETIME& ft )
{
    LARGE_INTEGER t;

    t.LowPart  = ft.dwLowDateTime;
    t.HighPart = ft.dwHighDateTime;

    return static_cast< int64_t >
        ( t.QuadPart - (116444736000000000ULL) ) / 10ULL;
}

inline int64_t ft_to_nsec( FILETIME& ft )
{
    LARGE_INTEGER t;

    t.LowPart  = ft.dwLowDateTime;
    t.HighPart = ft.dwHighDateTime;

    return static_cast< int64_t >
        ( t.QuadPart - (116444736000000000ULL) ) * 100ULL;
}

#endif

inline void msec_to_tv( timeval& tv, int64_t t )
{
    tv.tv_sec  = static_cast< int32_t >( t / 1000LL );
    tv.tv_usec = (t % 1000LL) * 1000LL;
}

inline void usec_to_tv( timeval& tv, int64_t t )
{
    tv.tv_sec  = static_cast< int32_t >( t / 1000000LL );
    tv.tv_usec = t % 1000000LL;
}

inline void nsec_to_tv( timeval& tv, int64_t t )
{
    tv.tv_sec  = static_cast< int32_t >( t / 1000000000LL );
    tv.tv_usec = (t % 1000000000LL) / 1000LL;
    if ( t % 1000LL > 500LL )
    {
        ++tv.tv_usec;
    }
}

inline int64_t tv_to_msec( timeval& tv )
{
    int64_t t = static_cast< int64_t >( tv.tv_sec ) * 1000LL;
    t += tv.tv_usec / 1000LL;
    return ( tv.tv_usec % 1000LL > 500LL ) ? ++t : t;
}

inline int64_t tv_to_usec( timeval& tv )
{
    return static_cast< int64_t >( tv.tv_sec ) * 1000000LL + tv.tv_usec;
}

inline int64_t tv_to_nsec( timeval& tv )
{
    return static_cast< int64_t >( tv.tv_sec ) * 1000000000LL
        + tv.tv_usec * 1000LL;
}


} // namespace time_utils
} // namespace zi

#endif
