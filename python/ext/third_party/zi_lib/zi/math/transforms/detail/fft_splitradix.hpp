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

#ifndef ZI_MATH_TRANSFORMS_DETAIL_FFT_SPLITRADIX_HPP
#define ZI_MATH_TRANSFORMS_DETAIL_FFT_SPLITRADIX_HPP 1

#include <zi/math/transforms/detail/permuter.hpp>
#include <zi/math/transforms/detail/roots_table.hpp>
#include <zi/math/transforms/detail/size_log2.hpp>

#include <zi/utility/assert.hpp>
#include <zi/utility/for_each.hpp>

#include <complex>
#include <vector>
#include <cstddef>

namespace zi {
namespace math {
namespace fft {

template< class T >
void splitradix_dif_impl( std::vector< std::complex< T > >& data )
{
    if ( data.size() == 0 )
    {
        return;
    }

    std::size_t log_size = detail::size_log2( data.size() );
    std::size_t n  = 1 << log_size;
    std::size_t n2 = 2 * n;

    //const std::vector< std::complex< T > >& roots =
    //detail::get_roots_table< T >( n );

    for ( std::size_t l = 0; l < log_size; ++l )
    {
        n2 >>= 1;
        std::size_t n4 = n2 >> 2;

        T uangle = constants< T >::pi() * 2 / n2;

        for ( std::size_t j = 0; j < n4; ++j )
        {
            T angle = uangle * j;
            T cos1  = std::cos( angle );
            T sin1  = std::sin( angle );
            angle  *= 3;
            T cos2  = std::cos( angle );
            T sin2  = std::sin( angle );

            std::size_t ix = j;
            std::size_t id = n2 << 1;

            while ( ix < n )
            {
                for ( std::size_t i0 = ix; i0 < n; i0 += id )
                {
                    std::size_t i1 = i0 + n4;
                    std::size_t i2 = i1 + n4;
                    std::size_t i3 = i2 + n4;

                    std::complex< T > t0 = data[ i0 ] - data[ i2 ];
                    std::complex< T > t1 = data[ i1 ] - data[ i3 ];
                    data[ i0 ] += data[ i2 ];
                    data[ i1 ] += data[ i3 ];

                    T t3 = t0.real() - t1.imag();
                    t0.real() = -( t1.imag() + t0.real() );

                    T t4 = t0.imag() - t1.real();
                    t1.real() += t0.imag();

                    data[ i2 ].real() = t4 * sin1 - t0.real() * cos1;
                    data[ i2 ].imag() = sin1 * t0.real() + cos1 * t4;

                    data[ i3 ].imag() = t1.real() * cos2 - t3 * sin2;
                    data[ i3 ].real() = t3 * cos2 + t1.real() * sin2;
               }

               ix = ( id << 1 ) - n2 + j;
               id <<= 2;
            }
        }
    }

    for ( std::size_t ix = 0, id = 4; ix < n; id *= 4 )
    {
        for ( std::size_t i0 = ix; i0 < n; i0 += id )
        {
            std::complex< T > tmp = data[ i0 ] - data[ i0+1 ];
            data[ i0 ]   += data[ i0+1 ];
            data[ i0+1 ]  = tmp;
        }
        ix = 2 * ( id-1 );
    }
}

template< class T >
inline void splitradix_forward( std::vector< std::complex< T > >& data )
{
    std::size_t log_size = detail::size_log2( data.size() );
    data.resize( 1 << log_size );

    FOR_EACH( it, data )
    {
        std::swap( it->real(), it->imag() );
    }

    splitradix_dif_impl( data );

    FOR_EACH( it, data )
    {
        std::swap( it->real(), it->imag() );
    }

    detail::apply_permutation( data );
}

template< class T >
inline void splitradix_inverse( std::vector< std::complex< T > >& data )
{
    std::size_t log_size = detail::size_log2( data.size() );
    data.resize( 1 << log_size );

    splitradix_dif_impl( data );

    detail::apply_permutation( data );
}

} // namespace detail
} // namespace math
} // namespace zi

#endif

