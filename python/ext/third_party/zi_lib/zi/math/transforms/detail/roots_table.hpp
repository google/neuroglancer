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

#ifndef ZI_MATH_TRANSFORMS_DETAIL_ROOTS_TABLE_HPP
#define ZI_MATH_TRANSFORMS_DETAIL_ROOTS_TABLE_HPP 1

#include <zi/bits/type_traits.hpp>
#include <zi/bits/cstdint.hpp>
#include <zi/utility/assert.hpp>
#include <zi/utility/singleton.hpp>
#include <zi/utility/for_each.hpp>
#include <zi/utility/non_copyable.hpp>
#include <zi/utility/static_assert.hpp>
#include <zi/concurrency/mutex.hpp>

#include <complex>
#include <vector>
#include <cstddef>

namespace zi {
namespace math {
namespace detail {


template< class T, std::size_t LogSize >
class roots_table: non_copyable
{
private:
    ZI_STATIC_ASSERT( is_floating_point< T >::value, not_floating_point_roots_table );
    std::vector< std::complex< T > >   roots_   ;
    mutex                              lock_    ;
    bool                               computed_;
    static const std::size_t N = ( 1ull << LogSize );

public:
    roots_table()
        : roots_(),
          lock_(),
          computed_( false )
    {
    }

    void compute()
    {
        mutex::guard g( lock_ );

        if ( computed_ )
        {
            return;
        }

        roots_.resize( N + 1 );

        roots_[ N ] = roots_[ 0 ] = std::complex< T >( 1, 0 );

        for ( std::size_t i = 1; i <= N/2; ++i )
        {
            T cosine = std::cos( constants< T >::pi() * 2 * i / N );
            T sine   = std::sin( constants< T >::pi() * 2 * i / N );
            roots_[ i ].real() = cosine;
            roots_[ i ].imag() = sine  ;
        }

        for ( std::size_t i = 1; i < N/2; ++i )
        {
            roots_[ i+N/2 ] = -roots_[ i ];
        }

        computed_ = true;
    }

    const std::vector< std::complex< T > >& get_roots()
    {
        compute();
        return roots_;
    }

};

template< class T, std::size_t S >
class roots_table_fetcher;

template< class T >
class roots_table_fetcher< T, 26 >: non_copyable
{
public:
    static inline const std::vector< std::complex< T > >& get( std::size_t )
    {
        static std::vector< std::complex< T > > empty;
        return empty;
    }
};

template< class T, std::size_t S >
class roots_table_fetcher: non_copyable
{
private:
    ZI_STATIC_ASSERT( S < 26, too_large_root_table );

public:
    static inline const std::vector< std::complex< T > >& get( std::size_t s )
    {
        if ( s <= ( 1 << S ) )
        {
            return singleton< roots_table< T, S > >::instance().get_roots();
        }
        else
        {
            return roots_table_fetcher< T, S+1 >::get( s );
        }
    }
};

template< class T >
inline const std::vector< std::complex< T > >& get_roots_table( std::size_t s )
{
    return roots_table_fetcher< T, 1 >::get( s );
}

} // namespace detail
} // namespace math
} // namespace zi

#endif

