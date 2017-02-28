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

#ifndef ZI_VL_DETAIL_INVERT_HPP
#define ZI_VL_DETAIL_INVERT_HPP 1

#include <zi/vl/mat.hpp>

namespace zi {
namespace vl {

template< class T, std::size_t N >
inline
typename detail::enable_if< is_integral< T >, T >::type
invert( mat< T, N >& m )
{
    return 0;
}

template< class T >
inline
typename detail::enable_if< is_floating_point< T >, T >::type
invert( mat< T, 1 >& m )
{
    if ( std::fabs( m.elem( 0 ) ) <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T r = m.elem( 0 );
    m.elem( 0 ) = static_cast< T >( 1 ) / m.elem( 0 );

    return r;
}

template< class T >
inline
typename detail::enable_if< is_floating_point< T >, T >::type
invert( mat< T, 2 >& m )
{
    T det = m.elem( 0 ) * m.elem( 3 ) - m.elem( 2 ) * m.elem( 1 );

    if ( std::fabs( det ) <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    std::swap( m.elem( 0 ), m.elem( 3 ) );
    m.elem( 1 ) = -m.elem( 1 );
    m.elem( 2 ) = -m.elem( 2 );

    m /= det;

    return det;
}

template< class T >
inline
typename detail::enable_if< is_floating_point< T >, T >::type
invert( mat< T, 3 >& m )
{
    mat< T, 3 > res;

    res.elem( 0 ) = m.elem( 4 ) * m.elem( 8 ) - m.elem( 5 ) * m.elem( 7 );
    res.elem( 1 ) = m.elem( 2 ) * m.elem( 7 ) - m.elem( 1 ) * m.elem( 8 );
    res.elem( 2 ) = m.elem( 1 ) * m.elem( 5 ) - m.elem( 2 ) * m.elem( 4 );
    res.elem( 3 ) = m.elem( 5 ) * m.elem( 6 ) - m.elem( 3 ) * m.elem( 8 );
    res.elem( 4 ) = m.elem( 0 ) * m.elem( 8 ) - m.elem( 2 ) * m.elem( 6 );
    res.elem( 5 ) = m.elem( 2 ) * m.elem( 3 ) - m.elem( 0 ) * m.elem( 5 );
    res.elem( 6 ) = m.elem( 3 ) * m.elem( 7 ) - m.elem( 4 ) * m.elem( 6 );
    res.elem( 7 ) = m.elem( 1 ) * m.elem( 6 ) - m.elem( 0 ) * m.elem( 7 );
    res.elem( 8 ) = m.elem( 0 ) * m.elem( 4 ) - m.elem( 1 ) * m.elem( 3 );

    T d = m.elem( 0 ) * res.elem( 0 )
        + m.elem( 1 ) * res.elem( 3 )
        + m.elem( 2 ) * res.elem( 6 );

    if ( std::fabs( d ) <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T invd = static_cast< T >( 1 ) / d;
    m = res;
    m *= invd;

    return d;
}

template< class T >
inline
typename detail::enable_if< is_floating_point< T >, T >::type
invert( mat< T, 4 >& m )
{
    mat< T, 4 > res;

    T t1[ 6 ] =
        {
            m.elem(  2 ) * m.elem(  7 ) - m.elem(  6 ) * m.elem(  3 ),
            m.elem(  2 ) * m.elem( 11 ) - m.elem( 10 ) * m.elem(  3 ),
            m.elem(  2 ) * m.elem( 15 ) - m.elem( 14 ) * m.elem(  3 ),
            m.elem(  6 ) * m.elem( 11 ) - m.elem( 10 ) * m.elem(  7 ),
            m.elem(  6 ) * m.elem( 15 ) - m.elem( 14 ) * m.elem(  7 ),
            m.elem( 10 ) * m.elem( 15 ) - m.elem( 14 ) * m.elem( 11 )
        };

    res.elem( 0 ) = m.elem(  5 ) * t1[ 5 ] - m.elem(  9 ) * t1[ 4 ] + m.elem( 13 ) * t1[ 3 ];
    res.elem( 1 ) = m.elem(  9 ) * t1[ 2 ] - m.elem( 13 ) * t1[ 1 ] - m.elem(  1 ) * t1[ 5 ];
    res.elem( 2 ) = m.elem( 13 ) * t1[ 0 ] - m.elem(  5 ) * t1[ 2 ] + m.elem(  1 ) * t1[ 4 ];
    res.elem( 3 ) = m.elem(  5 ) * t1[ 1 ] - m.elem(  1 ) * t1[ 3 ] - m.elem(  9 ) * t1[ 0 ];
    res.elem( 4 ) = m.elem(  8 ) * t1[ 4 ] - m.elem(  4 ) * t1[ 5 ] - m.elem( 12 ) * t1[ 3 ];
    res.elem( 5 ) = m.elem(  0 ) * t1[ 5 ] - m.elem(  8 ) * t1[ 2 ] + m.elem( 12 ) * t1[ 1 ];
    res.elem( 6 ) = m.elem(  4 ) * t1[ 2 ] - m.elem( 12 ) * t1[ 0 ] - m.elem(  0 ) * t1[ 4 ];
    res.elem( 7 ) = m.elem(  0 ) * t1[ 3 ] - m.elem(  4 ) * t1[ 1 ] + m.elem(  8 ) * t1[ 0 ];


    T t2[ 6 ] =
        {
            m.elem(  0 ) * m.elem(  5 ) - m.elem(  4 ) * m.elem(  1 ),
            m.elem(  0 ) * m.elem(  9 ) - m.elem(  8 ) * m.elem(  1 ),
            m.elem(  0 ) * m.elem( 13 ) - m.elem( 12 ) * m.elem(  1 ),
            m.elem(  4 ) * m.elem(  9 ) - m.elem(  8 ) * m.elem(  5 ),
            m.elem(  4 ) * m.elem( 13 ) - m.elem( 12 ) * m.elem(  5 ),
            m.elem(  8 ) * m.elem( 13 ) - m.elem( 12 ) * m.elem(  9 )
        };

    res.elem( 8 )  = m.elem(  7 ) * t2[ 5 ] - m.elem( 11 ) * t2[ 4 ] + m.elem( 15 ) * t2[ 3 ];
    res.elem( 9 )  = m.elem( 11 ) * t2[ 2 ] - m.elem( 15 ) * t2[ 1 ] - m.elem(  3 ) * t2[ 5 ];
    res.elem( 10 ) = m.elem( 15 ) * t2[ 0 ] - m.elem(  7 ) * t2[ 2 ] + m.elem(  3 ) * t2[ 4 ];
    res.elem( 11 ) = m.elem(  7 ) * t2[ 1 ] - m.elem(  3 ) * t2[ 3 ] - m.elem( 11 ) * t2[ 0 ];
    res.elem( 12 ) = m.elem( 10 ) * t2[ 4 ] - m.elem(  6 ) * t2[ 5 ] - m.elem( 14 ) * t2[ 3 ];
    res.elem( 13 ) = m.elem(  2 ) * t2[ 5 ] - m.elem( 10 ) * t2[ 2 ] + m.elem( 14 ) * t2[ 1 ];
    res.elem( 14 ) = m.elem(  6 ) * t2[ 2 ] - m.elem( 14 ) * t2[ 0 ] - m.elem(  2 ) * t2[ 4 ];
    res.elem( 15 ) = m.elem(  2 ) * t2[ 3 ] - m.elem(  6 ) * t2[ 1 ] + m.elem( 10 ) * t2[ 0 ];

    T d =
        m.elem( 0 ) * res.elem( 0 ) + m.elem( 4 ) * res.elem( 1 ) +
        m.elem( 8 ) * res.elem( 2 ) + m.elem( 12 ) * res.elem( 3 );

    if ( std::fabs( d ) <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T invd = static_cast< T >( 1 ) / d;
    m = res;
    m *= invd;

    return d;
}

template< class T, std::size_t N >
inline
typename detail::enable_if_c< ( N > 4 ),
        typename detail::enable_if< is_floating_point< T >, T >::type
        >::type
invert( mat< T, N >& m )
{
    mat< T, N > res = mat< T, N >::eye;
    T det = static_cast< T >( 1 );

    for ( std::size_t i = 0; i < N; ++i )
    {
        T min = static_cast< T >( -1 );
        std::size_t min_index = 0;

        for ( std::size_t r = i; r < N; ++r )
        {
            T curr = std::abs( m.at( r, i ) );
            if ( curr > min )
            {
                min = curr;
                min_index = r;
            }
        }

        if ( min <= std::numeric_limits< T >::epsilon() )
        {
            return 0;
        }

        if ( min_index != i )
        {
            m.swap_rows( i, min_index, i, N-1 );
            res.swap_rows( i, min_index );
            det = -det;
        }

        T pivot = m.at( i, i );

        if ( std::abs( pivot ) <= std::numeric_limits< T >::epsilon() )
        {
            return 0;
        }

        det *= pivot;
        T inv_pivot = static_cast< T >( 1 ) / pivot;

        for ( std::size_t k = i + 1; k < N; ++k )
        {
            m.at( i, k ) *= inv_pivot;
        }

        for ( std::size_t k = 0; k < N; ++k )
        {
            res.at( i, k ) *= inv_pivot;
        }


        for ( std::size_t j = i + 1; j < N; ++j )
        {
            T v = m.at( j, i );

            for ( std::size_t k = i + 1; k < N; ++k )
            {
                m.at( j, k ) -= m.at( i, k ) * v;
            }

            for ( std::size_t k = 0; k < N; ++k )
            {
                res.at( j, k ) -= res.at( i, k ) * v;
            }
        }
    }

    for ( std::size_t i = N-1; i > 0; --i )
    {
        for ( std::size_t j = 0; j < i; ++j )
        {
            T v = m.at( j, i );

            for ( std::size_t k = 0; k < N; ++k )
            {
                res.at( j, k ) -= res.at( i, k ) * v;
            }
        }
    }

    m = res;
    return det;
}


template< class T, std::size_t N >
inline
mat< typename detail::promote< T >::type, N >
inv( const mat< T, N >& rhs, bool& ok )
{
    mat< typename detail::promote< T >::type, N > res( rhs );
    ok = static_cast< bool >( invert( res ) );
    return res;
}

template< class T, std::size_t N >
inline
mat< typename detail::promote< T >::type, N >
inv( const mat< T, N >& rhs )
{
    mat< typename detail::promote< T >::type, N > res( rhs );

    if ( !static_cast< bool >( invert( res ) ) )
    {
        throw ::std::runtime_error( "mat<>: inverting singular matrix" );
    }

    return res;
}



} // namespace vl
} // namespace zi

#endif
