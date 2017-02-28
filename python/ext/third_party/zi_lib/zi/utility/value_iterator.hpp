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

#ifndef ZI_UTILITY_VALUE_ITERATOR_HPP
#define ZI_UTILITY_VALUE_ITERATOR_HPP 1

#include <iterator>
#include <cstddef>

#include <zi/bits/type_traits.hpp>
#include <zi/utility/static_if.hpp>

namespace zi {

template< class Iterator >
struct value_iterator: Iterator
{
public:
    typedef typename std::iterator_traits< Iterator >::iterator_category       iterator_category;
    typedef typename std::iterator_traits< Iterator >::difference_type         difference_type  ;
    typedef typename std::iterator_traits< Iterator >::value_type::second_type value_type       ;
    typedef typename std::iterator_traits< Iterator >::pointer                 base_pointer     ;
    typedef typename std::iterator_traits< Iterator >::reference               base_reference   ;
    typedef typename if_< is_const< base_pointer >::value, const value_type*, value_type* >::type pointer;
    typedef typename if_< is_const< base_reference >::value, const value_type&, value_type& >::type reference;

protected:
    Iterator iterator_;
};

} // namespace zi

#endif
