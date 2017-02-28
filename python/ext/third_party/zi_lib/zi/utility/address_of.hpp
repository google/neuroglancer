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

#ifndef ZI_UTILITY_ADDRESS_OF_HPP
#define ZI_UTILITY_ADDRESS_OF_HPP 1

#include <zi/utility/detail/dummy.hpp>

namespace zi {
namespace address_of_ {

template< class T > struct address_of_helper
{

    static inline T* get_address( T &t, detail::dummy< 0 > = 0 )
    {
        return reinterpret_cast< T* >
            ( &const_cast< char& >
              ( reinterpret_cast< const volatile char& >( t ) ));
    }

    static inline T* get_address( T *t, detail::dummy< 1 > = 0 )
    {
        return t;
    }
};

template< class T > T* address_of( T &t )
{
    return address_of_helper< T >::get_address( t );
}

} // namespace address_of_

using address_of_::address_of;

} // namespace zi

#endif
