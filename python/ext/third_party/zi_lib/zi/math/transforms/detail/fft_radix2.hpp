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

#ifndef ZI_MATH_TRANSFORMS_DETAIL_FFT_RADIX2_HPP
#define ZI_MATH_TRANSFORMS_DETAIL_FFT_RADIX2_HPP 1

#include <zi/math/transforms/detail/permuter.hpp>
#include <zi/math/transforms/detail/roots_table.hpp>
#include <zi/math/transforms/detail/size_log2.hpp>

#include <zi/utility/assert.hpp>

#include <complex>
#include <vector>
#include <cstddef>

namespace zi {
namespace math {
namespace fft {

template< class T, bool Inv >
void dfs_radix_dit2( std::vector< std::complex< T > >& data )
{
    std::size_t log_size = detail::apply_permutation( data );
    std::size_t n = 1 << log_size;

    const std::vector< std::complex< T > >& roots =
        detail::get_roots_table< T >( n );

    for ( std::size_t l = 1; l <= log_size; ++l )
    {
        const std::size_t m  = 1ull << l;
        const std::size_t mh = m >> 1;
        const std::size_t da = 1 << ( log_size - l );

        for ( std::size_t r = 0; r < n; r += m )
        {
            for ( std::size_t j = 0, w = 0; j < mh; ++j, w += da )
            {
                const std::size_t i0 = r + j;
                const std::size_t i1 = i0 + mh;

                std::complex< T > u = data[ i0 ];
                std::complex< T > v = data[ i1 ] * roots[ Inv ? n-w : w ];

                data[ i0 ] += v;
                data[ i1 ]  = u - v;
            }
        }
    }
}

template< class T >
inline void dfs_radix_dit2_forward( std::vector< std::complex< T > >& data )
{
    dfs_radix_dit2< T, false >( data );
}

template< class T >
inline void dfs_radix_dit2_inverse( std::vector< std::complex< T > >& data )
{
    dfs_radix_dit2< T, true >( data );
}

template< class T, bool Inv >
void radix_dit2( std::vector< std::complex< T > >& data )
{
    std::size_t log_size = detail::apply_permutation( data );
    std::size_t n = 1 << log_size;

    const std::vector< std::complex< T > >& roots =
        detail::get_roots_table< T >( n );

    for ( std::size_t l = 1; l <= log_size; ++l )
    {
        const std::size_t m  = 1ull << l;
        const std::size_t mh = m >> 1;
        const std::size_t da = 1 << ( log_size - l );

        for ( std::size_t j = 0, w = 0; j < mh; ++j, w += da )
        {
            std::complex< T > wval = roots[ Inv ? n-w : w ];

            for ( std::size_t r = 0; r < n; r += m )
            {
                std::size_t i0 = r + j;
                std::size_t i1 = i0 + mh;

                std::complex< T > u = data[ i0 ];
                std::complex< T > v = data[ i1 ] * wval;

                data[ i0 ] += v;
                data[ i1 ]  = u - v;
            }
        }
    }
}

template< class T >
void radix_dit2_forward( std::vector< std::complex< T > >& data )
{
    radix_dit2< T, false >( data );
}

template< class T >
void radix_dit2_inverse( std::vector< std::complex< T > >& data )
{
    radix_dit2< T, true >( data );
}


template< class T, bool Inv >
void dfs_radix_dif2( std::vector< std::complex< T > >& data )
{
    if ( data.size() == 0 )
    {
        return;
    }

    std::size_t log_size = detail::size_log2( data.size() );
    std::size_t n = 1 << log_size;
    data.resize( n );

    const std::vector< std::complex< T > >& roots =
        detail::get_roots_table< T >( n );

    for ( std::size_t l = log_size; l >= 1; --l )
    {
        const std::size_t m  = 1ull << l;
        const std::size_t mh = m >> 1;
        const std::size_t da = 1 << ( log_size - l );

        for ( std::size_t r = 0; r < n; r += m )
        {
            for ( std::size_t j = 0, w = 0; j < mh; ++j, w += da )
            {
                std::size_t i0 = r + j;
                std::size_t i1 = i0 + mh;

                std::complex< T > u = data[ i0 ];

                data[ i0 ] += data[ i1 ];
                data[ i1 ]  = ( u - data[ i1 ] ) * roots[ Inv ? n-w : w ];
            }
        }
    }

    detail::apply_permutation( data );
}

template< class T >
inline void dfs_radix_dif2_forward( std::vector< std::complex< T > >& data )
{
    dfs_radix_dif2< T, false >( data );
}

template< class T >
inline void dfs_radix_dif2_inverse( std::vector< std::complex< T > >& data )
{
    dfs_radix_dif2< T, true >( data );
}



template< class T, bool Inv >
void radix_dif2( std::vector< std::complex< T > >& data )
{
    if ( data.size() == 0 )
    {
        return;
    }

    std::size_t log_size = detail::size_log2( data.size() );
    std::size_t n = 1 << log_size;
    data.resize( n );

    const std::vector< std::complex< T > >& roots =
        detail::get_roots_table< T >( n );

    for ( std::size_t l = log_size; l >= 1; --l )
    {
        const std::size_t m  = 1ull << l;
        const std::size_t mh = m >> 1;
        const std::size_t da = 1 << ( log_size - l );

        for ( std::size_t j = 0, w = 0; j < mh; ++j, w += da )
        {
            std::complex< T > wval = roots[ Inv ? n-w : w ];

            for ( std::size_t r = 0; r < n; r += m )
            {
                std::size_t i0 = r + j;
                std::size_t i1 = i0 + mh;

                std::complex< T > u = data[ i0 ];

                data[ i0 ] += data[ i1 ];
                data[ i1 ]  = ( u - data[ i1 ] ) * wval;
            }
        }
    }

    detail::apply_permutation( data );
}

template< class T >
inline void radix_dif2_forward( std::vector< std::complex< T > >& data )
{
    radix_dif2< T, false >( data );
}

template< class T >
inline void radix_dif2_inverse( std::vector< std::complex< T > >& data )
{
    radix_dif2< T, true >( data );
}



} // namespace detail
} // namespace math
} // namespace zi

#endif

