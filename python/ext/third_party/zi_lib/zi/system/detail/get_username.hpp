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

#ifndef ZI_SYSTEM_DETAIL_GET_USERNAME_HPP
#define ZI_SYSTEM_DETAIL_GET_USERNAME_HPP 1

#include <zi/system/config.hpp>

#include <zi/utility/assert.hpp>
#include <string>

namespace zi {
namespace system {
namespace detail {

inline std::string get_username()
{

    char buff[1024];

#if ( defined( ZI_OS_LINUX ) || defined( ZI_OS_MACOS ) )

    if ( !getlogin_r(buff, 1023) )
    {
        return std::string(buff);
    }
    else
    {
        return "";
    }

#elif defined ( ZI_OS_WINDOWS )

    DWORD maxLen = 1023;
    ZI_VERIFY( GetUserName(buff, &maxLen) );
    return std::string(buff, maxLen);

#else
#warning "no get_username function available"
#endif

}

} // namespace detail
} // namespace system
} // namespace zi


#endif
