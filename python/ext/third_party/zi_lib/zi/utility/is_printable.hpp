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

#ifndef ZI_UTILITY_IS_PRINTABLE_HPP
#define ZI_UTILITY_IS_PRINTABLE_HPP 1

#include <zi/utility/enable_if.hpp>

#include <zi/utility/detail/get_instance.hpp>
#include <zi/utility/detail/whatever.hpp>
#include <zi/utility/detail/not_this_type.hpp>

#include <iostream>
#include <cstddef>
#include <string>

namespace zi {
namespace detail {
namespace is_printable_ {

// sizeof( not_ostream ) != sizeof( std::ostream)
typedef detail::not_this_type< std::ostream >::type not_ostream;

// overload the operator<< ( std::ostream&, type ) with a
// dummy type that has different size than std::ostream
not_ostream operator<< ( std::ostream&, detail::whatever );


template< class Type, std::size_t S >
struct is_printable_helper
{
    static const bool value = 0;
};

template< std::size_t S >
struct is_printable_helper< void, S >
{
    static const bool value = 0;
};

template< class Type > struct
is_printable_helper< Type, sizeof( std::ostream ) >
{
    static const bool value = 1;
};


template< class Type >
struct is_printable : is_printable_helper<
    Type,
    sizeof( detail::get_instance< std::ostream >::static_reference <<
            detail::get_instance< Type >::static_const_reference ) >
{
};

// specialization for void

template<>
struct is_printable< void > : is_printable_helper< void, 0 >
{
};

template<>
struct is_printable< const void > : is_printable_helper< const void, 0 >
{
};

template<>
struct is_printable< const volatile void > : is_printable_helper< const volatile void, 0 >
{
};


} // namespace is_printable_
} // namespace detail

using detail::is_printable_::is_printable ;

} // namespace zi

#endif
