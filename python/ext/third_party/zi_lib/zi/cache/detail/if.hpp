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

#ifndef ZI_CACHE_DETAIL_IF_HPP
#define ZI_CACHE_DETAIL_IF_HPP 1

namespace zi {
namespace cache {
namespace detail {

struct false_ {};

template< bool Cond, class True, class False = false_ >
struct if_
{
    typedef True type;
};

template< class True, class False >
struct if_< false, True, False >
{
    typedef False type;
};

template< bool Cond, class True, class False = false_ >
struct if_not: if_< Cond, False, True >
{
};

template< class CondT, class True, class False = false_ >
struct if_t: if_< CondT::value, True, False >
{
};

template< class CondT, class True, class False = false_ >
struct if_not_t: if_< CondT::value, False, True >
{
};


} // namespace detail
} // namespace cache
} // namespace zi

#endif
