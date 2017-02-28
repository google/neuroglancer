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

#ifndef ZI_HEAP_BINARY_HEAP_HPP
#define ZI_HEAP_BINARY_HEAP_HPP

#include <zi/bits/cstdint.hpp>
#include <zi/bits/hash.hpp>
#include <zi/bits/unordered_map.hpp>
#include <zi/utility/exception.hpp>

#include <functional>
#include <cstring>
#include <cstdlib>
#include <cstddef>
#include <map>

#include <zi/detail/identity.hpp>
#include <zi/detail/member_function.hpp>
#include <zi/detail/member_variable.hpp>
#include <zi/detail/global_function.hpp>

#include <zi/heap/detail/binary_heap_impl.hpp>

namespace zi {

namespace heap {

using ::zi::detail::identity;
using ::zi::detail::member_function;
using ::zi::detail::const_member_function;
using ::zi::detail::member_variable;
using ::zi::detail::global_function;

template< class KeyExtractor,
          class Hash = ::zi::hash< typename KeyExtractor::result_type >,
          class Pred = std::equal_to< typename KeyExtractor::result_type >
        >
struct hashed_index
{
    typedef typename KeyExtractor::result_type                     key_type;
    typedef KeyExtractor                                           key_extractor;
    typedef unordered_map< const key_type, uint32_t, Hash, Pred >  container_type;
};

template< class KeyExtractor,
          class Compare = std::less< typename KeyExtractor::result_type >
        >
struct ordered_index
{
    typedef typename KeyExtractor::result_type             key_type;
    typedef KeyExtractor                                   key_extractor;
    typedef std::map< const key_type, uint32_t, Compare >  container_type;
};

template< class ValueExtractor,
          class ValueCompare = std::less< typename ValueExtractor::result_type >
        >
struct value
{
    typedef typename ValueExtractor::result_type value_type;
    typedef ValueExtractor                       value_extractor;
    typedef ValueCompare                         compare_type;
};

} // namespace heap


template< class Type,
          class IndexTraits = heap::hashed_index< heap::identity< Type > >,
          class ValueTraits = heap::value< heap::identity< Type > >,
          class Allocator   = std::allocator< Type >
        >
struct binary_heap:  ::zi::heap::detail::binary_heap_impl<
    Type,
    typename IndexTraits::key_type,
    typename ValueTraits::value_type,
    typename IndexTraits::key_extractor,
    typename ValueTraits::value_extractor,
    typename ValueTraits::compare_type,
    typename IndexTraits::container_type,
    Allocator
    >
{
private:
    typedef typename ValueTraits::compare_type compare_type;
    typedef Allocator                          alloc_type  ;

    typedef ::zi::heap::detail::binary_heap_impl<
        Type,
        typename IndexTraits::key_type,
        typename ValueTraits::value_type,
        typename IndexTraits::key_extractor,
        typename ValueTraits::value_extractor,
        typename ValueTraits::compare_type,
        typename IndexTraits::container_type,
        Allocator
    > base_type;

public:
    binary_heap( const alloc_type& alloc )
        : base_type( compare_type(), alloc )
    {
    }

    binary_heap( const compare_type& compare = compare_type(),
                 const alloc_type&   alloc   = alloc_type())
        : base_type( compare, alloc )
    {
    }

};

} // namespace zi

#endif
