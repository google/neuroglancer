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

#ifndef ZI_VL_MAT_FUNCTIONS_HPP
#define ZI_VL_MAT_FUNCTIONS_HPP 1

#include <zi/vl/mat.hpp>
#include <zi/vl/detail/householder.hpp>
#include <zi/vl/detail/jacobi.hpp>
#include <zi/vl/detail/invert.hpp>

namespace zi {
namespace vl {

template< class T, std::size_t N >
inline
mat< T, N >
trans( const mat< T, N >& rhs )
{
    return mat< T, N >( rhs, detail::trans_init_tag() );
}

template< class T, std::size_t N >
inline
void
transpose( mat< T, N >& rhs )
{
    for ( std::size_t i = 0; i < N; ++i )
    {
        for ( std::size_t j = i+1; j < N; ++j )
        {
            std::swap( rhs.at( i, j ), rhs.at( j, i ) );
        }
    }
}

template< class T, std::size_t N >
inline
mat< T, N-1 >
getminor
( const mat< T, N >&m, std::size_t r, std::size_t c )
{
    return mat< T, N-1 >( m, r, c, detail::minor_init_tag() );
}

template< class T, std::size_t N >
inline
mat< T, N-1 >
get_minor
( const mat< T, N >&m, std::size_t r, std::size_t c )
{
    return mat< T, N-1 >( m, r, c, detail::minor_init_tag() );
}

template< class T >
inline
typename detail::promote< T >::type
trace( const mat< T, 1 >& rhs )
{
    return static_cast< typename detail::promote< T >::type >( rhs.elem( 0 ) );
}

template< class T, std::size_t N >
inline
typename detail::promote< T >::type
trace( const mat< T, N >& rhs )
{
    typename detail::promote< T >::type res =
        static_cast< typename detail::promote< T >::type >( 1 );
    for ( std::size_t i = 0; i < mat< T, N >::num_elements; i += N + 1 )
    {
        res *= rhs.elem( i );
    }
    return res;
}

template< class T >
inline
typename detail::promote< T >::type
det( const mat< T, 1 >& rhs )
{
    return static_cast< typename detail::promote< T >::type >( rhs.elem( 0 ) );
}

template< class T >
inline
typename detail::promote< T >::type
det( const mat< T, 2 >& rhs )
{
    return
        static_cast< typename detail::promote< T >::type >( rhs.elem( 0 ) ) * rhs.elem( 3 ) -
        static_cast< typename detail::promote< T >::type >( rhs.elem( 2 ) ) * rhs.elem( 1 );
}

template< class T >
inline
typename detail::promote< T >::type
det( const mat< T, 3 >& rhs )
{
    typedef typename detail::promote< T >::type promoted_type;
    return
        static_cast< promoted_type >( rhs.elem( 0 ) ) * rhs.elem( 4 ) * rhs.elem( 8 ) -
        static_cast< promoted_type >( rhs.elem( 0 ) ) * rhs.elem( 5 ) * rhs.elem( 7 ) +
        static_cast< promoted_type >( rhs.elem( 1 ) ) * rhs.elem( 5 ) * rhs.elem( 6 ) -
        static_cast< promoted_type >( rhs.elem( 1 ) ) * rhs.elem( 3 ) * rhs.elem( 8 ) +
        static_cast< promoted_type >( rhs.elem( 2 ) ) * rhs.elem( 3 ) * rhs.elem( 7 ) -
        static_cast< promoted_type >( rhs.elem( 2 ) ) * rhs.elem( 4 ) * rhs.elem( 6 );
}

template< class T >
inline
typename detail::promote< T >::type
det( const mat< T, 4 >& rhs )
{
    typedef typename detail::promote< T >::type promoted_type;
    promoted_type m00 = rhs.elem( 0 );
    promoted_type m10 = rhs.elem( 1 );
    promoted_type m20 = rhs.elem( 2 );
    promoted_type m30 = rhs.elem( 3 );
    promoted_type m01 = rhs.elem( 4 );
    promoted_type m11 = rhs.elem( 5 );
    promoted_type m21 = rhs.elem( 6 );
    promoted_type m31 = rhs.elem( 7 );
    promoted_type m02 = rhs.elem( 8 );
    promoted_type m12 = rhs.elem( 9 );
    promoted_type m22 = rhs.elem( 10);
    promoted_type m32 = rhs.elem( 11);
    promoted_type m03 = rhs.elem( 12);
    promoted_type m13 = rhs.elem( 13);
    promoted_type m23 = rhs.elem( 14);
    promoted_type m33 = rhs.elem( 15);

    return
        m03 * m12 * m21 * m30
        - m02 * m13 * m21 * m30
        - m03 * m11 * m22 * m30
        + m01 * m13 * m22 * m30
        + m02 * m11 * m23 * m30
        - m01 * m12 * m23 * m30
        - m03 * m12 * m20 * m31
        + m02 * m13 * m20 * m31
        + m03 * m10 * m22 * m31
        - m00 * m13 * m22 * m31
        - m02 * m10 * m23 * m31
        + m00 * m12 * m23 * m31
        + m03 * m11 * m20 * m32
        - m01 * m13 * m20 * m32
        - m03 * m10 * m21 * m32
        + m00 * m13 * m21 * m32
        + m01 * m10 * m23 * m32
        - m00 * m11 * m23 * m32
        - m02 * m11 * m20 * m33
        + m01 * m12 * m20 * m33
        + m02 * m10 * m21 * m33
        - m00 * m12 * m21 * m33
        - m01 * m10 * m22 * m33
        + m00 * m11 * m22 * m33;
}

template< class T, std::size_t N >
inline
typename detail::enable_if_c< ( N > 4 ), typename detail::promote< T >::type >::type
det( const mat< T, N >& rhs )
{
    mat< typename detail::promote< T >::type, N > tmp( rhs );
    householder_just_R( tmp );
    return trace( tmp );
}

template< class T >
inline
mat< typename detail::promote< T >::type, 1 >
adj( const mat< T, 1 >& rhs )
{
    return mat< typename detail::promote< T >::type, 1 >( rhs.elem( 0 ) );
}

template< class T >
inline
mat< typename detail::promote< T >::type, 2 >
adj( const mat< T, 2 >& rhs )
{
    return mat< typename detail::promote< T >::type, 1 >( rhs.elem( 3 ), -rhs.elem( 1 ),
                        -rhs.elem( 2 ), rhs.elem( 0 ) );
}

template< class T, std::size_t N >
inline
typename detail::enable_if_c< ( N > 2 ), mat< typename detail::promote< T >::type, N > >::type
adj( const mat< T, N >& rhs )
{
    mat< typename detail::promote< T >::type, N > res;

    for ( std::size_t i = 0, r = 0; r < N; ++r )
    {
        for ( std::size_t c = 0; c < N; ++c, ++i )
        {
            res.elem( i ) = det( getminor( rhs, c, r ) );
            if ( ( r + c ) & 1 )
            {
                res.elem( i ) = -res.elem( i );
            }
        }
    }
    return res;
}

template< class T, std::size_t N >
inline
mat< typename detail::promote< T >::type, N >
square( const mat< T, N >& m )
{
    mat< typename detail::promote< T >::type, N > tmp( m );
    return tmp * tmp;
}

template< class T, std::size_t N >
inline
mat< typename detail::promote< T >::type, N >
pow( const mat< T, N >& m, int p )
{
    if ( p < 0 )
    {
        return inv( pow( m, -p ) );
    }

    if ( p == 0 )
    {
        return mat< typename detail::promote< T >::type, N >::eye;
    }

    if ( p == 1 )
    {
        return m;
    }

    if ( p & 1 )
    {
        return pow( m, p - 1 ) * m;
    }

    return square( pow( m, p / 2 ) );

}

template< class T, std::size_t N >
inline mat< typename detail::promote< T >::type, N >
pow( const mat< T, N >& m, typename detail::promote< T >::type p )
{
    typedef typename detail::promote< T >::type promoted_type;

    mat< promoted_type, N > x( m );
    x -= mat< promoted_type, N >::eye;

    //promoted_type max_val = static_cast< promoted_type >( x.absmax() ) * N * 2;

    //x /= max_val;

    promoted_type n         = static_cast< promoted_type >( 1 );
    promoted_type two_n     = n * 2; // = 2
    promoted_type nfact     = n;     // = 1
    promoted_type two_nfact = n * 2; // = 2
    promoted_type four_to_n = n * 4; // = 4

    mat< promoted_type, N > x_to_n( x );

    mat< promoted_type, N > res( mat< promoted_type, N >::eye );

    bool neg = true;

    int xw = 1;

    promoted_type vala = two_nfact /
        ( four_to_n * nfact * nfact * ( static_cast< promoted_type >( 1 ) - two_n ) );

    while ( 1 )
    {

        if ( ( ++xw ) > 40 )
            return res;

        promoted_type bottom =
            four_to_n * nfact * nfact * ( static_cast< promoted_type >( 1 ) - two_n );

        vala /= four_to_n;
        vala /= nfact;
        vala /= nfact;
        vala /= ( static_cast< promoted_type >( 1 ) - two_n );
        vala *= static_cast< promoted_type >( neg ? -1 : 1 ) * two_nfact;

        std::cout << "Iteration: \n  bottom: " << bottom
                  << "\n  two_nfact: " << two_nfact << "\n----------\n" << res << "\n\n";

        if ( std::fabs( bottom ) <= std::numeric_limits< promoted_type >::epsilon()
             || std::isnan( bottom ) )
        {
            return res; //. * ::std::pow( max_val, p );
        }
        else
        {

        }

        //promoted_type top = static_cast< promoted_type >( neg ? -1 : 1 ) * two_nfact;
        //promoted_type invbottom = static_cast< promoted_type >( 1 ) / bottom;

        res += x_to_n * vala ; //top * invbottom;

        n += 1;
        two_n += 2;
        four_to_n *= 4;
        nfact *= n;
        two_nfact *= two_n;

        x_to_n *= x;
    }

    return x;

}


template< class T, std::size_t N >
inline mat< typename detail::promote< T >::type, N >
pow_svd( const mat< T, N >& m, typename detail::promote< T >::type p )
{
    typedef typename detail::promote< T >::type promoted_type;

    mat< promoted_type, N > x( m );
    mat< promoted_type, N > E;
    vec< promoted_type, N > e;

    jacobi_svd( x, e, E );

    for ( std::size_t i = 0; i < N; ++i )
    {
        e.at( i ) = ::std::pow( e.at( i ), p );
    }

    return trans( E ) * make_diag( e ) * E;
}


template< class T, std::size_t N >
inline mat< typename detail::promote< T >::type, N >
sqrt( const mat< T, N >& m )
{
    typedef typename detail::promote< T >::type promoted_type;
    promoted_type p = static_cast< promoted_type >( 1 ) / 2;

    return pow( m, p );
}

template< class T, std::size_t N >
inline mat< T, N >
make_diag( const vec< T, N >& diag )
{
    static detail::eye_init_tag tag;
    return mat< T, N >( diag, detail::eye_init_tag() );
}

template< class T, std::size_t N >
inline mat< T, N >
make_diagonal( const vec< T, N >& diag )
{
    static detail::eye_init_tag tag;
    return mat< T, N >( diag, detail::eye_init_tag() );
}

template< class T, std::size_t N >
inline
typename detail::enable_if_c< N == 4, mat< typename detail::promote< T >::type, 4 > >::type
make_rotation( const vec< T, 3 >& axis, const T& theta )
{
    typedef typename detail::promote< T >::type promoted_type;

    promoted_type sine   = std::sin( theta );
    promoted_type cosine = static_cast< promoted_type >( std::sqrt( sine*sine ) );

    vec< promoted_type, 4 > v( axis, 0 );
    normalize( v );

    vec< promoted_type, 4 > r1( cosine, -v.at( 2 ) * sine, v.at( 1 ) * sine, 0 );
    r1 += v * v.at( 0 ) * ( static_cast< promoted_type >( 1 ) - cosine );

    vec< promoted_type, 4 > r2( v.at( 2 ) * sine, cosine, -v.at( 0 ) * sine, 0);
    r2 += v * v.at( 1 ) * ( static_cast< promoted_type >( 1 ) - cosine );

    vec< promoted_type, 4 > r3( -v.at( 1 ) * sine, v.at(  0 ) * sine, cosine, 0 );
    r3 += v * v.at( 2 ) * ( static_cast< promoted_type >( 1 ) - cosine );

    mat< promoted_type, 4 > res( 0 );

    res.template set_row< 0 >( r1 );
    res.template set_row< 1 >( r2 );
    res.template set_row< 2 >( r3 );

    res.elem( 15 ) = 1;

    return res;
}


template< class T, std::size_t N >
inline
typename detail::enable_if_c< N == 4, mat< typename detail::promote< T >::type, 4 > >::type
make_scale( const T& scalex, const T& scaley, const T& scalez )
{
    typedef typename detail::promote< T >::type promoted_type;
    mat< T, 4 > res( 0 );

    res.at( 0, 0 ) = scalex;
    res.at( 1, 1 ) = scaley;
    res.at( 2, 2 ) = scalez;
    return res;
}


template< class T, std::size_t N >
inline
typename detail::enable_if_c< N == 4, mat< typename detail::promote< T >::type, 4 > >::type
make_scale( const vec< T, 3 >& x )
{
    typedef typename detail::promote< T >::type promoted_type;
    mat< T, 4 > res( 0 );

    res.at( 0, 0 ) = x.at( 0 );
    res.at( 1, 1 ) = x.at( 1 );
    res.at( 2, 2 ) = x.at( 2 );
    return res;
}


#define ZI_VL_OUTER_PRODUCT_IMPL( name )                                \
                                                                        \
    template< class T, class O, std::size_t N >                         \
    inline                                                              \
    mat< typename detail::promote< T, O >::type, N >                    \
    name ( const vec< T, N >& v1, const vec< O, N >& v2 )               \
    {                                                                   \
        typedef typename detail::promote< T, O >::type promoted_type;   \
        mat< promoted_type, N > res;                                    \
                                                                        \
        for ( std::size_t i = 0; i < N; ++i )                           \
        {                                                               \
            for ( std::size_t j = 0; j < N; ++j )                       \
            {                                                           \
                res.at( i, j ) = static_cast< promoted_type >           \
                    ( v1.at( i ) ) * v2.at( j );                        \
            }                                                           \
        }                                                               \
        return res;                                                     \
    }                                                                   \
                                                                        \
    template< class T, std::size_t N >                                  \
    inline                                                              \
    mat< T, N >                                                         \
    name ( const vec< T, N >& v1, const vec< T, N >& v2 )               \
    {                                                                   \
        mat< T, N > res;                                                \
                                                                        \
        for ( std::size_t i = 0; i < N; ++i )                           \
        {                                                               \
            for ( std::size_t j = 0; j < N; ++j )                       \
            {                                                           \
                res.at( i, j ) = v1.at( i ) * v2.at( j );               \
            }                                                           \
        }                                                               \
        return res;                                                     \
    }


ZI_VL_OUTER_PRODUCT_IMPL( oprod )
ZI_VL_OUTER_PRODUCT_IMPL( outer_product )

#undef ZI_VL_OUTER_PRODUCT_IMPL

} // namespace vl
} // namespace zi

#endif
