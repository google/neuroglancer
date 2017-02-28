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

#ifndef ZI_CACHE_DEFAULT_CONSTRUCTOR_HPP
#define ZI_CACHE_DEFAULT_CONSTRUCTOR_HPP 1

#include <zi/cache/config.hpp>
#include <zi/cache/detail/if.hpp>
#include <zi/cache/detail/enable_if.hpp>
#include <zi/cache/detail/type_traits.hpp>
#include <zi/cache/detail/ref.hpp>

namespace zi {
namespace cache {
namespace default_constructor_ {

template< class Key > struct key_instance
{
    static Key& refe;
};


namespace value_from_key_ctor {

template< class Value, class Key > char test( char(*)[ sizeof( Value( key_instance<Key>::refe ) ) ] );
template< class Value, class Key > int  test( ... );

}

template< class Value, class Key >
struct has_value_of_key_ctor
{
    static const bool value =
        ( sizeof( value_from_key_ctor::test< Value, Key >( 0 ) ) == 1 );
};

} // namespace default_constructor_

using default_constructor_::has_value_of_key_ctor;

} // namespace cache
} // namespace zi


#endif
