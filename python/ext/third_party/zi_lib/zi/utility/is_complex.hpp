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

#ifndef ZI_UTILITY_IS_COMPLEX_HPP
#define ZI_UTILITY_IS_COMPLEX_HPP 1

#include <zi/utility/enable_if.hpp>

#include <zi/bits/type_traits.hpp>
#include <zi/bits/complex.hpp>

namespace zi {

namespace detail {
namespace is_complex_ {

struct is_convertible_from_complex
{
   template< class T >
   is_convertible_from_complex( const ::zi::complex< T >& );
};

template< class T >
struct is_complex
{
    static const bool value = is_convertible< T, is_convertible_from_complex >::value;
};

} // namespace is_complex_
} // namespace detail

using detail::is_complex_::is_complex;

} // namespace zi

#endif
