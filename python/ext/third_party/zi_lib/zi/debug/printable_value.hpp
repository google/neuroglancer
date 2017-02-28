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

#ifndef ZI_DEBUG_PRINTABLE_VALUE_HPP
#define ZI_DEBUG_PRINTABLE_VALUE_HPP 1

#include <zi/debug/detail/demangle.hpp>

#include <zi/utility/enable_if.hpp>
#include <zi/utility/is_printable.hpp>
#include <zi/utility/address_of.hpp>

#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <cstddef>

namespace zi {
namespace debug {

template< class Type > inline std::string
printable_value( const Type& t,
                 typename enable_if< is_printable< Type >::value >::type* = 0 )
{
    std::ostringstream ss;
    ss << t;
    return ss.str();
}

template< class Type > inline std::string
printable_value( const Type& t,
                 typename disable_if< is_printable< Type >::value >::type* = 0 )
{
    std::ostringstream ss;
    ss << "[obj@" << address_of( t ) << "]";
    return ss.str();
}

template< class Type > inline std::string
printable_value( Type* t )
{
    std::ostringstream ss;
    ss << "["  << reinterpret_cast< const void* >( t ) << "]";
    return ss.str();
}

template< class Type, std::size_t S > inline std::string
printable_value( Type t[S] )
{
    std::ostringstream ss;
    ss << "[" << reinterpret_cast< const void* >( t ) << "]";
    return ss.str();
}


} // namespace debug
} // namespace zi

#endif
