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

#ifndef ZI_SYSTEM_ERROR_HPP
#define ZI_SYSTEM_ERROR_HPP 1

#include <zi/system/detail/cerrno_code.hpp>
#include <zi/system/detail/win32_errno_code.hpp>
#include <zi/system/detail/linux_errno_code.hpp>

#include <stdexcept>
#include <string>

namespace zi {
namespace system {

class error: public std::runtime_error
{
private:
    cerrno_type           error_code_;
    mutable std::string   message_   ;

public:
    error(

};

} // namespace system
} // namespace zi

#endif // defined( ZI_OS_WINDOWS )

#endif
