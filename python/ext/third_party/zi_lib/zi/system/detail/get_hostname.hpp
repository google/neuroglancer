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

#ifndef ZI_SYSTEM_DETAIL_GET_HOSTNAME_HPP
#define ZI_SYSTEM_DETAIL_GET_HOSTNAME_HPP 1

#include <zi/system/config.hpp>

#include <zi/utility/assert.hpp>

namespace zi {
namespace system {
namespace detail {

inline std::string get_hostname()
{

    char buff[1024];

#if ( defined( ZI_OS_LINUX ) || defined( ZI_OS_MACOS ) )

    if ( !gethostname(buff, 1023) )
    {
        return std::string(buff);
    }
    else
    {
        return "hostname";
    }

#elif defined ( ZI_OS_WINDOWS )

    WSADATA wsaData = { 0 };
    if ( WSAStartup(MAKEWORD(2, 2), &wsaData) )
    {
        return "hostname";
    }
    else
    {
        DWORD maxLen = 1023;
        gethostname(buff, maxLen);
        return std::string(buff);
    }

#else
#warning "no get_hostname function available"
#endif

}

} // namespace detail
} // namespace system
} // namespace zi


#endif
