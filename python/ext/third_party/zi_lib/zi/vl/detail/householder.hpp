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

#ifndef ZI_VL_DETAIL_HOUSEHOLDER_HPP
#define ZI_VL_DETAIL_HOUSEHOLDER_HPP 1

#include <zi/utility/non_copyable.hpp>
#include <zi/vl/mat.hpp>
#include <zi/vl/detail/enable_if.hpp>

#include <vector>
#include <iostream>

namespace zi {
namespace vl {

template< class T, std::size_t N >
inline
T
left_householder_iteration( mat< T, N >& A, mat< T, N >& U, const std::size_t i )
{
    static vec< T, N > d;

    T l = static_cast< T >( 0 );
    T s = static_cast< T >( 0 );
    for ( std::size_t j = i; j < N; ++j )
    {
        d[ j ] = A.at( j, i );
        s += std::abs( d[ j ] );
    }

    if ( s <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T sinv = static_cast< T >( 1 ) / s;
    for ( std::size_t j = i; j < N; ++j )
    {
        d[ j ] *= sinv;
        l += d[ j ] * d[ j ];
    }


    T dl = std::sqrt( l );
    if ( d[ i ] > 0 )
    {
        dl = -dl;
    }

    l -= d[ i ] * dl;
    d[ i ] -= dl;

    l = static_cast< T >( 1 ) / l;

    for ( std::size_t j = i + 1; j < N; ++j )
    {
        T dr = static_cast< T >( 0 );
        for ( std::size_t k = i; k < N; ++k )
        {
            dr += d[ k ] * A.at( k, j );
        }

        dr *= l;

        for ( std::size_t k = i; k < N; ++k )
        {
            A.at( k, j ) -= dr * d[ k ];
        }
    }

    for ( std::size_t j = 0; j < N; ++j )
    {
        T dr = static_cast< T >( 0 );

        for ( std::size_t k = i; k < N; ++k )
        {
            dr += d[ k ] * U.at( j, k );
        }

        dr *= l;

        for ( std::size_t k = i; k < N; ++k )
        {
            U.at( j, k ) -= dr * d[ k ];
        }

    }

    std::cout << "A = \n" << A << "\n----------------\n"
              << "d * s = " << d  << " ::: " << (s*dl) << " :: " << s << " :: " << dl << "\n"
              << "d = " << d << " :: " << dot( d, d ) << "\n\n";


    return s * dl;

}


template< class T, std::size_t N >
inline
T
right_householder_iteration( mat< T, N >& A, mat< T, N >& V, const std::size_t i )
{
    static vec< T, N > d;

    T l = static_cast< T >( 0 );
    T s = static_cast< T >( 0 );

    for ( std::size_t j = i + 1; j < N; ++j )
    {
        d[ j ] = A.at( i, j );
        s += std::abs( d[ j ] );
    }

    if ( s <= std::numeric_limits< T >::epsilon() )
    {
        return 0;
    }

    T sinv = static_cast< T >( 1 ) / s;
    for ( std::size_t j = i + 1; j < N; ++j )
    {
        d[ j ] *= sinv;
        l += d[ j ] * d[ j ];
    }


    T dl = std::sqrt( l );

    if ( d[ i + 1 ] > 0 )
    {
        dl = -dl;
    }

    l = d[ i + 1 ] * dl - l;
    d[ i + 1 ] -= dl;

    l = static_cast< T >( 1 ) / l;

    for ( std::size_t j = i + 1; j < N; ++j )
    {
        T dr = static_cast< T >( 0 );
        for ( std::size_t k = i + 1; k < N; ++k )
        {
            dr += d[ k ] * A.at( j, k );
        }

        dr *= l;

        for ( std::size_t k = i + 1; k < N; ++k )
        {
            A.at( j, k ) += dr * d[ k ];
        }
    }

    for ( std::size_t j = 0; j < N; ++j )
    {
        T dr = static_cast< T >( 0 );

        for ( std::size_t k = i + 1; k < N; ++k )
        {
            dr += d[ k ] * V.at( j, k );
        }

        dr *= l;

        for ( std::size_t k = i + 1; k < N; ++k )
        {
            V.at( j, k ) += dr * d[ k ];
        }

    }

    return s * dl;

}


template< class T, std::size_t N, std::size_t M >
inline
typename detail::enable_if_c<
    ( M+1 == N ),
    typename detail::enable_if<
        is_floating_point< T >,
        bool
        >::type
    >::type
bidiagonalize( mat< T, N >& A, mat< T, N >& U, mat< T, N >& V,
               vec< T, N >& diagonal, vec< T, M >& super_diagonal )
{
    U = mat< T, N >::eye;
    V = mat< T, N >::eye;
    for ( std::size_t i = 0; i < N; ++i )
    {
        diagonal[ i ] = left_householder_iteration( A, U, i );
        if ( i < N - 1 )
        {
            super_diagonal[ i ] = right_householder_iteration( A, V, i );
        }

        std::cout << "after iteration: " << i << "\n============\n"
                  << ( U * A * trans( V ) ) << "\n====\n" << super_diagonal << "\n\n";
    }

    A = mat< T, N >::zero;

    for ( std::size_t i = 0; i < N; ++i )
    {
        A.at( i, i   ) = diagonal[ i ];
        if ( i < N - 1 )
        {
            A.at( i, i+1 ) = super_diagonal[ i ];
        }
    }


    return true;
}



template< class T, std::size_t N >
inline
bool
householder2( mat< T, N >& Q, mat< T, N >& R,
              typename detail::enable_if< is_floating_point< T > >::type* = 0 )
{
    Q = mat< T, N >::eye;
    for ( std::size_t i = 0; i < 1; ++i )
    {
        std::cout << "iter " << i << " got back "
                  << left_householder_iteration( R, Q, i );
        std::cout << " and r[i][i] = " << R.at( i, i ) << "\n\n";
    }
    return true;
}

template< class T, std::size_t N >
inline
bool
householder3( mat< T, N >& Q, mat< T, N >& R,
              typename detail::enable_if< is_floating_point< T > >::type* = 0 )
{
    Q = mat< T, N >::eye;
    for ( std::size_t i = 0; i < N - 1; ++i )
    {
        std::cout << "iter " << i << " got back "
                  << right_householder_iteration( R, Q, i );
        std::cout << " and r[i][i + 1] = " << R.at( i, i + 1 )
                  << "\n----------\n" << Q << "\n--------\n " << R << "\n\n";
    }
    return true;
}


template< class T, std::size_t N >
inline
bool
householder( mat< T, N >& Q, mat< T, N >& R, bool init_q_to_eye = true,
             typename detail::enable_if< is_floating_point< T > >::type* = 0 )
{
    vec< T, N > d;
    Q = mat< T, N >::eye;
    if ( init_q_to_eye )
    {
        Q = mat< T, N >::eye;
    }
    for ( std::size_t i = 0; i < N-1; ++i )
    {
        T l = static_cast< T >( 0 );
        for ( std::size_t j = i; j < N; ++j )
        {
            d[ j ] = R.at( j, i );
            l += d[ j ] * d[ j ];
        }

        if ( l <= std::numeric_limits< T >::epsilon() )
        {
            return false;
        }

        T dl = std::sqrt( l );
        l += l - d[ i ] * dl * 2;
        d[ i ] -= dl;

        if ( l <= std::numeric_limits< T >::epsilon() )
        {
            return false;
        }

        l = static_cast< T >( 2 ) / l;

        //R.at( i, i ) = d[ i ];


        for ( std::size_t j = i; j < N; ++j )
        {
            T dr = static_cast< T >( 0 );
            for ( std::size_t k = i; k < N; ++k )
            {
                dr += d[ k ] * R.at( k, j );
            }

            dr *= l;

            for ( std::size_t k = i; k < N; ++k )
            {
                R.at( k, j ) -= dr * d[ k ];
            }
        }

        for ( std::size_t j = 0; j < N; ++j )
        {
            T dr = static_cast< T >( 0 );

            for ( std::size_t k = i; k < N; ++k )
            {
                dr += d[ k ] * Q.at( j, k );
            }

            dr *= l;

            for ( std::size_t k = i; k < N; ++k )
            {
                Q.at( j, k ) -= dr * d[ k ];
            }

        }

    }

    return true;

}

template< class T, std::size_t N >
inline
bool
left_householder( mat< T, N >& R, mat< T, N >& Q, bool init_q_to_eye = true,
                  typename detail::enable_if< is_floating_point< T > >::type* = 0 )
{
    vec< T, N > d;
    if ( init_q_to_eye )
    {
        Q = mat< T, N >::eye;
    }

    for ( std::size_t i = 0; i < N-1; ++i )
    {
        T l = static_cast< T >( 0 );
        for ( std::size_t j = i; j < N; ++j )
        {
            d[ j ] = R.at( i, j );
            l += d[ j ] * d[ j ];
        }

        if ( l <= std::numeric_limits< T >::epsilon() )
        {
            return false;
        }

        T dl = std::sqrt( l );
        l -= d[ i ] * dl;
        d[ i ] -= dl;

        if ( l <= std::numeric_limits< T >::epsilon() )
        {
            return false;
        }

        l = static_cast< T >( 1 ) / l;


        for ( std::size_t j = i; j < N; ++j )
        {
            T dr = static_cast< T >( 0 );
            for ( std::size_t k = i; k < N; ++k )
            {
                dr += d[ k ] * R.at( j, k );
            }

            dr *= l;

            for ( std::size_t k = i; k < N; ++k )
            {
                R.at( j, k ) -= dr * d[ k ];
            }
        }

        for ( std::size_t j = 0; j < N; ++j )
        {
            T dr = static_cast< T >( 0 );

            for ( std::size_t k = i; k < N; ++k )
            {
                dr += d[ k ] * Q.at( k, j );
            }

            dr *= l;

            for ( std::size_t k = i; k < N; ++k )
            {
                Q.at( k, j ) -= dr * d[ k ];
            }

        }

    }

    return true;

}

template< class T, std::size_t N >
inline
bool
householder_inverse( mat< T, N >& A,
                     typename detail::enable_if< is_floating_point< T > >::type* = 0 )
{
    mat< T, N > Q1;
    mat< T, N > Q2 = mat< T, N >::eye;

    transpose( A );

    if ( !left_householder( A, Q1 ) )
    {
        return false;
    }

    vec< T, N > d;

    std::cout << A << "\n-------------OLDA\n";
    std::cout << Q1 * A << "\n-------------\n";

    for ( std::size_t idx = 0, i = 0; i < N-1; ++i, ++idx )
    {
        T l = A.at( i, i );

        if ( std::fabs( l ) <= std::numeric_limits< T >::epsilon() )
        {
            return false;
        }

        l = static_cast< T >( 1 ) / l;

        for ( std::size_t j = i + 1; j < N; ++j )
        {
            T dq = A.at( j, i ) * l;
            A.at( j, i ) = 0;

            for ( std::size_t k = 0; k < N; ++k )
            {
                Q2.at( k, j ) += Q2.at( k, i ) * dq;
            }
        }

    }

    std::cout << A << "\n-------------A\n";
    std::cout << Q2 << "\n-------------Q2\n";
    std::cout << ( Q2 * A)  << "\n-------------inv( q2 ) a\n";
    std::cout << ( Q1 * ( trans( Q2 * A ) ) )  << "\n-------------\n";

    return true;

}


template< class T, std::size_t N >
inline
void
householder_just_R( mat< T, N >& R,
                    typename detail::enable_if< is_floating_point< T > >::type* = 0 )
{
    vec< T, N > d;

    for ( std::size_t i = 0; i < N-1; ++i )
    {
        T l = static_cast< T >( 0 );
        for ( std::size_t j = i; j < N; ++j )
        {
            d[ j ] = R.at( j, i );
            l += d[ j ] * d[ j ];
        }

        if ( l > std::numeric_limits< T >::epsilon() )
        {

            T dl = std::sqrt( l );
            l += l - d[ i ] * dl * 2;
            d[ i ] -= dl;

            if ( l > std::numeric_limits< T >::epsilon() )
            {

                l = static_cast< T >( 2 ) / l;

                for ( std::size_t j = i; j < N; ++j )
                {
                    T dr = static_cast< T >( 0 );
                    for ( std::size_t k = i; k < N; ++k )
                    {
                        dr += d[ k ] * R.at( k, j );
                    }

                    dr *= l;

                    for ( std::size_t k = i; k < N; ++k )
                    {
                        R.at( k, j ) -= dr * d[ k ];
                    }
                }
            }
        }
    }
}


} // namespace vl
} // namespace zi

#endif

