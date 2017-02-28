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

#ifndef ZI_ZLOG_LOG_PRINTF_HPP
#define ZI_ZLOG_LOG_PRINTF_HPP 1

#include <cstdlib>
#include <cstdio>
#include <cstdarg>
#include <string>

namespace zi {
namespace zlog {

inline std::string log_printf() {
    return "";
}

inline std::string log_printf( const char *fmt, ... )
{

    int n;
    int size = 128;
    char *np;
    va_list ap;

    char *p = static_cast< char* >( std::malloc (size) );

    if ( p == 0 )
    {
        return std::string();
    }

    while (1)
    {
        va_start( ap, fmt );
        n = vsnprintf( p, size, fmt, ap );
        va_end( ap );

        if ( n > -1 && n < size )
        {
            break;
        }

        size = ( n > -1 ) ? n + 1 : size << 1;

        np = static_cast< char* >( std::realloc( static_cast< void* >( p ), size ) );

        if ( np == 0 )
        {
            std::free( p );
            return std::string();
        }
        else
        {
            p = np;
        }
    }
    return std::string(p);
}

} // namespace zlog

using zlog::log_printf;

} // namespace zi

#endif

