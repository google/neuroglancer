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

#ifndef ZI_META_IF_HPP
#define ZI_META_IF_HPP 1

#include <zi/meta/true_type.hpp>
#include <zi/meta/false_type.hpp>
#include <zi/meta/null_type.hpp>

namespace zi {
namespace meta {

template< bool B, class T1, class T2 >
struct if_c
{
    typedef T1 type;
};

template< class T1, class T2 >
struct if_c< false, T1, T2 >
{
    typedef T2 type;
};

template< class B, class T1, class T2 >
struct if_: if_c< B::value, T1, T2 > {};

template< class T1, class T2 >
struct if_< true_, T1, T2 >
{
    typedef T1 type;
};

template< class T1, class T2 >
struct if_< false_, T1, T2 >
{
    typedef T2 type;
};

} // namespace meta
} // namespace zi

#endif
