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

#ifndef ZI_META_ENABLE_IF_HPP
#define ZI_META_ENABLE_IF_HPP 1

namespace zi {
namespace meta {

template< bool B, class T = void >
struct enable_if_c
{
    typedef T type;
};

template< class T >
struct enable_if_c< false, T > {};

template< class B, class T = void >
struct enable_if: enable_if_c< B::value, T > {};



template< bool B, class T >
struct lazy_enable_if_c
{
    typedef typename T::type type;
};

template< class T >
struct lazy_enable_if_c< false, T > {};

template< class B, class T = void >
struct lazy_enable_if: lazy_enable_if_c< B::value, T > {};



template< bool B, class T = void >
struct disable_if_c
{
    typedef T type;
};

template< class T >
struct disable_if_c< true, T > {};

template< class B, class T = void >
struct disable_if: disable_if_c< B::value, T > {};



template< bool B, class T >
struct lazy_disable_if_c
{
    typedef typename T::type type;
};

template< class T >
struct lazy_disable_if_c< true, T > {};

template< class B, class T = void >
struct lazy_disable_if: lazy_disable_if_c< B::value, T > {};

} // namespace vl
} // namespace zi

#endif

