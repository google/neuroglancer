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

#ifndef ZI_UTILITY_BINARY_PRINTER_HPP
#define ZI_UTILITY_BINARY_PRINTER_HPP 1

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/static_assert.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/bits/type_traits.hpp>
#include <zi/bits/cstdint.hpp>

#include <ostream>
#include <cstddef>

namespace zi {

namespace detail {

template< class T >
class binary_printer_binder
{
private:
    ZI_STATIC_ASSERT( is_integral< T >::value, non_integral_binary_impl );

public:
    static const std::size_t bit_len = sizeof( T ) * 8;

    explicit binary_printer_binder( const T& v = T(), bool dot_separation = false )
        : v_( v ),
          dot_separation_( dot_separation )
    {
    }

private:
    T v_;
    bool dot_separation_;

public:

    template< class CharType, class CharTraits >
    friend inline ::std::basic_ostream< CharType, CharTraits >&
    operator<< ( ::std::basic_ostream< CharType, CharTraits >& os,
                 const binary_printer_binder< T >& bp )
    {
        os << "0b";
        T mask = static_cast< T >( 1 ) << ( bit_len - 1 );

        for ( std::size_t i = 0; i < bit_len; ++i )
        {
            if ( bp.dot_separation_ && ( i > 0 ) && ( ( i & 7 ) == 0 ) )
            {
                os << '.';
            }
            os << ( ( mask & bp.v_ ) ? 1 : 0 );
            mask >>= 1;
        }
        return os;
    }

};

} // namespace detail

template< class T >
static inline detail::binary_printer_binder< T > binary( const T& v )
{
    return detail::binary_printer_binder< T >( v, true );
}

template< class T >
static inline detail::binary_printer_binder< T > binary_raw( const T& v )
{
    return detail::binary_printer_binder< T >( v );
}


} // namespace zi

#endif

