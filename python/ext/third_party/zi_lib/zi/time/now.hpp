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

#ifndef ZI_TIME_NOW_HPP
#define ZI_TIME_NOW_HPP 1

#include <zi/time/config.hpp>
#include <zi/time/time_utils.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/utility/assert.hpp>

#include <ctime>

namespace zi {
namespace now {

inline int64_t seconds()
{
    return static_cast< int64_t >( std::time( NULL ) );
}

inline int64_t sec()
{
    return static_cast< int64_t >( std::time( NULL ) );
}

#if defined( ZI_HAS_CLOCK_GETTIME )

#define NOW_IN_XXX_CONSTRUCT( what, fn )                        \
    inline int64_t fn ()                                        \
    {                                                           \
        timespec ts;                                            \
        ZI_VERIFY_0( clock_gettime( CLOCK_REALTIME, &ts ) );    \
        return time_utils::ts_to_##what ( ts );                 \
    }

#elif defined( ZI_HAS_GETTIMEOFDAY )

#define NOW_IN_XXX_CONSTRUCT( what, fn )                        \
    inline int64_t fn ()                                        \
    {                                                           \
        timeval tv;                                             \
        ZI_VERIFY_0( gettimeofday( &tv, NULL ) );               \
        return time_utils::tv_to_##what ( tv );                 \
    }

#else

#define NOW_IN_XXX_CONSTRUCT( what, fn )                        \
    inline int64_t fn ()                                        \
    {                                                           \
        FILETIME ft;                                            \
        GetSystemTimeAsFileTime( &ft );                         \
        return time_utils::ft_to_##what ( ft );                 \
    }

#endif

NOW_IN_XXX_CONSTRUCT( msec, msec )
NOW_IN_XXX_CONSTRUCT( msec, msecs )
NOW_IN_XXX_CONSTRUCT( msec, milliseconds )
NOW_IN_XXX_CONSTRUCT( usec, usec )
NOW_IN_XXX_CONSTRUCT( usec, usecs )
NOW_IN_XXX_CONSTRUCT( usec, microseconds )
NOW_IN_XXX_CONSTRUCT( nsec, nsec )
NOW_IN_XXX_CONSTRUCT( nsec, nsecs )
NOW_IN_XXX_CONSTRUCT( nsec, nanoseconds  )

#undef NOW_IN_XXX_CONSTRUCT

} // namespace now
} // namespace zi

#endif
