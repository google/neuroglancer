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

#ifndef ZI_UTILITY_DETAIL_NBYTE_INT_HPP
#define ZI_UTILITY_DETAIL_NBYTE_INT_HPP 1

#include <zi/bits/cstdint.hpp>
#include <cstddef>

namespace zi {
namespace detail {

template< std::size_t N > struct nbyte_int;
template<> struct nbyte_int< 1 >  { typedef int8_t   type; };
template<> struct nbyte_int< 2 >  { typedef int16_t  type; };
template<> struct nbyte_int< 4 >  { typedef int32_t  type; };
template<> struct nbyte_int< 8 >  { typedef int64_t  type; };

template< std::size_t N > struct nbyte_uint;
template<> struct nbyte_uint< 1 > { typedef uint8_t  type; };
template<> struct nbyte_uint< 2 > { typedef uint16_t type; };
template<> struct nbyte_uint< 4 > { typedef uint32_t type; };
template<> struct nbyte_uint< 8 > { typedef uint64_t type; };

template< class T > struct as_int
{
    typedef typename nbyte_int< sizeof( T ) >::type type;
};

template< class T > struct as_uint
{
    typedef typename nbyte_uint< sizeof( T ) >::type type;
};


} // namespace detail
} // namespace zi

#endif
